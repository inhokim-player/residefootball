================================================================================
_github_3pack_safe — 배포·자동화 이 폴더만 보면 됩니다.
(경로: OneDrive/바탕 화면/my website/_github_3pack_safe)
================================================================================

[GitHub 올린 뒤 Vercel 배포 — 순서 틀리면 안 됨 / 정확히 이 파일만]
  반드시 이 순서:

    GITHUB_AND_VERCEL_EXACT_STEPS.txt

[서버에 배포할 때 — 저장소 받은 뒤 서버에서]
  이 폴더 안의:

    서버배포.txt

  만 순서대로 따르면 됩니다. (clone / venv / .env / uvicorn / 10시 cron)

[Vercel 로 사이트(프론트)만 배포할 때]
  이 폴더 안의:

    VERCEL_DEPLOY.txt

  (API 는 별도 서버, Vercel 은 주로 site/ 정적 배포)

[GitHub 에 코드 한 번에 올리기 — 복잡하게 말고 이것만]
  이 폴더에서 더블클릭:

    push_to_github.bat

  → 상위 폴더(프로젝트 루트)로 가서 deploy.bat 을 실행합니다.
  → GitHub 에 origin 이 잡혀 있고 로그인 되어 있으면 push 까지 됩니다.

--------------------------------------------------------------------------------
한국시간 10시 최신화 + 선수 키(고유 id)·이름·국적 — 코드에 이렇게 맞춰 둠
--------------------------------------------------------------------------------
- 매일 10시(KST): data/automation_config.json 의 schedule_times ["10:00"],
  timezone "Asia/Seoul" + u25_auto_scheduler.py 가 그날 한 번 u25_pipeline 을 돌림.
- API-Football 수집(global_u25_harvest.py):
    · player_id = API 의 숫자 id 만 (잘못된 키는 저장 안 함)
    · 이름 = name 우선, 없으면 firstname + lastname (공백·이상 문자 정리)
    · 국적 = nationality → birth.country → 리그 국가 순
    · 나이 = API age 없으면 birth.date 기준 만 나이(U25 필터)
- 집 PC 꺼져도 사이트: site/index.html 이 공개 API 를 비로컬에서 먼저 시도.
- 해킹 보완: scouting/security_http.py + .env(U25_API_TOKEN 등) + automation_config.security

--------------------------------------------------------------------------------
원하는 것: "집 PC 꺼져도 사이트 잘 되고, 매일 오전 10시 API-Football 로 선수 최신화"
--------------------------------------------------------------------------------

[한 줄 진실]
  자동으로 돌아가는 건 **항상 전원·인터넷이 붙어 있는 컴퓨터(서버)** 하나가 있어야 합니다.
  **집 PC만** 두고 전원을 끄면, 그 PC 안에서 돌던 "10시 수집"은 멈춥니다.
  그래서 **같은 코드를 VPS·클라우드 VM 같은 데 올려 두고**, 거기서만 스케줄을 돌리면 됩니다.

[사이트(PC 꺼도 보임)]
  - HTML 은 GitHub Pages / 호스팅 등에 올리면, **페이지 열기**는 집 PC 와 무관합니다.
  - 선수 데이터는 **항상 켜 둔 API 서버**(예: api.residefootball.com)가 DB 를 응답해야 합니다.
    (지금 site 는 그쪽을 기본으로 부릅니다.)

[매일 10시 API-Football 최신화 — 서버 한 대에서만 하면 됨]
  1) 서버에 이 프로젝트 clone + venv + pip install -r requirements.txt
  2) 서버에 .env (API_FOOTBALL_KEY 등)
  3) 매일 한 번 파이프라인(수집·DB 반영):

       python u25_pipeline.py --once

  4) 리눅스 예시(cron, KST 10:00):

       0 10 * * * cd /path/to/my-website && /path/to/.venv/bin/python u25_pipeline.py --once >> /var/log/u25_pipeline.log 2>&1

     (Windows 서버면 "작업 스케줄러"에 같은 명령을 매일 10:00 에 등록.)

  5) API 는 그 서버에서 계속 띄움:

       python -m uvicorn u25_api:app --host 0.0.0.0 --port 8010

     (또는 nginx 뒤에서 127.0.0.1 만 열어도 됨.)

[집 PC 에서 할 일]
  - 코드 수정 후 **push_to_github.bat** (또는 루트의 deploy.bat) → 서버에서는 **git pull**

[정리]
  "PC 꺼도 자동 + 10시 최신화" = **집 PC 말고, 24시간 서버 한 대**에 위 3~5만 있으면 됩니다.

================================================================================
