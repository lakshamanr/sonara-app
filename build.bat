@echo off
:: ============================================================
::  Sonara — Build Script (Batch)
::  Double-click to build, or pass arguments:
::    build.bat           — Build installer + portable
::    build.bat run       — Build then launch portable
::    build.bat dev       — Run in dev mode (no build)
::    build.bat clean     — Clean dist then build
:: ============================================================

setlocal
set "PROJECT_DIR=%~dp0sonara-app"
set "DIST_DIR=%PROJECT_DIR%\dist"

:: Check project exists
if not exist "%PROJECT_DIR%\package.json" (
    echo [ERROR] Cannot find sonara-app\package.json
    echo         Run this script from the repo root.
    pause & exit /b 1
)

cd /d "%PROJECT_DIR%"

:: ── Dev mode ─────────────────────────────────────────────────
if /i "%1"=="dev" (
    echo [INFO] Starting Sonara in development mode...
    npm start
    exit /b 0
)

:: ── Clean ────────────────────────────────────────────────────
if /i "%1"=="clean" (
    if exist "%DIST_DIR%" (
        echo [INFO] Cleaning dist folder...
        rmdir /s /q "%DIST_DIR%"
        echo [OK]   dist cleaned.
    )
)

:: ── Install deps if missing ───────────────────────────────────
if not exist "%PROJECT_DIR%\node_modules" (
    echo [INFO] node_modules not found - running npm install...
    npm install
    if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
    echo [OK]   Dependencies installed.
)

:: ── Build ────────────────────────────────────────────────────
echo [INFO] Building Sonara v2.0.0 for Windows x64...
npm run build:win

if errorlevel 1 (
    echo [ERROR] Build failed. See output above.
    pause & exit /b 1
)

echo [OK]   Build complete. Output in: %DIST_DIR%
echo.
echo   Artifacts:
dir /b "%DIST_DIR%\*.exe" 2>nul
echo.

:: ── Launch ───────────────────────────────────────────────────
if /i "%1"=="run" (
    for %%F in ("%DIST_DIR%\*Portable*.exe") do (
        echo [INFO] Launching %%~nxF ...
        start "" "%%F"
        echo [OK]   Sonara launched.
        goto :done
    )
    echo [WARN] Portable exe not found. Run the installer manually.
)

:done
echo.
echo Done.
if /i not "%1"=="run" pause
