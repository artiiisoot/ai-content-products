@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0.env" (
  echo [ERROR] .env not found. Run 1_setup.bat first.
  pause
  exit /b 1
)

echo ============================================
echo  Generating weekly content candidates
echo ============================================
echo [NOTE] Do not click the "Generate Now" button in the sheet while this is running.
echo        (weekly has no dedup - running twice at once creates duplicate candidates.)
echo.

node --env-file=.env summarize.mjs weekly
set RC=%errorlevel%

echo.
if %RC%==0 (
  echo Done. Check the weekly content candidates tab in the sheet.
) else (
  echo An error occurred ^(see message above^). Check your VPN connection and .env values.
)
pause
