@echo off
setlocal
cd /d "%~dp0"

echo Starting Sonara...
call node_modules\.bin\electron.cmd . %*

if errorlevel 1 (
  echo.
  echo Sonara exited with an error ^(code %errorlevel%^).
  pause
)

endlocal
