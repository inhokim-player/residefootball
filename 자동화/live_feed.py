"""
API-Football 라이브 경기(스코어) 폴링 — REST 기반 '의사 실시간' 피드.

자동·절약 모드(기본):
- 기본 호출 간격은 900초(15분). 무료 플랜(일일 약 100회) 기준으로 24시간 내내
  돌려도 대략 한도 안에 들어가도록 맞춘 값입니다(86400/100 ≈ 864초).
- 응답 헤더의 일일 잔여 호출이 적으면 다음 대기 시간을 자동으로 늘립니다.
- API 키는 .env 의 API_FOOTBALL_KEY 만 사용합니다(코드에 넣지 않음).

Windows에서 자동 실행:
- `start_live_feed.bat` 더블클릭 또는 작업 스케줄러에서 이 배치를 등록하면 됩니다.

실행 예:
  python live_feed.py --once
  python live_feed.py
  python live_feed.py --interval 1200 --leagues 39
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

from scouting.config import ensure_env_loaded
from scouting.football_client import FootballAPIClient
from scouting.notifications import notify_failure, notify_info

PROJECT_ROOT = Path(__file__).resolve().parent
OUTPUT_JSON = PROJECT_ROOT / "data" / "live_fixtures.json"
MARQUEE_OUTPUT_JSON = PROJECT_ROOT / "data" / "marquee_live_fixtures.json"
KEY_SCHEDULE_OUTPUT_JSON = PROJECT_ROOT / "data" / "key_league_schedule.json"

# 월드컵/유명 대회 중심 실시간 하이라이트 필터
_MARQUEE_LEAGUE_IDS = {
    1,    # FIFA World Cup
    2,    # UEFA Champions League
    3,    # UEFA Europa League
    4,    # UEFA Euro Championship
    15,   # FIFA Club World Cup
    39,   # Premier League
    61,   # Ligue 1
    78,   # Bundesliga
    135,  # Serie A
    140,  # La Liga
    253,  # MLS
}
_KEY_LEAGUES: dict[int, dict[str, str]] = {
    39: {"alias": "EPL", "continent": "Europe"},
    2: {"alias": "UCL", "continent": "Europe"},
    140: {"alias": "La Liga", "continent": "Europe"},
    135: {"alias": "Serie A", "continent": "Europe"},
    78: {"alias": "Bundesliga", "continent": "Europe"},
    61: {"alias": "Ligue 1", "continent": "Europe"},
    253: {"alias": "MLS", "continent": "North America"},
    262: {"alias": "Liga MX", "continent": "North America"},
    71: {"alias": "Brasileirao", "continent": "South America"},
    128: {"alias": "Primera Division AR", "continent": "South America"},
    98: {"alias": "J1 League", "continent": "Asia"},
    292: {"alias": "K League 1", "continent": "Asia"},
    307: {"alias": "Saudi Pro League", "continent": "Asia"},
    288: {"alias": "CAF Champions League", "continent": "Africa"},
    233: {"alias": "Egypt Premier League", "continent": "Africa"},
}

# 무료 플랜 일일 한도(100)를 감안한 기본 간격(초). 24시간 균등 분배에 가깝게.
_DEFAULT_INTERVAL_SEC = 900

# 일일 잔여가 이 값 이하로 떨어지면 대기 시간을 늘림(환경변수로 조정 가능)
_DEFAULT_LOW_THRESHOLD = 20


def _parse_league_ids(raw: str | None) -> list[int] | None:
    """콤마 구분 리그 ID 문자열을 정수 리스트로. 빈 값이면 None(전체 live=all)."""
    if not raw or not raw.strip():
        return None
    out: list[int] = []
    for part in raw.replace(" ", "").split(","):
        if not part:
            continue
        out.append(int(part))
    return out if out else None


def _interval_from_env() -> int:
    raw = (os.environ.get("LIVE_POLL_INTERVAL_SEC") or "").strip()
    if raw.isdigit():
        return max(60, int(raw))
    return _DEFAULT_INTERVAL_SEC


def _low_threshold_from_env() -> int:
    raw = (os.environ.get("LIVE_CONSERVATIVE_THRESHOLD") or "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    return _DEFAULT_LOW_THRESHOLD


def _next_sleep_sec(
    *,
    base_interval: int,
    client: FootballAPIClient,
    low_threshold: int,
) -> int:
    """
    성공 직후 다음 폴링까지 대기할 초.
    일일 잔여 호출이 헤더로 올 때만 보수적으로 늘린다.
    """
    rem = client.daily_requests_remaining
    if rem is None:
        return base_interval

    if rem <= 0:
        notify_info("일일 호출 한도가 거의/완전 소진된 것으로 보입니다. 1시간 대기 후 재시도합니다.")
        return 3600

    if rem <= 5:
        extended = max(base_interval * 3, 3600)
        notify_info(f"일일 잔여 호출이 매우 적습니다(~{rem}). 다음 대기: {extended}초")
        return extended

    if rem <= low_threshold:
        extended = max(base_interval * 2, 1800)
        notify_info(f"일일 잔여 호출이 적습니다(~{rem}). 다음 대기: {extended}초")
        return extended

    return base_interval


def _sleep_with_jitter(seconds: int) -> None:
    """동시에 여러 클라이언트가 때릴 때를 줄이기 위해 약간의 무작위 지연."""
    jitter = random.randint(0, min(120, max(0, seconds // 10)))
    time.sleep(max(1, seconds + jitter))


def _build_marquee_payload(payload: dict[str, object]) -> dict[str, object]:
    rows = payload.get("response") or []
    if not isinstance(rows, list):
        rows = []

    marquee: list[dict[str, object]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        league = row.get("league") or {}
        fixture = row.get("fixture") or {}
        teams = row.get("teams") or {}
        goals = row.get("goals") or {}
        league_id = int((league or {}).get("id") or 0)
        league_name = str((league or {}).get("name") or "")
        is_world_cup = "world cup" in league_name.lower()
        if league_id not in _MARQUEE_LEAGUE_IDS and not is_world_cup:
            continue
        marquee.append(
            {
                "fixture_id": (fixture or {}).get("id"),
                "status": ((fixture or {}).get("status") or {}).get("short"),
                "elapsed": ((fixture or {}).get("status") or {}).get("elapsed"),
                "league_id": league_id,
                "league_name": league_name,
                "country": (league or {}).get("country"),
                "home": ((teams or {}).get("home") or {}).get("name"),
                "away": ((teams or {}).get("away") or {}).get("name"),
                "home_goals": (goals or {}).get("home"),
                "away_goals": (goals or {}).get("away"),
            }
        )
    return {
        "updated_at": int(time.time()),
        "results": len(marquee),
        "response": marquee,
    }


def _build_key_schedule_payload(client: FootballAPIClient, *, season: int) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    by_continent: dict[str, list[dict[str, object]]] = {}
    for league_id, meta in _KEY_LEAGUES.items():
        league_alias = str(meta.get("alias") or f"League {league_id}")
        continent = str(meta.get("continent") or "Other")
        result = client.get_json("/fixtures", params={"league": league_id, "season": season, "next": 1})
        if not result.success or not result.data:
            continue
        response = result.data.get("response") or []
        if not response:
            continue
        item = response[0]
        league = item.get("league") or {}
        fixture = item.get("fixture") or {}
        teams = item.get("teams") or {}
        status = (fixture.get("status") or {}) if isinstance(fixture, dict) else {}
        row = {
            "league_id": league_id,
            "league_name": league_alias,
            "continent": continent,
            "official_league_name": league.get("name"),
            "kickoff_utc": fixture.get("date"),
            "status": status.get("long") or status.get("short"),
            "home": ((teams.get("home") or {}) if isinstance(teams, dict) else {}).get("name"),
            "away": ((teams.get("away") or {}) if isinstance(teams, dict) else {}).get("name"),
        }
        rows.append(row)
        by_continent.setdefault(continent, []).append(row)
    return {"updated_at": int(time.time()), "results": len(rows), "response": rows, "by_continent": by_continent}


def run_loop(
    *,
    interval_sec: int,
    league_ids: list[int] | None,
    once: bool,
    low_threshold: int,
    season: int,
) -> int:
    ensure_env_loaded()
    client = FootballAPIClient()
    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)

    backoff_sec = interval_sec

    while True:
        result = client.fetch_live_fixtures(league_ids=league_ids)

        if result.success and result.data is not None:
            OUTPUT_JSON.write_text(
                json.dumps(result.data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            marquee_payload = _build_marquee_payload(result.data)
            MARQUEE_OUTPUT_JSON.write_text(
                json.dumps(marquee_payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            schedule_payload = _build_key_schedule_payload(client, season=season)
            KEY_SCHEDULE_OUTPUT_JSON.write_text(
                json.dumps(schedule_payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            n = int(result.data.get("results") or 0)
            m = int(marquee_payload.get("results") or 0)
            s = int(schedule_payload.get("results") or 0)
            hint = client.rate_limit_hint
            line = (
                f"[라이브] 전체={n} | 메이저={m} | 일정={s} | 저장={OUTPUT_JSON}"
                + (f" | {hint}" if hint else "")
            )
            notify_info(line)
            backoff_sec = _next_sleep_sec(
                base_interval=interval_sec,
                client=client,
                low_threshold=low_threshold,
            )
        else:
            msg = result.message_for_operator or "라이브 조회 실패"
            notify_failure(msg, technical_detail=result.technical_detail)
            if "429" in (result.technical_detail or "") or "레이트" in msg:
                backoff_sec = min(max(backoff_sec * 2, interval_sec), 3600)
                notify_info(f"429 대응: 다음 시도까지 약 {backoff_sec}초 대기합니다.")
            else:
                backoff_sec = interval_sec

        if once:
            return 0 if result.success else 1

        _sleep_with_jitter(backoff_sec)


def main() -> int:
    default_iv = _interval_from_env()
    env_leagues = (os.environ.get("LIVE_LEAGUE_IDS") or "").strip()
    default_threshold = _low_threshold_from_env()

    parser = argparse.ArgumentParser(
        description="API-Football 라이브 경기 폴링 (기본: 일일 한도 절약 모드)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=default_iv,
        metavar="SEC",
        help=(
            f"기본 폴링 주기(초). 기본값 {default_iv} "
            f"(환경변수 LIVE_POLL_INTERVAL_SEC 또는 내장 기본 {_DEFAULT_INTERVAL_SEC}). "
            "최소 60."
        ),
    )
    parser.add_argument(
        "--leagues",
        type=str,
        default=env_leagues or None,
        metavar="IDS",
        help="리그 ID를 콤마로 (예: 39). 생략 시 전 세계 live=all.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="한 번만 호출하고 종료.",
    )
    parser.add_argument(
        "--low-threshold",
        type=int,
        default=default_threshold,
        metavar="N",
        help=(
            "일일 잔여 호출이 이 값 이하이면 대기 시간을 늘립니다. "
            f"기본 {default_threshold} (환경변수 LIVE_CONSERVATIVE_THRESHOLD)."
        ),
    )
    parser.add_argument("--season", type=int, default=2025, help="핵심 리그 일정 조회 시즌")
    args = parser.parse_args()

    interval_sec = max(60, args.interval)
    league_ids = _parse_league_ids(args.leagues)
    low_threshold = max(1, args.low_threshold)

    try:
        return run_loop(
            interval_sec=interval_sec,
            league_ids=league_ids,
            once=args.once,
            low_threshold=low_threshold,
            season=args.season,
        )
    except KeyboardInterrupt:
        notify_info("사용자 중단(Ctrl+C) — 정상 종료합니다.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
