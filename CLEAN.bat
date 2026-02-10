@echo off
title JuiceVault - Full Reset
color 0E

echo.
echo  ========================================
echo   JuiceVault - FULL RESET
echo   This removes ALL data and starts fresh
echo  ========================================
echo.

cd /d "%~dp0"

echo  [1/3] Stopping containers...
docker compose down 2>nul
echo.

echo  [2/3] Removing Docker volumes (database, redis, search)...
docker volume rm juicevault_pgdata juicevault_redisdata juicevault_typesensedata 2>nul
docker compose down -v 2>nul
echo.

echo  [3/3] Cleanup complete!
echo.
echo  ========================================
echo   All data has been wiped.
echo   Run START.bat to set up fresh.
echo  ========================================
echo.
pause
