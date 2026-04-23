@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TASK_NAME=U25_RESIDE_DailyPipeline_10am"
echo.
echo  RESIDE 전체 자동: API + 스케줄러(automation_config 10:00 KST) + 라이브피드(API-Football 키 필요)
echo  각각 별도 PowerShell 창이 뜹니다. 이 배치는 start_server_stack.bat Full 과 같습니다.
echo  중복 방지: Windows 10시 단발 작업(%TASK_NAME%)이 있으면 비활성화합니다.
echo.
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if not errorlevel 1 (
  schtasks /Change /TN "%TASK_NAME%" /DISABLE >nul 2>&1
)
call "%~dp0start_server_stack.bat" Full
