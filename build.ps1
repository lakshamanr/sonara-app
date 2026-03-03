# ============================================================
#  Sonara — Build & Run Script (PowerShell)
#  Usage:
#    .\build.ps1            # Build installer + portable
#    .\build.ps1 -Run       # Build then launch portable
#    .\build.ps1 -Dev       # Just run in dev mode (no build)
#    .\build.ps1 -Clean     # Clean dist folder then build
# ============================================================
param(
    [switch]$Run,
    [switch]$Dev,
    [switch]$Clean
)

$ProjectDir = "$PSScriptRoot\sonara-app"
$DistDir    = "$ProjectDir\dist"

# Colour helpers
function Info  { param($m) Write-Host "[INFO]  $m" -ForegroundColor Cyan }
function Ok    { param($m) Write-Host "[OK]    $m" -ForegroundColor Green }
function Err   { param($m) Write-Host "[ERROR] $m" -ForegroundColor Red }
function Warn  { param($m) Write-Host "[WARN]  $m" -ForegroundColor Yellow }

# ── Validate project dir ─────────────────────────────────────
if (-not (Test-Path "$ProjectDir\package.json")) {
    Err "Could not find sonara-app\package.json. Run this script from the repo root."
    exit 1
}

Set-Location $ProjectDir

# ── Dev mode ─────────────────────────────────────────────────
if ($Dev) {
    Info "Starting Sonara in development mode..."
    npm start
    exit 0
}

# ── Clean ────────────────────────────────────────────────────
if ($Clean -and (Test-Path $DistDir)) {
    Info "Cleaning dist folder..."
    Remove-Item -Recurse -Force $DistDir
    Ok "dist cleaned."
}

# ── Install deps if node_modules missing ─────────────────────
if (-not (Test-Path "$ProjectDir\node_modules")) {
    Info "node_modules not found — running npm install..."
    npm install
    if ($LASTEXITCODE -ne 0) { Err "npm install failed."; exit 1 }
    Ok "Dependencies installed."
}

# ── Build ────────────────────────────────────────────────────
Info "Building Sonara v2.0.0 for Windows (x64)..."
npm run build:win

if ($LASTEXITCODE -ne 0) {
    Err "Build failed. Check output above."
    exit 1
}

Ok "Build complete. Output in: $DistDir"

# List produced files
Write-Host ""
Write-Host "  Artifacts:" -ForegroundColor White
Get-ChildItem $DistDir -File | Where-Object { $_.Extension -in ".exe",".blockmap" } | ForEach-Object {
    $size = "{0:N1} MB" -f ($_.Length / 1MB)
    Write-Host "    $($_.Name)  ($size)" -ForegroundColor Gray
}
Write-Host ""

# ── Launch ───────────────────────────────────────────────────
if ($Run) {
    $portable = Get-ChildItem $DistDir -Filter "*Portable*.exe" | Select-Object -First 1
    if ($portable) {
        Info "Launching $($portable.Name)..."
        Start-Process $portable.FullName
        Ok "Sonara launched."
    } else {
        Warn "Portable executable not found in dist\. Run the installer manually."
    }
}
