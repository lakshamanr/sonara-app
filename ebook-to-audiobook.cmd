@echo off
setlocal
set "APP_DIR=%~dp0sonara-app"
set "ELECTRON=%APP_DIR%\node_modules\.bin\electron.cmd"
set "CLI=%APP_DIR%\main\ebook-to-audiobook.js"

set "INPUT="
set /p "INPUT=Enter the full path to the PDF or EPUB: "
set "INPUT=%INPUT:"=%"
if not exist "%INPUT%" (
  echo File not found: %INPUT%
  pause
  exit /b 2
)

choice /c 12 /n /m "Choose output format: [1] MP3  [2] Apple audiobook M4B: "
if errorlevel 2 (set "FORMAT=m4b") else (set "FORMAT=mp3")

set "VOICE=M1"
set /p "VOICE=Enter local Supertonic voice (M1-M5 or F1-F5) [M1]: "
if not defined VOICE set "VOICE=M1"

choice /c 146 /n /m "Choose quality/speed: [1] Fast (4 steps)  [4] Balanced (6 steps)  [6] Best quality (8 steps): "
if errorlevel 3 (set "STEPS=8") else if errorlevel 2 (set "STEPS=6") else (set "STEPS=4")

echo.
echo Converting...
"%ELECTRON%" "%CLI%" "%INPUT%" --format %FORMAT% --voice %VOICE% --steps %STEPS%
if errorlevel 1 (
  echo.
  echo Conversion failed.
  pause
  exit /b 1
)
echo.
pause
