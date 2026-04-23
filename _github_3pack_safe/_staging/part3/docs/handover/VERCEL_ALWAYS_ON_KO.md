# Vercel + Always-On 자동화 배포

요구사항: **컴퓨터가 꺼져도** 사이트/API/자동화가 계속 동작해야 함.

구성:

- 프론트: **Vercel** (정적 `site/`)
- 백엔드+자동화: **Render Web Service** (상시 실행)
  - `u25_api.py`
  - `u25_auto_scheduler.py`
  - `live_feed.py`
  - 위 3개를 `scripts/start_cloud_stack.py`에서 한 프로세스 그룹으로 기동

---

## 1) GitHub 업로드

이 저장소를 GitHub에 올린 뒤 Vercel/Render 모두 GitHub 리포를 연결합니다.

---

## 2) Render 설정 (컴퓨터 꺼도 자동화 계속)

1. Render 대시보드에서 **New + Blueprint** 또는 **New Web Service**
2. 리포 선택
3. `render.yaml` 기준으로 배포
4. 환경 변수 추가:
   - `API_FOOTBALL_KEY`
   - `U25_API_TOKEN`
   - `U25_CORS_ORIGINS=https://residefootball.com,https://www.residefootball.com`
   - `U25_EXPOSE_DOCS=0`
5. 배포 완료 후 API 주소 확인 (예: `https://residefootball-api.onrender.com`)

운영 도메인 권장:
- `api.residefootball.com` -> Render 서비스 CNAME 연결

---

## 3) Vercel 설정

1. Vercel에서 프로젝트 Import (같은 GitHub 리포)
2. Root Directory는 저장소 루트 그대로
3. `vercel.json` 적용되어 `/` -> `site/index.html`, `/admin` -> `site/admin.html` 라우팅됨
4. 도메인 연결:
   - `residefootball.com`
   - `www.residefootball.com`

---

## 4) 프론트 API 주소

이미 기본값은 `https://api.residefootball.com`으로 설정됨.

- `site/index.html`
- `site/admin.html`

도메인 연결 전 테스트 시에는 `?api=https://<render-url>` 쿼리로 임시 확인 가능.

---

## 5) 배포 후 점검

1. Render API `/health` 확인
2. Vercel 사이트에서 데이터 호출 확인
3. `predeploy_check.bat` 로 로컬 설정 점검
4. 관리자 페이지(`/admin`)에서 상태 확인

---

## 6) 핵심 주의

- Vercel만 단독 사용하면 자동화는 계속 돌지 않습니다.
- 자동화 연속 실행은 Render(또는 유사 always-on 서비스)가 필요합니다.
