@echo off
title JuiceVault - Sync Songs
color 0E

echo.
echo  ========================================
echo   JuiceVault - FULL Song Sync
echo  ========================================
echo.
echo  This fetches FULL song details including
echo  lyrics, file paths, cover art, and aliases.
echo.
echo  1 = Quick test - 50 songs
echo  2 = Medium - 500 songs
echo  3 = FULL catalog - ALL songs
echo.

set /p choice="Pick 1, 2, or 3: "

cd /d "%~dp0packages\backend"

if "%choice%"=="1" goto QUICK
if "%choice%"=="2" goto MEDIUM
if "%choice%"=="3" goto FULL
goto QUICK

:QUICK
echo.
echo  Quick sync - 50 songs with full details...
call npx tsx src/jobs/sync-catalog.ts --max-songs=50 --workers=5
goto DONE

:MEDIUM
echo.
echo  Medium sync - 500 songs with full details...
call npx tsx src/jobs/sync-catalog.ts --max-songs=500 --workers=10
goto DONE

:FULL
echo.
echo  FULL catalog sync - all songs with full details...
call npx tsx src/jobs/sync-catalog.ts --workers=10
goto DONE

:DONE
echo.
echo  Done!
echo.
pause
