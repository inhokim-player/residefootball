@echo off
chcp 65001 >nul
cd /d "%~dp0"
python "%~dp0u25_pipeline.py" run_once --season 2025
@echo off
chcp 65001 >nul
cd /d "%~dp0"

py -m ensurepip --upgrade >nul 2>nul
py -m pip install -q -r requirements.txt
if errorlevel 1 (
  exit /b 1
)

py u25_pipeline.py --once --season 2025 --harvest-delay 0.25 --bio-backfill-limit 1500 --bio-backfill-delay 0.15
