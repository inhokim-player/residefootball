@echo off
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0start_server_stack.bat" Full
@echo off
chcp 65001 >nul
cd /d "%~dp0"

python -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo requirements 설치 실패
  pause
  exit /b 1
)

echo [1/3] 전세계 U25 전체 수집 시작 (오래 걸릴 수 있음)
python global_u25_harvest.py --season 2025 --delay 0.25
if errorlevel 1 (
  echo 전세계 수집 실패
  pause
  exit /b 1
)

echo [2/3] 통계 스코어/적응확률 계산
python u25_pipeline.py --once --mode global --season 2025
if errorlevel 1 (
  echo 스코어 계산 실패
  pause
  exit /b 1
)

echo [3/3] API 서버 시작 (http://127.0.0.1:8010)
python -m uvicorn u25_api:app --host 127.0.0.1 --port 8010
