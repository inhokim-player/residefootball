@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Windows 매일 10:00 로 u25_pipeline --once 를 등록합니다. (로컬 시계 = 한국이면 KST 10시)
echo  관리자 권한 CMD/PowerShell 에서 실행하세요.
echo  주의: Full 모드(RESIDE_전체자동 / RUN_U25_AT_LOGON)와 동시 사용 시 중복 실행될 수 있습니다.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register_daily_pipeline_10am.ps1"
echo.
pause
