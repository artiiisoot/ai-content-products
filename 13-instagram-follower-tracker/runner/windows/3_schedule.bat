@echo off
chcp 65001 >nul
REM 매일 09:00 자동 수집 등록. 우클릭 → "관리자 권한으로 실행" 권장.
setlocal
set "TASKNAME=IG Follower Tracker"
schtasks /create /tn "%TASKNAME%" /tr "\"%~dp0_silent.bat\"" /sc daily /st 09:00 /f
if errorlevel 1 (
    echo.
    echo [실패] 관리자 권한으로 다시 실행하세요.
) else (
    echo.
    echo [완료] 매일 09:00 자동 수집 등록됨.
    echo   확인:     schtasks /query  /tn "%TASKNAME%"
    echo   즉시테스트: schtasks /run    /tn "%TASKNAME%"
    echo   해제:     schtasks /delete /tn "%TASKNAME%" /f
)
echo.
pause
