@echo off
chcp 65001 >nul
setlocal
set "PYTHONUTF8=1"
cd /d "%~dp0.."
echo == 1) 설치: Python + venv + 의존성  (runner 폴더 기준) ==
echo.

REM --- Python 확인 / 없으면 자동 설치 ---
set "PYEXE="
where python >nul 2>&1 && set "PYEXE=python"
if not defined PYEXE ( where py >nul 2>&1 && set "PYEXE=py" )

if not defined PYEXE (
    echo Python 이 없어 자동 설치합니다...
    where winget >nul 2>&1
    if not errorlevel 1 (
        winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
    ) else (
        powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.4/python-3.12.4-amd64.exe' -OutFile \"$env:TEMP\python-setup.exe\""
        if not exist "%TEMP%\python-setup.exe" ( echo [오류] 다운로드 실패. 인터넷/방화벽 확인. & pause & exit /b 1 )
        "%TEMP%\python-setup.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0
    )
    REM 설치 직후엔 현재 창 PATH 갱신 안 됨 → 설치 경로에서 직접 탐색
    for /f "delims=" %%p in ('dir /b /s "%LOCALAPPDATA%\Programs\Python\python.exe" 2^>nul') do set "PYEXE=%%p"
    if not defined PYEXE ( for /f "delims=" %%p in ('dir /b /s "%ProgramFiles%\Python*\python.exe" 2^>nul') do set "PYEXE=%%p" )
    if not defined PYEXE ( echo. & echo 설치 완료. 이 창을 닫고 1_setup.bat 을 한 번 더 실행하세요. & pause & exit /b 0 )
)
for /f "delims=" %%v in ('"%PYEXE%" --version') do echo Python: %%v

REM --- 가상환경 + 의존성 ---
if not exist ".venv\Scripts\python.exe" (
    "%PYEXE%" -m venv .venv
    if errorlevel 1 ( echo [오류] venv 생성 실패 & pause & exit /b 1 )
)
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\pip" install -r requirements.txt
if errorlevel 1 ( echo [오류] 의존성 설치 실패 & pause & exit /b 1 )

REM --- .env / 인증키 ---
if not exist ".env" copy .env.example .env >nul
if not exist "service_account.json" (
    echo.
    echo [주의] service_account.json 이 없습니다. runner 폴더에 넣고
    echo        대상 구글시트를 그 계정 이메일과 "편집자" 로 공유하세요.
)

REM --- 로직 점검 ---
".venv\Scripts\python.exe" track.py --test
if errorlevel 1 ( echo [오류] 점검 실패 & pause & exit /b 1 )

echo.
echo -------- 설치 완료 --------
echo   다음: 2_run.bat (수집 테스트) / 3_schedule.bat (매일 09:00 자동)
echo.
pause
