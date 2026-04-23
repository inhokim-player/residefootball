# 인수인계 스냅샷 (`docs/handover/`)

## 목적

Python·Node·운영 절차가 바뀔 때마다 **날짜가 들어간 새 Markdown 파일**을 남겨, 다음 담당자가 저장소만으로도 맥락을 따라갈 수 있게 합니다.

## 새 파일 만드는 방법

1. 아래 스크립트 실행(프로젝트 루트에서):

   ```bash
   python scripts/write_handover_snapshot.py
   ```

2. 생성된 `HANDOVER_YYYY-MM-DD.md` 를 열어, 이번 변경 요약·주의사항·환경 변수·실행 명령을 **직접 보완**합니다.

3. **비밀번호·API 키·토큰은 파일에 적지 마세요.** 대신 `.env` 키 이름과 “담당자에게 별도 전달”만 적습니다.

## 이 폴더에 적기 좋은 것

- 배포/로컬 실행 명령(uvicorn, 배치 파일, 스케줄러)
- `data/automation_config.json` 과 `site/index.html` 의 API 베이스 정합
- 운영 콘솔(`site/admin.html`) · CORS · Bearer 저장 위치 관련 주의
- 장애/보안 이슈와 회피 방법

## 보안·스택 고정 문서

- **`SECURITY_HARDENING_KO.md`** — 공개 전 보안 체크리스트.
- **`DEPLOY_AND_AUTOMATION_KO.md`** — 배포·systemd·Windows 스택 기동·자동화 요약.
- **`VERCEL_ALWAYS_ON_KO.md`** — Vercel(프론트) + always-on 백엔드(Render) 구성.
- **`PYTHON_NODE_STACK_KO.md`** — Python/Node 역할·명령 요약.

## Node.js

루트 `package.json` 은 **인수인계용 메타만** (`private`, `engines`). 빌드 스크립트는 없습니다. 프런트는 정적 `site/` 입니다. 번들러를 도입하면 **스냅샷 + PYTHON_NODE_STACK_KO.md** 를 함께 갱신하세요.
