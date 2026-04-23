# 시스템 기동 순서·방법 (U25 스카우팅)

공개 화면에는 **「API」라는 문구를 쓰지 않습니다.** 상단 네비 우측(언어 버튼 옆)에 아주 작게 **「연결 실패」**가 보이면 아래 순서를 다시 점검하세요. (직접 `site/admin.html` 주소로 열어 Bearer 저장)

---

## 1단계: 프로젝트 루트와 `.env`

1. 터미널에서 **프로젝트 루트**로 이동합니다 (`u25_api.py` 가 있는 폴더).
2. `.env.example` 을 참고해 **`.env`** 를 만듭니다.
3. 최소로 채울 항목:
   - `API_FOOTBALL_KEY` — 외부 축구 데이터 호출에 필요
   - (선택) `U25_API_TOKEN` — 값이 있으면 브라우저에 **Bearer** 저장이 필요합니다. 저장은 **「운영」**(`site/admin.html`)에서만 합니다.

비밀 값은 **외부에 노출하지 마세요.**

---

## 2단계: Python 의존성

```bash
python -m pip install -r requirements.txt
```

---

## 3단계: 백엔드 서버 (필수)

**가장 단순:** 프로젝트 루트에서 **`go.bat`** 또는 **`start_u25_api.bat`** 더블클릭 → API + 루트 `index.html`(→ `site/index.html`).

수동 실행:

```bash
python -m uvicorn u25_api:app --host 127.0.0.1 --port 8010
```

- 포트는 `data/automation_config.json` 의 `api.port` 와 맞출 것 (기본 `8010`).
- 서버를 끄면 메인 화면에 **브라우저 연결 실패**가 뜰 수 있습니다.

---

## 4단계: 프런트(브라우저) 열기

1. VS Code **Live Server** 등으로 `site/index.html` 을 연다.
2. 주소가 `127.0.0.1:5500` 처럼 백엔드와 **같은 머신**이면 CORS 기본값으로 통신 가능한 경우가 많습니다.
3. `U25_API_TOKEN` 을 켠 경우:
   - 브라우저에서 **`site/admin.html`** 을 연 뒤 **접속용 Bearer** 입력 → 저장 → **메인 새로고침**

---

## 5단계: 데이터 배치 (필요할 때)

| 순서 | 할 일 | 명령·파일 |
| --- | --- | --- |
| A | 국가 목록 캐시 | `python fetch_countries.py` |
| B | 라이브 피드(선택) | `start_live_feed.bat` 또는 `python live_feed.py` |
| C | 풀 동기 스케줄러 | (별도 작업 스케줄러·스크립트가 있다면 그 문서 따름) |

`site/admin.html` 의 **데이터 파일 신호** 표에서 JSON/DB 파일 `mtime` 이 갱신되는지 확인할 수 있습니다.

---

## Cursor(또는 AI)로 작업할 때 추천 프롬프트 순서

인수인계·수정 시 아래를 **위에서부터** 한 번에 넣거나 나눠 요청하면 정리가 잘 됩니다.

1. **「이 저장소의 루트에서 `u25_api.py` 가 FastAPI 엔트리인지, `site/index.html` 이 어떤 주소로 백엔드를 부르는지 요약해줘.」**
2. **「`.env` 에 필요한 키 목록만 표로 정리하고, 값은 적지 마.」**
3. **「로컬에서 `uvicorn` 실행 커맨드 한 줄과, `automation_config.json` 의 api 포트와 맞추는 방법을 적어줘.」**
4. **「`fetch_countries.py` 와 `live_feed.py` 의 역할 차이와 실행 타이밍을 짧게 설명해줘.」**
5. **「메인 네비에 `연결 실패` 가 뜰 때 의심할 체크리스트 5개.」**

새 큰 변경이 있으면 `python scripts/write_handover_snapshot.py` 로 `docs/handover/` 에 날짜별 스냅샷을 추가하세요.

---

## Node.js

현재 루트에 `package.json` 이 없으면 **Node 빌드 단계는 없습니다.** 나중에 프런트 빌드 도구를 넣으면 이 문서에 **npm/pnpm 명령**을 같은 형식으로 추가하면 됩니다.
