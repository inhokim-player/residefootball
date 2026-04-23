@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 예전처럼 한 번에: 브라우저 + API(8010). 내용은 start_u25_api.bat 과 동일합니다.
call "%~dp0start_u25_api.bat"
