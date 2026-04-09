# Creates Sonara.lnk in the project folder with the app icon.
# Run once: right-click → "Run with PowerShell"

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$pngPath = Join-Path $root "assets\icon.png"
$icoPath = Join-Path $root "assets\icon.ico"
$batPath = Join-Path $root "run.bat"
$lnkPath = Join-Path $root "Sonara.lnk"

# ── Convert icon.png → icon.ico using System.Drawing ──────────
Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::FromFile($pngPath)

# Resize to 256×256 if needed
$size  = [System.Drawing.Size]::new(256, 256)
$thumb = $bmp.GetThumbnailImage(256, 256, $null, [System.IntPtr]::Zero)

$ms = New-Object System.IO.MemoryStream
$thumb.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()
$ms.Dispose()

# Write minimal ICO file (one 256×256 PNG entry)
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICO header
$bw.Write([uint16]0)      # reserved
$bw.Write([uint16]1)      # type: icon
$bw.Write([uint16]1)      # count: 1 image

# Directory entry (16 bytes)
$bw.Write([byte]0)        # width  0 = 256
$bw.Write([byte]0)        # height 0 = 256
$bw.Write([byte]0)        # color count
$bw.Write([byte]0)        # reserved
$bw.Write([uint16]1)      # color planes
$bw.Write([uint16]32)     # bits per pixel
$bw.Write([uint32]$pngBytes.Length)
$bw.Write([uint32]22)     # offset to image data (6 header + 16 dir)

# PNG image data
$bw.Write($pngBytes)
$bw.Flush()
$fs.Close()

$bmp.Dispose()
$thumb.Dispose()
Write-Host "icon.ico created at $icoPath"

# ── Create the shortcut ────────────────────────────────────────
$shell   = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath       = $batPath
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle      = 1
$shortcut.IconLocation     = "$icoPath,0"
$shortcut.Description      = "Launch Sonara Audiobook Player"
$shortcut.Save()

Write-Host "Shortcut created: $lnkPath"
Write-Host "Done! Double-click Sonara.lnk to launch the app."
