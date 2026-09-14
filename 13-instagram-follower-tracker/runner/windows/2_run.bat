@echo off
chcp 65001 >nul
setlocal
set "PYTHONUTF8=1"
cd /d "%~dp0.."
REM 수동 1회 수집(그래프 갱신). 인자 그대로 전달: 2_run.bat --dump / --self-check / --test
if exist ".venv\Scripts\python.exe" ( set "PY=.venv\Scripts\python.exe" ) else ( set "PY=python" )
%PY% track.py %*
pause
