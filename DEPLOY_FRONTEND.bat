@echo off
title JuiceVault - Deploy New Frontend
color 0B

echo.
echo  ========================================
echo   JuiceVault - Deploy New Frontend
echo  ========================================
echo.
echo  This script copies the new index.html to
echo  the backend public folder.
echo.
echo  INSTRUCTIONS:
echo  1. Download index.html from Claude chat
echo  2. Save it to your Downloads folder
echo  3. Run this script
echo.

set "SOURCE=%USERPROFILE%\Downloads\index.html"
set "DEST=%~dp0packages\backend\public\index.html"

if exist "%SOURCE%" (
    echo  Found: %SOURCE%
    echo  Deploying to: %DEST%
    echo.
    copy /Y "%SOURCE%" "%DEST%" >nul
    echo  [SUCCESS] Frontend deployed!
    echo.
    echo  Now run START.bat to launch JuiceVault.
) else (
    echo  [ERROR] index.html not found in Downloads!
    echo.
    echo  Please download index.html from the Claude
    echo  chat and save it to:
    echo    %USERPROFILE%\Downloads\index.html
    echo.
    echo  Then run this script again.
)

echo.
pause
