@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
echo ============================================
echo  News Collector Runner - Windows Setup
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Trying to install it automatically via winget...
  echo.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] winget is not available on this PC, so Node.js could not be installed automatically.
    echo Install the LTS version manually from https://nodejs.org, then run this script again.
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] Automatic install via winget failed.
    echo Install the LTS version manually from https://nodejs.org, then run this script again.
    pause
    exit /b 1
  )
  echo.
  echo Node.js was installed. Close this window and double-click 1_setup.bat again
  echo so the new PATH takes effect in a fresh window.
  pause
  exit /b 0
)

for /f "tokens=*" %%v in ('node --version') do echo Node.js version: %%v
echo.

if exist "%~dp0.env" (
  echo .env already exists. Skipping.
  echo    ^(To recreate it, delete .env and run this script again.^)
) else (
  echo Creating .env - enter the values you received from the admin.
  echo.
  set /p WEBAPP_URL="WEBAPP_URL (Apps Script Web App .../exec URL): "
  set /p WEBAPP_TOKEN="WEBAPP_TOKEN (shared token): "
  set /p LITELLM_KEY="LITELLM_KEY (your gateway key): "

  (
    echo WEBAPP_URL=!WEBAPP_URL!
    echo WEBAPP_TOKEN=!WEBAPP_TOKEN!
    echo LITELLM_KEY=!LITELLM_KEY!
  ) > "%~dp0.env"

  echo.
  echo .env created: %~dp0.env
)

echo.
echo Running offline self-check ^(no network needed^)...
node "%~dp0summarize.mjs" selfcheck
echo.
echo ============================================
echo  Setup complete. Double-click 2_run-weekly.bat or 3_run-daily.bat to run.
echo  ^(Must be connected to the company network/VPN when running.^)
echo ============================================
pause
