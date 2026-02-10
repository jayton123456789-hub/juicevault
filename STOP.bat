@echo off
title JuiceVault - Shutdown
color 0C

echo.
echo  ========================================
echo   🧃 JuiceVault - Shutting Down
echo  ========================================
echo.

cd /d "%~dp0"

echo  Stopping databases...
docker compose down
echo.
echo  ✅ JuiceVault is fully stopped.
echo.
pause
