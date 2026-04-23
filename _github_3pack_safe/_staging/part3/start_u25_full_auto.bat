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
  echo requirements 설치 실패
  pause
  exit /b 1
)

if "%U25_API_TOKEN%"=="" (
  echo [보안 경고] U25_API_TOKEN 환경변수가 비어 있습니다.
  echo [보안 경고] API 무단 호출 방지를 위해 .env 또는 시스템 환경변수에 U25_API_TOKEN 설정을 권장합니다.
)

echo [자동화] data/automation_config.json 설정으로 3개 창을 시작합니다.
py run_automation_stack.py
if errorlevel 1 (
  echo run_automation_stack.py 실행 실패
  pause
  exit /b 1
)

echo [감시] API /health 연속 실패 시 스택 자동 재기동 (백그라운드)
start "U25 Stack Supervisor" cmd /k "cd /d %~dp0 && py u25_stack_supervisor.py"

echo 자동화 시작 완료. 브라우저에서 site/index.html 새로고침하세요.
echo 로그온 자동 시작: register_u25_logon.bat (최초 1회)
