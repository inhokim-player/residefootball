@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 수동 실행용: 끝에 pause. py 없으면 python 사용.
where py >nul 2>&1
if errorlevel 1 (
  python -m pip install -q -r requirements.txt >nul 2>&1
  python u25_pipeline.py --once --season 2025 --harvest-delay 0.25 --bio-backfill-limit 1500 --bio-backfill-delay 0.15
) else (
  py -m pip install -q -r requirements.txt >nul 2>&1
  py u25_pipeline.py --once --season 2025 --harvest-delay 0.25 --bio-backfill-limit 1500 --bio-backfill-delay 0.15
)
echo ERRORLEVEL=%ERRORLEVEL%
pause
