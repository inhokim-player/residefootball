# 인수인계 스냅샷 (`docs/handover/`)

## 목적

Python·운영 절차가 바뀔 때마다 **날짜가 들어간 새 Markdown 파일**을 남겨, 다음 담당자가 맥락을 따라갈 수 있게 합니다.

## 새 스냅샷 만드는 방법

1. 프로젝트 루트에서:

   ```bash
   python scripts/write_handover_snapshot.py
   ```

2. 생성된 `HANDOVER_YYYY-MM-DD.md` 를 열어 변경 요약·주의사항·환경 변수·실행 명령을 보완합니다.

3. **비밀번호·API 키·토큰은 파일에 적지 마세요.** `.env` 키 이름과 “담당자에게 별도 전달”만 적습니다.

## 이 폴더에 적기 좋은 것

- 로컬/서버 실행 명령(uvicorn, 배치 파일, 스케줄러)
- `data/automation_config.json` 과 `site/index.html` 의 API 베이스 정합
- CORS · Bearer(상단 API 버튼 저장) 관련 주의
- 장애/보안 이슈와 회피 방법

## 고정 참고 문서

- **`SECURITY_HARDENING_KO.md`** — 공개 전 보안 체크리스트
- **`PYTHON_NODE_STACK_KO.md`** — Python/Node 역할·명령 요약

## RESIDE 한 파일 요약(루트)

운영·홈·배치 전체 요약은 저장소 루트의 **`RESIDE_시스템_홈페이지_프롬프트.txt`** 를 사용합니다.
