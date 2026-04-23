# Python / Node 스택 인수인계 (U25 프로젝트)

날짜·담당자는 PR/슬랙에 맞게 적어 두세요. **비밀 값은 이 파일에 적지 마세요.**

---

## Python (필수 런타임)

| 항목 | 내용 |
| --- | --- |
| 역할 | FastAPI 앱 `u25_api.py`, 배치·스케줄러(`u25_auto_scheduler.py`), 라이브 피드(`live_feed.py`), DB(`scouting/u25_database.py`) |
| 의존성 | 루트 `requirements.txt` — `python -m pip install -r requirements.txt` |
| 로컬 실행 | `go.bat` / `start_u25_api.bat` 또는 `python -m uvicorn u25_api:app --host 127.0.0.1 --port 8010` |
| 설정 | `.env`(비밀), `data/automation_config.json`(스케줄·CORS·레이트리밋 등) |
| DB | `data/u25_scouting.db` (SQLite) |

### 버전 권장

- **Python 3.11+** 권장(프로젝트에 `pyproject` 없음 — CI/운영에서 고정 버전 명시 권장).

### 자주 쓰는 명령

```bash
cd /path/to/project
python -m pip install -r requirements.txt
python -m uvicorn u25_api:app --host 127.0.0.1 --port 8010
python u25_auto_scheduler.py
python live_feed.py
python fetch_countries.py
```

---

## Node.js

| 항목 | 내용 |
| --- | --- |
| 현재 | **루트에 `package.json` 없음** — 프론트는 정적 HTML(`site/index.html`, `site/admin.html`) + CDN. |
| 빌드 | 없음. Live Server·정적 호스팅·리버스 프록시로 `site/`만 서빙하면 됨. |
| 향후 | Vite/React 등 도입 시 이 문서에 **Node 버전(`engines`)·lockfile·빌드/배포 명령**을 추가. |

### Node를 쓰게 되면

1. `package.json`에 `"private": true`, `"engines": { "node": ">=20" }` 등 명시.
2. `npm ci` / `pnpm install --frozen-lockfile` 로 재현 가능한 설치.
3. CI에서 `npm run build` + 산출물만 배포.

---

## 보안 문서

- **`docs/handover/SECURITY_HARDENING_KO.md`** — 공개 전 체크리스트.
- **`docs/STARTUP_SEQUENCE_KO.md`** — 기동 순서.

---

## 스냅샷 갱신

```bash
python scripts/write_handover_snapshot.py
```
