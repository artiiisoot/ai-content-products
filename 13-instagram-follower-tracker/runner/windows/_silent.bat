@echo off
chcp 65001 >nul
REM 작업 스케줄러가 호출하는 무인 실행(창 안 뜸, 로그 누적). 직접 실행 불필요.
setlocal
set "PYTHONUTF8=1"
cd /d "%~dp0.."
if exist ".venv\Scripts\python.exe" ( set "PY=.venv\Scripts\python.exe" ) else ( set "PY=python" )
%PY% track.py >> tracker.log 2>&1
