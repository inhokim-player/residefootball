@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ============================================
echo   U25 배포 전 최종 점검 (보안 + 자동화 + 키)
echo ============================================
echo.
python "%~dp0scripts\predeploy_check.py"
echo.
if errorlevel 1 (
  echo [중요] FAIL 항목을 먼저 수정한 뒤 배포하세요.
) else (
  echo [완료] 치명 FAIL 없음. WARN 항목만 검토 후 배포하세요.
)
echo.
pause
