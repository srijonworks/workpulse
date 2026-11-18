@echo off
REM ==========================================================================
REM  WorkPulse - one-click local launcher (no Docker)
REM
REM  Usage:
REM    run.bat          Start in development mode (live reload)
REM    run.bat prod     Build optimized bundle, then start in production mode
REM
REM  Optional: set PORT before running to choose a port (default 3000).
REM            set NO_BROWSER=1 to skip opening the browser automatically.
REM ==========================================================================
setlocal EnableExtensions EnableDelayedExpansion
title WorkPulse
cd /d "%~dp0"

set "MODE=dev"
if /i "%~1"=="prod" set "MODE=prod"

echo.
echo  ===========================================
echo    WorkPulse - Daily Work Tracker ^& AI Hub
echo  ===========================================
echo.

REM --- 1. Check Node.js -----------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found on this computer.
    echo         Install Node.js 22 LTS or newer from https://nodejs.org/
    echo         or run:  winget install OpenJS.NodeJS.LTS
    echo         Then close this window and run run.bat again.
    goto :fail
)
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
REM Vite 8 needs Node 20.19+ or 22.12+ (odd releases like 21 are not supported)
set "NODE_BAD=0"
if !NODE_MAJOR! LSS 20 set "NODE_BAD=1"
if !NODE_MAJOR! EQU 20 if !NODE_MINOR! LSS 19 set "NODE_BAD=1"
if !NODE_MAJOR! EQU 21 set "NODE_BAD=1"
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! LSS 12 set "NODE_BAD=1"
if "!NODE_BAD!"=="1" (
    for /f %%v in ('node -v') do echo [ERROR] Node.js %%v is too old. Version 20.19+ or 22.12+ is required.
    echo         Download the latest LTS from https://nodejs.org/
    goto :fail
)
for /f %%v in ('node -v') do echo [OK] Node.js %%v

REM --- 2. Install dependencies (only when missing or package.json changed) --
set "NEED_INSTALL=0"
if not exist "node_modules\" set "NEED_INSTALL=1"
if not exist "node_modules\.workpulse-installed" set "NEED_INSTALL=1"
if "!NEED_INSTALL!"=="0" (
    fc /b "package.json" "node_modules\.workpulse-installed" >nul 2>&1
    if errorlevel 1 set "NEED_INSTALL=1"
)
REM Reinstall when the lockfile changed too (for example after a git pull)
if "!NEED_INSTALL!"=="0" if exist "package-lock.json" (
    if not exist "node_modules\.workpulse-installed-lock" (
        set "NEED_INSTALL=1"
    ) else (
        fc /b "package-lock.json" "node_modules\.workpulse-installed-lock" >nul 2>&1
        if errorlevel 1 set "NEED_INSTALL=1"
    )
)
if "!NEED_INSTALL!"=="1" (
    echo [..] Installing dependencies, this can take a minute the first time...
    call npm install --no-audit --no-fund --loglevel=error
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check your internet connection and try again.
        goto :fail
    )
    copy /y "package.json" "node_modules\.workpulse-installed" >nul
    if exist "package-lock.json" copy /y "package-lock.json" "node_modules\.workpulse-installed-lock" >nul
)
echo [OK] Dependencies installed

REM --- 3. Create local env file on first run ---------------------------------
if not exist ".env.local" if not exist ".env" (
    > ".env.local" (
        echo # WorkPulse local settings
        echo # Optional: put your Gemini API key here to enable AI features.
        echo # Get one at https://aistudio.google.com/apikey
        echo # You can also paste a key inside the app under Settings instead.
        echo # GEMINI_API_KEY=your-key-here
    )
    echo [OK] Created .env.local ^(add your GEMINI_API_KEY there if you want AI features^)
)

REM --- 4. Pick a free port ---------------------------------------------------
if not defined PORT set "PORT=3737"
set /a "PORT_LIMIT=PORT+50"
:checkport
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo [..] Port %PORT% is busy, trying the next one...
    set /a PORT+=1
    if !PORT! GTR !PORT_LIMIT! (
        echo [ERROR] Could not find a free port.
        goto :fail
    )
    goto :checkport
)
echo [OK] Using port %PORT%

REM --- 5. Build for production if requested ----------------------------------
if "%MODE%"=="prod" (
    echo [..] Building production bundle...
    call npx --no-install vite build
    if errorlevel 1 (
        echo [ERROR] Build failed.
        goto :fail
    )
    set "NODE_ENV=production"
) else (
    set "NODE_ENV=development"
)

REM --- 6. Open the browser once the server answers ---------------------------
if not defined NO_BROWSER start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$u='http://localhost:%PORT%'; for($i=0;$i -lt 120;$i++){ try { Invoke-WebRequest -UseBasicParsing ($u+'/api/health') -TimeoutSec 2 | Out-Null; Start-Process $u; break } catch { Start-Sleep -Milliseconds 500 } }"

REM --- 7. Start the server ---------------------------------------------------
echo.
echo  WorkPulse is starting at  http://localhost:%PORT%   (mode: %MODE%)
echo  Your browser will open automatically. Press Ctrl+C to stop the server.
echo.
call npx --no-install tsx server.ts
if errorlevel 1 goto :fail
endlocal
exit /b 0

:fail
echo.
echo WorkPulse did not start. See the messages above.
pause
endlocal
exit /b 1
