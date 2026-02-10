@echo off
title JuiceVault - Diagnostic
color 0B
cd /d "%~dp0packages\backend"
echo.
echo  Running diagnostic...
echo.
call npx tsx src/jobs/diagnostic.ts
echo.
pause
