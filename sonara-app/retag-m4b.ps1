param([string]$BooksDir = "", [int]$Threads = 10)

$ffmpeg = "C:\Lakshaman\code\sonara-app\sonara-app\sonara-app\node_modules\ffmpeg-static\ffmpeg.exe"
if (-not (Test-Path $ffmpeg)) {
    $found = Get-Command ffmpeg -ErrorAction SilentlyContinue
    $ffmpeg = if ($found) { $found.Source } else { $null }
}
if (-not $ffmpeg -or -not (Test-Path $ffmpeg)) {
    Write-Host "ERROR: ffmpeg.exe not found." -ForegroundColor Red
    Read-Host "Press Enter to close"; exit 1
}
if (-not $BooksDir) { $BooksDir = Join-Path $env:APPDATA "Sonara\Sonara-Data\books" }
if (-not (Test-Path $BooksDir)) {
    Write-Host "ERROR: Books folder not found: $BooksDir" -ForegroundColor Red
    Read-Host "Press Enter to close"; exit 1
}

# Output folder for successfully retagged files
$doneDir = Join-Path $BooksDir "converted"
if (-not (Test-Path $doneDir)) { New-Item -ItemType Directory -Path $doneDir | Out-Null }

# Collect files — skip .retag.tmp leftovers AND files already in converted/
$files = Get-ChildItem -LiteralPath $BooksDir -Filter "*.m4b" |
         Where-Object { $_.Name -notlike "*.retag.tmp.m4b" }

# De-duplicate: skip any file whose name already exists in converted/
$files = $files | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $doneDir $_.Name))
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Sonara M4B Retagger  (parallel x$Threads)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  FFmpeg    : $ffmpeg"
Write-Host "  Books dir : $BooksDir"
Write-Host "  Converted : $doneDir"
Write-Host ""
Write-Host "Found $($files.Count) file(s) to process" -ForegroundColor Yellow
Write-Host ""

if ($files.Count -eq 0) {
    Write-Host "Nothing to retag (all already in converted/ folder)."
    Read-Host "Press Enter to close"; exit 0
}

# Thread-safe counters using a synchronized hashtable
$counters = [hashtable]::Synchronized(@{ ok = 0; failed = 0 })
$lock     = [System.Object]::new()

# Run parallel jobs — each file gets its own runspace slot
$jobs = $files | ForEach-Object {
    $f = $_
    [PSCustomObject]@{
        File      = $f
        Job       = $null
        Runspace  = $null
    }
}

$pool = [RunspaceFactory]::CreateRunspacePool(1, $Threads)
$pool.Open()

$running = @()
foreach ($item in $jobs) {
    $f      = $item.File
    $src    = $f.FullName
    $tmp    = $src + ".retag.tmp.m4b"
    $title  = $f.BaseName
    $dest   = Join-Path $doneDir $f.Name

    $ps = [PowerShell]::Create()
    $ps.RunspacePool = $pool

    [void]$ps.AddScript({
        param($ffmpeg, $src, $tmp, $dest, $title, $lock, $counters)

        $short = if ($title.Length -gt 55) { $title.Substring(0,55) + "..." } else { $title }

        $logFile = $tmp + ".log"

        # Build a single quoted argument string — Start-Process with an array
        # does NOT quote paths containing spaces, causing ffmpeg to truncate them.
        $argStr = "-y -i `"$src`" -c:a aac -b:a 128k -c:v copy -map 0:a " +
                  "-map_metadata 0 " +
                  "-metadata `"title=$title`" " +
                  "-metadata `"artist=Lakshaman`" " +
                  "-metadata `"album=$title`" " +
                  "-metadata `"album_artist=Lakshaman`" " +
                  "-metadata `"genre=Audiobook`" " +
                  "-f mp4 `"$tmp`""

        $proc = Start-Process -FilePath $ffmpeg -ArgumentList $argStr `
                              -Wait -PassThru -NoNewWindow `
                              -RedirectStandardError $logFile

        if ($proc.ExitCode -eq 0 -and (Test-Path -LiteralPath $tmp)) {
            try {
                Move-Item -LiteralPath $tmp -Destination $dest -Force
                [System.Threading.Monitor]::Enter($lock)
                $counters.ok++
                [System.Threading.Monitor]::Exit($lock)
                Write-Output "  [OK]     $short"
            } catch {
                [System.Threading.Monitor]::Enter($lock)
                $counters.failed++
                [System.Threading.Monitor]::Exit($lock)
                if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
                Write-Output "  [FAIL]   $short  (move error: $_)"
            }
        } else {
            $errText = ""
            if (Test-Path $logFile) {
                $errText = (Get-Content $logFile -Tail 2 | Where-Object { $_ -match "Error|error" }) -join " "
            }
            [System.Threading.Monitor]::Enter($lock)
            $counters.failed++
            [System.Threading.Monitor]::Exit($lock)
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
            Write-Output "  [FAILED] $short  ($errText)"
        }
        if (Test-Path $logFile) { Remove-Item $logFile -Force }
    })

    [void]$ps.AddParameters(@{
        ffmpeg   = $ffmpeg
        src      = $src
        tmp      = $tmp
        dest     = $dest
        title    = $title
        lock     = $lock
        counters = $counters
    })

    $running += [PSCustomObject]@{ PS = $ps; Handle = $ps.BeginInvoke() }
}

# Poll until all jobs finish, printing output as it arrives
Write-Host "Running $($running.Count) jobs with $Threads parallel threads..." -ForegroundColor DarkYellow
Write-Host ""

$completed = 0
while ($completed -lt $running.Count) {
    foreach ($r in $running | Where-Object { $_.Handle -ne $null -and $_.Handle.IsCompleted }) {
        $out = $r.PS.EndInvoke($r.Handle)
        $out | ForEach-Object { Write-Host $_ -ForegroundColor $(if ($_ -like "*[OK]*") { "Green" } elseif ($_ -like "*[FAIL*") { "Red" } else { "White" }) }
        $r.PS.Dispose()
        $r.Handle = $null
        $completed++
    }
    if ($completed -lt $running.Count) { Start-Sleep -Milliseconds 500 }
}

$pool.Close()
$pool.Dispose()

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Done - $($counters.ok) converted, $($counters.failed) failed" -ForegroundColor Cyan
Write-Host "  Output: $doneDir" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to close"