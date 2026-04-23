@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" cmd /c python "%~dp0live_feed.py"
@echo off
chcp 65001 >nul
cd /d "%~dp0"

py -m ensurepip --upgrade >nul 2>nul
py -m pip install -q -r requirements.txt
if errorlevel 1 (
  exit /b 1
)

py live_feed.py --interval 30 --season 2025
