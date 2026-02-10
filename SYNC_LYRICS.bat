@echo off
title JuiceVault - Lyrics Sync (AssemblyAI)
color 0D
echo.
echo  ╔═══════════════════════════════════════════════════╗
echo  ║     🎤 JuiceVault Lyrics Sync                    ║
echo  ║     AssemblyAI Free Tier (185 hours)              ║
echo  ╚═══════════════════════════════════════════════════╝
echo.
echo  1 = Dry run (see what would be processed)
echo  2 = Test (process 1 song to verify)
echo  3 = Small batch (50 songs)
echo  4 = FULL sync (all songs)
echo  5 = Force re-sync all (overwrite existing)
echo.

set /p choice="Pick 1-5: "

cd /d "%~dp0packages\backend"

if "%choice%"=="1" goto DRYRUN
if "%choice%"=="2" goto TEST
if "%choice%"=="3" goto SMALL
if "%choice%"=="4" goto FULL
if "%choice%"=="5" goto FORCE
goto DRYRUN

:DRYRUN
echo.
echo  Scanning catalog (no changes will be made)...
echo.
call npx tsx src/jobs/sync-lyrics.ts --dry-run
goto DONE

:TEST
echo.
echo  Processing 1 song to test everything works...
echo.
call npx tsx src/jobs/sync-lyrics.ts --test
goto DONE

:SMALL
echo.
echo  Processing up to 50 songs...
echo.
call npx tsx src/jobs/sync-lyrics.ts --max-songs=50 --workers=3
goto DONE

:FULL
echo.
echo  Processing ALL songs with lyrics...
echo  This may take 15-30 minutes depending on catalog size.
echo.
call npx tsx src/jobs/sync-lyrics.ts --workers=3
goto DONE

:FORCE
echo.
echo  Force re-syncing ALL songs (overwrites existing timed lyrics)...
echo.
call npx tsx src/jobs/sync-lyrics.ts --workers=3 --force
goto DONE

:DONE
echo.
echo  Press any key to close.
pause >nul
