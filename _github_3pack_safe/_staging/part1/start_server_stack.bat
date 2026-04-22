@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  U25 서버 스택 (API + 스케줄러 + 라이브피드) — Windows
echo  모드: Full (기본) / Api / Scheduler / LiveFeed
echo  예: start_server_stack.bat Api
echo  공개 바인딩: start_server_stack.bat Full PublicBind
echo.

set MODE=Full
if not "%~1"=="" set MODE=%~1
set BIND_ARG=
if /I "%~2"=="PublicBind" set BIND_ARG=-PublicBind

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\server_stack.ps1" -Mode %MODE% %BIND_ARG%

pause
