<#
.SYNOPSIS
  U25 서버 + 자동화 프로세스 기동(Windows). 비밀 값은 .env 에만 둡니다.

.DESCRIPTION
  - Api        : uvicorn (기본 8010)
  - Scheduler  : u25_auto_scheduler.py (automation_config.json 시각 기준)
  - LiveFeed   : live_feed.py (API-Football, .env 의 API_FOOTBALL_KEY 필요)
  - Full       : 위 셋 모두(각각 별도 PowerShell 창)

  Linux 배포는 systemd 예시를 docs/deploy/*.service.example 및 DEPLOY_AND_AUTOMATION_KO.md 를 따르세요.
#>

param(
  [ValidateSet("Api", "Scheduler", "LiveFeed", "Full")]
  [string]$Mode = "Full",
  [int]$Port = 8010,
  [switch]$PublicBind
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $root

function Stop-PortListeners([int] $p) {
  try {
    Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch { }
}

function Test-EnvFileHasKey([string] $keyName) {
  $envPath = Join-Path $root ".env"
  if (-not (Test-Path $envPath)) { return $false }
  foreach ($line in Get-Content $envPath) {
    if ($line -match "^\s*#") { continue }
    if ($line -match "^\s*$keyName\s*=\s*(\S+)\s*$") { return ($Matches[1].Trim().Length -gt 0) }
  }
  return $false
}

function Start-StackWindow([string] $title, [string] $command) {
  Start-Process powershell.exe -WorkingDirectory $root -WindowStyle Normal -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", $command
  ) | Out-Null
}

Write-Host "Project: $root" -ForegroundColor Cyan
Write-Host "Mode:    $Mode" -ForegroundColor Cyan
$bindHost = if ($PublicBind) { "0.0.0.0" } else { "127.0.0.1" }
Write-Host "API bind: $bindHost" -ForegroundColor Cyan

if ($Mode -eq "Api" -or $Mode -eq "Full") {
  Write-Host "Clearing port $Port ..." -ForegroundColor DarkGray
  Stop-PortListeners $port
  Start-Sleep -Milliseconds 400
  $cmd = "Set-Location -LiteralPath '$root'; python -m uvicorn u25_api:app --host $bindHost --port $port"
  Start-StackWindow "U25 API ($Port)" $cmd
  Write-Host "Started API on $bindHost:$port. Close window to stop." -ForegroundColor Green
}

if ($Mode -eq "Scheduler" -or $Mode -eq "Full") {
  if (-not (Test-Path (Join-Path $root "u25_auto_scheduler.py"))) {
    Write-Host "Skip: u25_auto_scheduler.py not found." -ForegroundColor Yellow
  } else {
    Start-StackWindow "U25 Auto Scheduler" "Set-Location -LiteralPath '$root'; python u25_auto_scheduler.py"
    Write-Host "Started scheduler window." -ForegroundColor Green
  }
}

if ($Mode -eq "LiveFeed" -or $Mode -eq "Full") {
  if (-not (Test-EnvFileHasKey "API_FOOTBALL_KEY")) {
    Write-Host "Skip live_feed: .env missing API_FOOTBALL_KEY" -ForegroundColor Yellow
  } elseif (-not (Test-Path (Join-Path $root "live_feed.py"))) {
    Write-Host "Skip: live_feed.py not found." -ForegroundColor Yellow
  } else {
    Start-StackWindow "U25 Live Feed" "Set-Location -LiteralPath '$root'; python live_feed.py"
    Write-Host "Started live_feed window." -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "Next: 공개 배포 시 CORS·HTTPS. 로컬 요약은 RESIDE_시스템_홈페이지_프롬프트.txt" -ForegroundColor DarkGray
