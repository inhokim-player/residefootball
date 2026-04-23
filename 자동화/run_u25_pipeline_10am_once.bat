@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 작업 스케줄러용: pause 없음. 한국 10시에 맞추려면 Windows 시간대를 Asia/Seoul 로 두고 /ST 10:00 로 등록하세요.
where py >nul 2>&1
if errorlevel 1 (
  python -m pip install -q -r requirements.txt >nul 2>&1
  python u25_pipeline.py --once --season 2025 --harvest-delay 0.25 --bio-backfill-limit 1500 --bio-backfill-delay 0.15
) else (
  py -m pip install -q -r requirements.txt >nul 2>&1
  py u25_pipeline.py --once --season 2025 --harvest-delay 0.25 --bio-backfill-limit 1500 --bio-backfill-delay 0.15
)
exit /b %ERRORLEVEL%
