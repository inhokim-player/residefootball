@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   U25 Daily Ops Check (보안/자동화/배포상태)
echo ============================================
echo.

python "%~dp0scripts\predeploy_check.py"
if errorlevel 1 (
  echo.
  echo [주의] 보안/설정 FAIL 항목이 있습니다. 먼저 수정하세요.
  echo.
)

echo [스케줄러 점검] U25 예약 작업 대상 파일 존재 여부
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$tasks=Get-ScheduledTask; $rows=@(); foreach($t in $tasks){ foreach($a in $t.Actions){ $exec=($a.Execute -replace '^\"|\"$','').Trim(); if([string]::IsNullOrWhiteSpace($exec)){ continue }; if($t.TaskName -like 'U25ScoutUser-*'){ $status=if(Test-Path -LiteralPath $exec){'exists'}else{'missing'}; $rows+=[pscustomobject]@{Task=$t.TaskName; Target=$exec; Status=$status} } } }; $rows | Sort-Object Task | Format-Table -AutoSize"

echo.
echo [안내] 실서비스 실행은 start_server_stack.bat Full 사용
echo.
pause
