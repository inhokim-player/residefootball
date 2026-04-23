@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TASK_NAME=U25_RESIDE_DailyPipeline_10am"
echo.
echo  10시 작업 스케줄러를 활성화합니다: %TASK_NAME%
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if errorlevel 1 (
  echo  작업이 없습니다. 먼저 register_daily_10am_task.bat 를 실행하세요.
  echo.
  pause
  exit /b 1
)
schtasks /Change /TN "%TASK_NAME%" /ENABLE
if errorlevel 1 (
  echo  활성화 실패. 관리자 권한으로 다시 실행하세요.
  echo.
  pause
  exit /b 1
)
echo  완료: %TASK_NAME% 가 활성화되었습니다.
echo.
pause
