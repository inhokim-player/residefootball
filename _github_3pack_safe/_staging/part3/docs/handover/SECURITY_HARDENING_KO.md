# 보안 강화·공개 전 체크리스트 (U25)

웹을 **인터넷에 공개**하기 전에 아래를 순서대로 점검하세요. 로컬만 쓸 때와 운영은 다릅니다.

---

## 1. 비밀·키 (최우선)

| 항목 | 할 일 |
| --- | --- |
| `.env` | **Git에 절대 커밋하지 않음.** 저장소·백업·스크린샷에 키 노출 금지. |
| `API_FOOTBALL_KEY` | 유출 시 **즉시 키 폐기·재발급**. |
| `U25_API_TOKEN` | 운영에서는 **강한 랜덤 값** + `site/admin.html`에서만 Bearer 저장. |
| SMTP 등 | `.env`에만 두고 코드·문서에 값 적지 않기. |

---

## 2. API 서버 (`u25_api` / FastAPI)

| 항목 | 현재·권장 |
| --- | --- |
| OpenAPI | 기본 **비노출**. 필요 시만 `U25_EXPOSE_DOCS=1` (짧게 켠 뒤 끄기). |
| Bearer | `U25_API_TOKEN` 설정 시 **전 엔드포인트**에 적용(`/health`·`OPTIONS` 제외). |
| 로컬 우회 | `data/automation_config.json` 의 `security.allow_local_token_bypass` — **로컬 개발 편의용**. **공개 서버에서는 `false`** + `U25_ALLOW_LOCAL_TOKEN_BYPASS=0` 권장. |
| CORS | `U25_CORS_ORIGINS` 또는 `automation_config.json` 의 `security.cors_origins`에 **본인 도메인만**. |
| 메서드 | `GET`/`POST`/`HEAD`/`OPTIONS` 외 **차단** (`RequestSurfaceGuardMiddleware`). |
| 레이트 리밋 | `automation_config.json` 의 `request_rate_limit_per_minute` 등으로 조정. |
| 응답 헤더 | `SecurityHeadersMiddleware`: `nosniff`, `DENY` 프레임, `no-referrer`, `Permissions-Policy`, **DNS prefetch off**, `X-Permitted-Cross-Domain-Policies: none`, `CORP: cross-origin`(CORS 호환). |

---

## 3. 정적 페이지 (`site/index.html`, `site/admin.html`)

| 항목 | 할 일 |
| --- | --- |
| CSP | `<meta http-equiv="Content-Security-Policy">` 적용됨. **API 베이스를 다른 호스트로 바꾸면** `connect-src`에 해당 출처 추가 필요. |
| CDN | Bootstrap은 **SRI** 포함. CDN 교체 시 **integrity 재계산** 필수. |
| robots | `noindex, nofollow` — 검색 노출 원하면 별도 정책으로 변경. |

---

## 4. 인프라 (공개 시)

| 항목 | 할 일 |
| --- | --- |
| HTTPS | 리버스 프록시(Nginx/Caddy/Cloudflare) 뒤에 두고 **TLS 종료**. |
| HSTS | 프록시에서 `Strict-Transport-Security` 설정(문서만으로는 부족). |
| 방화벽 | DB·`.env`·SQLite 파일이 **외부에 직접 열리지 않게**. API 포트만 노출. |
| OS | 자동 로그인·RDP 약한 비밀번호 금지. |

---

## 5. 사고 대응

- 키 유출 의심 → **즉시 키 회전**, `U25_API_TOKEN` 재발급, 접속 로그 확인.
- 이상 트래픽 → `request_rate_limit` 낮추기, CORS 출처 축소, IP 제한(프록시 레벨).

---

## 6. 배포·프로세스 기동

Windows 전체 스택(API·스케줄러·라이브 피드)과 Linux systemd 예시는 **`DEPLOY_AND_AUTOMATION_KO.md`** 를 참고하세요.

---

## 7. 한 줄 요약

**비밀은 `.env`에만, 공개 시에는 HTTPS + 좁은 CORS + Bearer + `allow_local_token_bypass` 끄기.**
