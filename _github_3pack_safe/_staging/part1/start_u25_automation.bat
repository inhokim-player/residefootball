@echo off
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0start_server_stack.bat" Scheduler
@echo off
chcp 65001 >nul
cd /d "%~dp0"

python -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo requirements 설치 실패
  pause
  exit /b 1
)

echo U25 자동 스케줄러 시작 (08:00 / 18:00 / 23:00)
python u25_auto_scheduler.py --season 2025 --schedule-times 08:00,18:00,23:00 --poll-interval 30 --harvest-delay 0.25 --bio-backfill-limit 1500 --bio-backfill-delay 0.15
