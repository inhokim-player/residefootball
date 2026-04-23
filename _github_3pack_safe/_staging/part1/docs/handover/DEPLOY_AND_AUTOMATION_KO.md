# 서버 배포·자동화 한 번에 보기

이 문서는 **공개 서버에 올릴 때** API·선수 파이프라인·라이브 피드·웹 정적 파일을 어떻게 묶을지 정리합니다. **API 키·Bearer 토큰은 절대 Git에 넣지 마세요.** 값은 `.env`와 담당자 간 안전한 채널로만 전달합니다.

## 1. 환경 변수(`.env`)

`.env.example` 을 복사해 `.env` 를 만들고 아래를 채웁니다.

| 키 | 용도 |
|----|------|
| `API_FOOTBALL_KEY` | API-Football(api-sports) 호출 — `live_feed.py`, 글로벌 하베스트 등 |
| `U25_API_TOKEN` | 공개 API 잠금 시 `Authorization: Bearer …` |
| `U25_CORS_ORIGINS` | 운영에서는 **본인 HTTPS 도메인만** 콤마로 나열 |
| `U25_EXPOSE_DOCS` | 미설정 또는 `0` 권장(OpenAPI 비노출) |

선택: `LIVE_POLL_INTERVAL_SEC`, 알림용 SMTP 등은 기존 문서·코드 주석을 따릅니다.

## 2. 운영 보안(필수)

1. **`data/automation_config.json`** 의 `security.allow_local_token_bypass` 를 **`false`** 로 둡니다. (로컬 전용 우회는 공개 서버에서 끄는 것이 맞습니다.)
2. **`U25_CORS_ORIGINS`** 에 실제 사이트 origin만 넣습니다.
3. **HTTPS** 는 Nginx/Caddy 등 리버스 프록시에서 종료하고, 백엔드는 `127.0.0.1` 에만 바인딩하는 구성을 권장합니다(`u25-api.service.example` 참고).
4. 자세한 체크리스트: **`SECURITY_HARDENING_KO.md`**
5. 정적 사이트(`site/index.html`, `site/admin.html`)의 **CSP `connect-src`** 에 운영 API origin이 포함되는지 배포 URL 기준으로 확인합니다.

## 3. Windows: 한 번에 기동

프로젝트 루트에서:

- **`start_server_stack.bat`** — 기본 `Full`: API(uvicorn) + `u25_auto_scheduler.py` + `live_feed.py` 를 **각각 별도 PowerShell 창**으로 띄웁니다.
- 모드만 API만: `start_server_stack.bat Api`
- 스케줄러만: `start_server_stack.bat Scheduler`
- 라이브 피드만: `start_server_stack.bat LiveFeed`
- 공개 바인딩이 정말 필요할 때만: `start_server_stack.bat Full PublicBind`

내부 스크립트: `scripts/server_stack.ps1`. 기본 API 바인딩은 `127.0.0.1`(보안 우선)이며, `.env` 에 `API_FOOTBALL_KEY` 가 없으면 라이브 피드 창은 건너뜁니다.

일부 Windows 환경에서는 `Get-NetTCPConnection` 기반 포트 정리에 **관리자 권한**이 필요할 수 있습니다. 그 경우 작업 관리자에서 해당 포트 프로세스를 종료하거나, `Api` 모드만 관리자 PowerShell에서 실행하세요.

## 4. Linux(systemd): 서비스 분리 권장

`docs/deploy/` 의 예시 유닛을 참고해 경로·유저·가상환경을 맞춥니다.

- `u25-api.service.example` — uvicorn
- `u25-scheduler.service.example` — `u25_auto_scheduler.py`
- `u25-livefeed.service.example` — `live_feed.py`

각 서비스는 **독립 재시작**이 가능하고, 한 프로세스가 죽어도 나머지가 계속 돌아갑니다.

## 5. 자동화가 하는 일(요약)

| 구성요소 | 역할 |
|----------|------|
| `u25_api.py` | REST API, 대시보드·관리자 페이지가 호출 |
| `u25_auto_scheduler.py` | `automation_config.json` 의 시간대에 맞춰 파이프라인 슬롯 실행 |
| `u25_pipeline.py` / `run_once` | 하베스트·바이오 백필·랭킹·DB·스냅샷·보안 백업 |
| `live_feed.py` | API-Football 폴링 → `data/live_fixtures.json` 등 |

수동 한 번 실행이 필요할 때는 예:

```bash
python u25_pipeline.py run_once --season 2024
python live_feed.py --once
```

## 6. 배포 후 점검

- 배포 직전 자동 점검 실행: `predeploy_check.bat`
- `GET /health` (토큰 정책에 따라 인증 여부 확인)
- 관리자·대시보드에서 선수 목록·401 없이 동작하는지
- 스케줄러 로그에 슬롯 실행 기록이 있는지
- `data/live_fixtures.json` 갱신 시각

이 문서를 갱신할 때는 **비밀 값은 적지 말고** 키 이름과 절차만 유지하세요.
