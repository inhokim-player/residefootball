@echo off
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0start_server_stack.bat" Full
@echo off
chcp 65001 >nul
cd /d "%~dp0"

py -m ensurepip --upgrade >nul 2>nul
py -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo requirements 설치 실패. Python launcher(py) 또는 PATH 확인 필요.
  pause
  exit /b 1
)

echo [1/3] U25 API 서버 먼저 실행
start "U25 API Server" cmd /k "cd /d %~dp0 && py api_watchdog.py"

echo [2/3] U25 자동 스케줄러 실행 (08:00 / 18:00 / 23:00)
start "U25 Auto Scheduler" cmd /k "cd /d %~dp0 && py u25_auto_scheduler.py --season 2025 --schedule-times 08:00,18:00,23:00 --poll-interval 30 --harvest-delay 0.25 --bio-backfill-limit 1500 --bio-backfill-delay 0.15"

echo [3/3] 핵심 리그 일정 피드 실행
start "Key League Schedule Feed" cmd /k "cd /d %~dp0 && py live_feed.py --interval 30 --season 2025"

echo 실행 완료: API는 즉시 열리고 수집/키몸무게/주발 백필은 루프로 계속 최신화됩니다.
