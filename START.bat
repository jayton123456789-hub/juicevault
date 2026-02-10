@echo off
title JuiceVault Launcher
color 0A
setlocal enabledelayedexpansion

echo.
echo  ========================================
echo   JuiceVault - One-Click Launcher
echo  ========================================
echo.

:: ─── CHECK NODE.JS ──────────────────────────────────
echo [1/7] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  Node.js not found. Installing via winget...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    echo.
    echo  Node.js installed. CLOSE this window and run START.bat again.
    pause
    exit /b 0
)
for /f "tokens=*" %%i in ('node --version') do echo  Found Node.js %%i

:: ─── FIND DOCKER CLI ────────────────────────────────
echo.
echo [2/7] Finding Docker...

set "DOCKER_CMD="

:: Check PATH first
where docker >nul 2>&1
if %errorlevel% equ 0 (
    set "DOCKER_CMD=docker"
    goto :got_docker
)

:: Check common locations
set "D1=%ProgramFiles%\Docker\Docker\resources\bin\docker.exe"
set "D2=%ProgramFiles%\Docker\Docker\resources\docker.exe"
set "D3=%LocalAppData%\Docker\wsl\docker.exe"

if exist "!D1!" set "DOCKER_CMD=!D1!" & goto :got_docker
if exist "!D2!" set "DOCKER_CMD=!D2!" & goto :got_docker
if exist "!D3!" set "DOCKER_CMD=!D3!" & goto :got_docker

:: Deep search Program Files
for /f "tokens=*" %%p in ('where /r "%ProgramFiles%\Docker" docker.exe 2^>nul') do (
    set "DOCKER_CMD=%%p"
    goto :got_docker
)

:: Deep search LocalAppData
for /f "tokens=*" %%p in ('where /r "%LocalAppData%\Docker" docker.exe 2^>nul') do (
    set "DOCKER_CMD=%%p"
    goto :got_docker
)

echo  Docker CLI not found anywhere.
echo  Make sure Docker Desktop is installed and open it once.
echo  Then CLOSE this window and run START.bat again.
echo.
echo  Download: https://www.docker.com/products/docker-desktop/
pause
exit /b 1

:got_docker
echo  Found Docker: !DOCKER_CMD!

:: ─── START DOCKER ENGINE ────────────────────────────
echo.
echo [3/7] Checking Docker engine...

"!DOCKER_CMD!" info >nul 2>&1
if %errorlevel% equ 0 goto :engine_running

echo  Docker engine not running. Launching Docker Desktop...

:: Find and launch Docker Desktop
set "DD="
set "DD1=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set "DD2=%LocalAppData%\Programs\Docker\Docker\Docker Desktop.exe"
if exist "!DD1!" set "DD=!DD1!"
if exist "!DD2!" set "DD=!DD2!"

if defined DD (
    start "" "!DD!"
) else (
    echo  Cant find Docker Desktop exe. Open it manually.
    pause
    exit /b 1
)

echo  Waiting for Docker engine (up to 60 sec)...
set /a tries=0

:wait_loop
if !tries! geq 12 (
    echo  Docker took too long. Open Docker Desktop, wait for
    echo  "Engine running", then run START.bat again.
    pause
    exit /b 1
)
timeout /t 5 /nobreak >nul
"!DOCKER_CMD!" info >nul 2>&1
if %errorlevel% equ 0 goto :engine_running
set /a tries+=1
echo  Still waiting... !tries!/12
goto :wait_loop

:engine_running
echo  Docker engine is running

:: ─── START DATABASES ────────────────────────────────
echo.
echo [4/7] Starting databases...
cd /d "%~dp0"
"!DOCKER_CMD!" compose up -d
if %errorlevel% neq 0 (
    echo  Failed to start databases.
    pause
    exit /b 1
)
echo  Databases started - waiting 8 sec...
timeout /t 8 /nobreak >nul

:: ─── INSTALL NPM PACKAGES ──────────────────────────
echo.
echo [5/7] Checking packages...
if not exist "node_modules" (
    echo  First run - installing packages...
    call npm install
    if %errorlevel% neq 0 (
        echo  npm install failed.
        pause
        exit /b 1
    )
) else (
    echo  Packages already installed
)

:: ─── DATABASE SETUP ─────────────────────────────────
echo.
echo [6/7] Setting up database...
cd /d "%~dp0packages\backend"
if not exist ".env" copy .env.example .env >nul

call npx prisma generate >nul 2>&1
call npx prisma migrate dev --name init --skip-generate 2>nul
echo  Database ready

call npx tsx prisma/seed.ts 2>nul
echo  Seeded

:: ─── LAUNCH ─────────────────────────────────────────
echo.
echo [7/7] Starting JuiceVault...
echo.
echo  ========================================
echo   API:     http://localhost:4000/api
echo   Health:  http://localhost:4000/api/health
echo.
echo   Admin:   admin@juicevault.app / admin123
echo   Invites: JUICE999, VAULT2026, WRLD999
echo.
echo   Ctrl+C to stop.
echo  ========================================
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:4000/api/health"
call npx tsx src/index.ts
