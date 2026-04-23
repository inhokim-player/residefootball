@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ========================================
echo   U25 API  (재부팅 후에도 이 파일 하나만 실행하세요)
echo   - 8010 포트에 이미 떠 있는 서버가 있으면 끄고 다시 뜹니다.
echo   - 브라우저 첫 페이지는 index.html 로 자동 실행됩니다.
echo ========================================
echo.

start "" "%~dp0index.html"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_u25_api.ps1" %*
echo.
pause
