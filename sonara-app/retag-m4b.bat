@echo off
setlocal enabledelayedexpansion

:: --------------------------------------------------------------
::  retag-m4b.bat  —  Re-encode all Sonara M4B files to 128k AAC
::  with full Apple Books / iPhone compatible metadata.
::
::  Run this from anywhere — double-click or:
::    retag-m4b.bat
::
::  Optionally pass a custom books folder:
::    retag-m4b.bat "D:\MyBooks"
:: --------------------------------------------------------------

:: -- FFmpeg path (bundled with Sonara dev install) -------------
set "FFMPEG=C:\Lakshaman\code\sonara-app\sonara-app\sonara-app\node_modules\ffmpeg-static\ffmpeg.exe"

:: -- Fallback: look for ffmpeg in PATH -------------------------
if not exist "%FFMPEG%" (
  where ffmpeg >nul 2>&1
  if !errorlevel! == 0 (
    set "FFMPEG=ffmpeg"
  ) else (
    echo ERROR: ffmpeg.exe not found at:
    echo   %FFMPEG%
    echo.
    echo Install ffmpeg or update the FFMPEG path in this script.
    pause
    exit /b 1
  )
)

:: -- Books folder ----------------------------------------------
if "%~1"=="" (
  set "BOOKS_DIR=C:\Users\lakshamanr\AppData\Roaming\sonara\Sonara-Data\books"
) else (
  set "BOOKS_DIR=%~1"
)

if not exist "%BOOKS_DIR%" (
  echo ERROR: Books directory not found:
  echo   %BOOKS_DIR%
  pause
  exit /b 1
)

echo.
echo ------------------------------------------
echo   Sonara M4B Retagger
echo ------------------------------------------
echo   FFmpeg   : %FFMPEG%
echo   Books dir: %BOOKS_DIR%
echo ------------------------------------------
echo.

set /a OK=0
set /a SKIPPED=0
set /a FAILED=0

for %%F in ("%BOOKS_DIR%\*.m4b") do (
  set "SRC=%%~F"
  set "TMP=%%~dpnF.retag.tmp.m4b"
  set "TITLE=%%~nF"

  echo Processing: %%~nxF

  :: Read existing title tag using ffprobe-style ffmpeg probe
  :: Use the filename as title fallback (strip extension)

  "%FFMPEG%" -y ^
    -i "%%~F" ^
    -c:a aac -b:a 128k ^
    -c:v copy ^
    -map 0:a ^
    -map_metadata 0 ^
    -metadata title="!TITLE!" ^
    -metadata artist="Lakshaman" ^
    -metadata album="!TITLE!" ^
    -metadata album_artist="Lakshaman" ^
    -metadata genre="Audiobook" ^
    -f mp4 "!TMP!" ^
    2>nul

  if exist "!TMP!" (
    del "!SRC!" 2>nul
    ren "!TMP!" "%%~nxF"
    echo   OK
    set /a OK+=1
  ) else (
    echo   FAILED
    set /a FAILED+=1
  )
  echo.
)

echo ------------------------------------------
echo   Done — %OK% retagged,  %FAILED% failed
echo ------------------------------------------
echo.
pause
