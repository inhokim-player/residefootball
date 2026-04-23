@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "%~dp0..\deploy.bat" (
  echo deploy.bat 을 찾을 수 없습니다. 이 파일은 my website\_github_3pack_safe 안에 있어야 합니다.
  pause
  exit /b 1
)
call "%~dp0..\deploy.bat"
