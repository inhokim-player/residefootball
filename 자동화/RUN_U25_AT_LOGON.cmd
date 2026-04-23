@echo off
REM 로그온 시 전체 스택(API+스케줄+라이브). 작업 스케줄러에 이 파일을 등록하면 재부팅 후에도 자동 기동 가능.
cd /d "%~dp0"
set "TASK_NAME=U25_RESIDE_DailyPipeline_10am"
REM Full 스택의 내부 스케줄러와 중복되지 않게 10시 단발 작업은 비활성화
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if not errorlevel 1 (
  schtasks /Change /TN "%TASK_NAME%" /DISABLE >nul 2>&1
)
call "%~dp0start_server_stack.bat" Full
