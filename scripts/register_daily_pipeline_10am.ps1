#Requires -Version 5.1
<#
  Windows 작업 스케줄러에 "매일 10:00 (로컬 시계)" 로 u25_pipeline.py --once 등록
  - 한국시간 10시와 맞추려면: 설정 → 시간 및 언어 → Windows 시간대 = (UTC+09:00) 서울
  - 관리자 PowerShell에서 실행:  register_daily_10am_task.bat

  이미 u25_auto_scheduler 창을 24시간 켜 두었다면 기능이 겹칠 수 있음 → 둘 중 하나만 써도 됨.
#>
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bat = Join-Path $root "run_u25_pipeline_10am_once.bat"
if (-not (Test-Path -LiteralPath $bat)) {
  Write-Host "Not found: $bat" -ForegroundColor Red
  exit 1
}
$taskName = "U25_RESIDE_DailyPipeline_10am"
# 경로 공백 대비: cmd 로 한 번 감싸서 schtasks 에 전달
$inner = 'schtasks /Create /F /TN "' + $taskName + '" /TR "' + $bat.Replace('"', '') + '" /SC DAILY /ST 10:00'
cmd.exe /c $inner | Write-Host
Write-Host "OK: task '$taskName' -> daily 10:00 local time -> $bat" -ForegroundColor Green
Write-Host "Check: schtasks /Query /TN `"$taskName`""
