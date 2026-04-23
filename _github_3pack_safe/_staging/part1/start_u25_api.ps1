# U25 API — 재부팅·중복 실행에도 한 포트(8010)에 서버 하나만 뜨게 정리합니다.
# - 기존 8010 LISTEN 프로세스 종료
# - OneDrive 경로가 늦게 붙는 경우 u25_api.py 가 보일 때까지 잠시 대기
# - 재부팅 직후 네트워크 안정화를 아주 짧게 대기(스킵: -SkipWarmup)

param(
  [switch]$SkipWarmup
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8010
$apiFile = Join-Path $root "u25_api.py"

function Stop-ListenerOnPort([int] $p) {
  try {
    $pids = @(
      Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($procId in $pids) {
      if ($procId -gt 0) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    # Get-NetTCPConnection 이 없거나 권한 이슈 시 무시
  }
}

# OneDrive 등: 폴더·파일이 아직 안 붙었으면 잠깐 대기
$waitUntil = (Get-Date).AddSeconds(20)
while (-not (Test-Path $apiFile) -and (Get-Date) -lt $waitUntil) {
  Start-Sleep -Seconds 1
}
if (-not (Test-Path $apiFile)) {
  Write-Host "오류: u25_api.py 를 찾을 수 없습니다. 경로와 OneDrive 동기를 확인하세요." -ForegroundColor Red
  Write-Host "  폴더: $root" -ForegroundColor Yellow
  exit 1
}

Set-Location -LiteralPath $root

# 중복 서버 방지: 8010 점유 프로세스 정리
Write-Host "포트 $port 정리 중(이전에 켜 둔 uvicorn/python 이 있으면 종료)..." -ForegroundColor DarkGray
Stop-ListenerOnPort $port
Start-Sleep -Milliseconds 400
Stop-ListenerOnPort $port

if (-not $SkipWarmup) {
  Write-Host "재부팅 직후라면 Wi-Fi·OneDrive 가 잠깐 붙는 동안 3초만 대기합니다. (건너뛰기: -SkipWarmup)" -ForegroundColor DarkYellow
  Start-Sleep -Seconds 3
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Host "오류: PATH 에서 python 을 찾을 수 없습니다. Python 설치·PATH 를 확인하세요." -ForegroundColor Red
  exit 1
}

Write-Host "U25 API 시작: http://127.0.0.1:$port  (프로젝트: $root)" -ForegroundColor Cyan
Write-Host "이 창을 닫으면 서버가 꺼집니다. 브라우저는 서버가 떠 있는 동안만 새로고침 하세요." -ForegroundColor Gray
python -m uvicorn u25_api:app --host 127.0.0.1 --port $port
