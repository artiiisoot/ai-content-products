@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0.env" (
  echo [ERROR] .env not found. Run 1_setup.bat first.
  pause
  exit /b 1
)

echo ============================================
echo  Generating daily summary (today's collected articles)
echo ============================================
echo.

node --env-file=.env summarize.mjs daily
set RC=%errorlevel%

echo.
if %RC%==0 (
  echo Done. Check the daily summary tab in the sheet.
) else (
  echo An error occurred ^(see message above^). Check your VPN connection and .env values.
)
pause
