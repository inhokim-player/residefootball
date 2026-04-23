from __future__ import annotations

import json
import os
import random
import threading
import time
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from scouting.automation_settings import default_automation_dict, ensure_automation_config_files, read_automation_config
from scouting.config import ensure_env_loaded
from scouting.security_http import (
    APITokenMiddleware,
    BodySizeLimitMiddleware,
    RateLimitMiddleware,
    RequestSurfaceGuardMiddleware,
    SecurityHeadersMiddleware,
    clamp_int,
    expose_openapi_docs,
    get_cors_allow_origins,
    sanitize_player_id,
    sanitize_query_value,
    sanitize_sort_by,
    sanitize_sort_order,
)
from scouting.u25_database import (
    fetch_advanced_analytics,
    fetch_analytics,
    fetch_filter_options,
    fetch_players,
    fetch_rankings,
    fetch_system_status,
    init_db,
)
from scouting.u25_engine import league_adaptation_matrix

_EXPOSE_DOCS = expose_openapi_docs()
app = FastAPI(
    title="U25 Scouting API",
    version="1.0.0",
    docs_url="/docs" if _EXPOSE_DOCS else None,
    redoc_url="/redoc" if _EXPOSE_DOCS else None,
    openapi_url="/openapi.json" if _EXPOSE_DOCS else None,
)
PROJECT_ROOT = Path(__file__).resolve().parent
MARQUEE_PATH = PROJECT_ROOT / "data" / "marquee_live_fixtures.json"
KEY_SCHEDULE_PATH = PROJECT_ROOT / "data" / "key_league_schedule.json"
AUTO_STATE_PATH = PROJECT_ROOT / "data" / "u25_auto_scheduler_state.json"
VISITOR_COUNT_PATH = PROJECT_ROOT / "data" / "visitor_count.json"
PLAYER_VIEWS_PATH = PROJECT_ROOT / "data" / "player_views.json"
COUNTRIES_JSON_PATH = PROJECT_ROOT / "countries.json"
DB_PATH = PROJECT_ROOT / "data" / "u25_scouting.db"
_VISITOR_COUNT_LOCK = threading.Lock()
_PLAYER_VIEWS_LOCK = threading.Lock()

_METRIC_KEY_MAP: dict[str, str] = {
    "height": "height_cm",
    "age": "age",
    "weight": "weight_kg",
    "pass_success": "pass_success_rate",
    "duel_success": "duel_win_rate",
    "shot_attempts": "shot_attempts",
    "shot_accuracy": "shot_accuracy",
    "pass_attempts": "pass_attempts",
    "minutes": "minutes_played",
    "physical": "physical_index",
    "sprint_speed": "sprint_speed",
    "distance": "distance_per_match_km",
    "goals": "goals",
    "assists": "assists",
    "injuries": "injuries_count",
    "pass_miss": "pass_miss",
    "duel_win_rate": "duel_win_rate",
    "ball_recoveries": "ball_recoveries",
    "tackle_success": "tackle_success_rate",
    "intercept_success": "intercept_success_rate",
    "after80_pass": "after80_pass_success_rate",
    "after80_attack": "after80_attack_success_rate",
    "after80_goals": "after80_goals",
    "after80_assists": "after80_assists",
    "space_creation": "space_creation_count",
    "dribble_success": "dribble_success_rate",
    "dribble_success_count": "dribble_success_count",
}
_LOWER_IS_BETTER = {"pass_miss", "injuries", "age"}


def _spotlight_score(p: dict[str, object]) -> float:
    return (
        float(p.get("space_creation_count") or 0) * 0.18
        + float(p.get("pass_success_rate") or 0) * 0.14
        + float(p.get("duel_win_rate") or 0) * 0.12
        + float(p.get("shot_accuracy") or 0) * 0.12
        + float(p.get("dribble_success_rate") or 0) * 0.12
        + float(p.get("tackle_success_rate") or 0) * 0.08
        + float(p.get("intercept_success_rate") or 0) * 0.08
        + float(p.get("after80_attack_success_rate") or 0) * 0.10
        + float(p.get("goals") or 0) * 1.8
        + float(p.get("assists") or 0) * 1.5
        - float(p.get("injuries_count") or 0) * 2.0
    )


def _spotlight_payload(p: dict[str, object]) -> dict[str, object]:
    return {
        "player_id": p.get("player_id"),
        "name": p.get("name"),
        "height_cm": p.get("height_cm"),
        "weight_kg": p.get("weight_kg"),
        "dominant_foot": p.get("dominant_foot"),
        "country": p.get("country"),
        "club": p.get("club"),
        "league": p.get("league"),
        "position": p.get("position"),
        "age": p.get("age"),
        "spotlight_score": round(_spotlight_score(p), 2),
        "stats": {
            "pass_success_rate": p.get("pass_success_rate"),
            "duel_win_rate": p.get("duel_win_rate"),
            "shot_accuracy": p.get("shot_accuracy"),
            "space_creation_count": p.get("space_creation_count"),
            "dribble_success_rate": p.get("dribble_success_rate"),
            "goals": p.get("goals"),
            "assists": p.get("assists"),
            "after80_attack_success_rate": p.get("after80_attack_success_rate"),
        },
    }


def _hidden_reco_score(p: dict[str, object]) -> float:
    minutes = float(p.get("minutes_played") or 0.0)
    goals = float(p.get("goals") or 0.0)
    assists = float(p.get("assists") or 0.0)
    space = float(p.get("space_creation_count") or 0.0)
    pass_rate = float(p.get("pass_success_rate") or 0.0)
    duel = float(p.get("duel_win_rate") or 0.0)
    dribble = float(p.get("dribble_success_rate") or 0.0)

    # Favor good output with lower exposure (minutes).
    minutes_factor = 1.0 - min(max(minutes, 0.0), 3200.0) / 3200.0
    quality = (
        goals * 2.2
        + assists * 1.7
        + space * 0.12
        + pass_rate * 0.08
        + duel * 0.06
        + dribble * 0.07
    )
    return quality + minutes_factor * 22.0


def _scope(
    continent: str | None,
    country: str | None,
    position: str | None,
    league: str | None,
) -> dict[str, str]:
    return {
        "continent": sanitize_query_value(continent),
        "country": sanitize_query_value(country),
        "position": sanitize_query_value(position),
        "league": sanitize_query_value(league),
    }


def _read_visitor_count() -> int:
    if not VISITOR_COUNT_PATH.exists():
        return 0
    try:
        raw = json.loads(VISITOR_COUNT_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return 0
    try:
        return max(0, int(raw.get("count", 0))) if isinstance(raw, dict) else 0
    except Exception:  # noqa: BLE001
        return 0


def _write_visitor_count(count: int) -> None:
    VISITOR_COUNT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"count": max(0, int(count)), "updated_at": int(time.time())}
    VISITOR_COUNT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_player_views() -> dict[str, dict[str, object]]:
    if not PLAYER_VIEWS_PATH.exists():
        return {}
    try:
        raw = json.loads(PLAYER_VIEWS_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(raw, dict):
        return {}
    items = raw.get("items")
    return items if isinstance(items, dict) else {}


def _write_player_views(items: dict[str, dict[str, object]]) -> None:
    PLAYER_VIEWS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"updated_at": int(time.time()), "items": items}
    PLAYER_VIEWS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _views_last_hour(row: dict[str, object], now_ts: int | None = None) -> int:
    now = int(now_ts or time.time())
    events = row.get("recent_view_events")
    if not isinstance(events, list):
        return 0
    cnt = 0
    floor = now - 3600
    for ts in events:
        try:
            n = int(ts)
        except Exception:  # noqa: BLE001
            continue
        if n >= floor:
            cnt += 1
    return cnt


app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestSurfaceGuardMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_allow_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "HEAD", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
    max_age=86400,
)
app.add_middleware(APITokenMiddleware)
app.add_middleware(BodySizeLimitMiddleware)


@app.on_event("startup")
def _startup() -> None:
    ensure_env_loaded()
    ensure_automation_config_files()
    init_db()
    if not VISITOR_COUNT_PATH.exists():
        _write_visitor_count(0)
    if not PLAYER_VIEWS_PATH.exists():
        _write_player_views({})


@app.get("/health")
def health() -> dict[str, object]:
    need = bool((os.environ.get("U25_API_TOKEN") or "").strip())
    return {"status": "ok", "auth_required": need}


@app.get("/players")
def players(
    continent: str | None = Query(default=None),
    country: str | None = Query(default=None),
    position: str | None = Query(default=None),
    league: str | None = Query(default=None),
    sort_by: str | None = Query(default="minutes_played"),
    sort_order: str | None = Query(default="desc"),
    limit: int = Query(default=30),
    offset: int = Query(default=0),
) -> dict[str, object]:
    lim = clamp_int(limit, lo=1, hi=500, default=30)
    off = clamp_int(offset, lo=0, hi=2_000_000, default=0)
    rows = fetch_players(
        _scope(continent, country, position, league),
        sort_by=sanitize_sort_by(sort_by, default="minutes_played"),
        sort_order=sanitize_sort_order(sort_order, default="desc"),
        limit=lim,
        offset=off,
    )
    return {
        "count": len(rows),
        "items": rows,
        "offset": off,
        "limit": lim,
        "has_more": len(rows) == lim,
    }


@app.get("/players/{player_id}")
def player_detail(player_id: str, track_view: int = Query(default=1)) -> dict[str, object]:
    pid = sanitize_player_id(player_id)
    if not pid:
        return JSONResponse({"found": False, "player": None, "error": "invalid_player_id"}, status_code=400)
    rows = fetch_players({}, sort_by="minutes_played", sort_order="desc", limit=50000)
    p = next((x for x in rows if str(x.get("player_id")) == pid), None)
    if p is None:
        return {"found": False, "player": None}
    if int(track_view) == 1:
        with _PLAYER_VIEWS_LOCK:
            items = _read_player_views()
            key = str(pid)
            now = int(time.time())
            old = items.get(key) if isinstance(items.get(key), dict) else {}
            count = max(0, int(old.get("views", 0))) + 1
            recent = old.get("recent_view_events") if isinstance(old.get("recent_view_events"), list) else []
            recent2: list[int] = []
            floor = now - 3600
            for ts in recent[-500:]:
                try:
                    n = int(ts)
                except Exception:  # noqa: BLE001
                    continue
                if n >= floor:
                    recent2.append(n)
            recent2.append(now)
            items[key] = {
                "player_id": key,
                "name": p.get("name") or old.get("name") or "-",
                "country": p.get("country") or old.get("country") or "-",
                "club": p.get("club") or old.get("club") or "-",
                "position": p.get("position") or old.get("position") or "-",
                "age": p.get("age") if p.get("age") is not None else old.get("age"),
                "views": count,
                "last_viewed_at": now,
                "recent_view_events": recent2[-500:],
            }
            _write_player_views(items)
    return {"found": True, "player": p}


@app.get("/system/status")
def system_status() -> dict[str, object]:
    return fetch_system_status()


@app.get("/system/automation-status")
def automation_status() -> dict[str, object]:
    cfg = read_automation_config()
    schedule_times = list(cfg.get("schedule_times") or default_automation_dict()["schedule_times"])
    tz = str(cfg.get("timezone") or default_automation_dict().get("timezone") or "Asia/Seoul")
    default = {
        "last_run_slots": {},
        "last_success_ts": 0,
        "last_reason": "",
        "schedule_times": schedule_times,
    }
    payload = default
    if AUTO_STATE_PATH.exists():
        try:
            raw = json.loads(AUTO_STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                payload = {**default, **raw}
        except Exception:  # noqa: BLE001
            payload = default
    payload["schedule_times"] = schedule_times
    return {
        "schedule_times": schedule_times,
        "timezone": tz,
        "state": payload,
    }


def _admin_signal_for(path: Path) -> dict[str, object]:
    """운영 콘솔용: 파일 존재·크기·mtime만 노출(내용 없음)."""
    try:
        rel = str(path.resolve().relative_to(PROJECT_ROOT.resolve())).replace("\\", "/")
    except ValueError:
        rel = path.name
    out: dict[str, object] = {"path": rel, "exists": False}
    try:
        if path.exists():
            st = path.stat()
            out["exists"] = True
            out["size_bytes"] = int(st.st_size)
            out["mtime_unix"] = int(st.st_mtime)
    except OSError:
        out["error"] = True
    return out


@app.get("/system/admin-signals")
def admin_signals() -> dict[str, object]:
    """배치·피드·DB 갱신 여부를 mtime 기준으로 빠르게 확인합니다."""
    paths = [
        PROJECT_ROOT / "data" / "live_fixtures.json",
        PROJECT_ROOT / "data" / "marquee_live_fixtures.json",
        PROJECT_ROOT / "data" / "key_league_schedule.json",
        AUTO_STATE_PATH,
        COUNTRIES_JSON_PATH,
        DB_PATH,
    ]
    return {
        "server_time_unix": int(time.time()),
        "files": [_admin_signal_for(p) for p in paths],
    }


@app.get("/system/visitors")
def visitors(increment: int = Query(default=0)) -> dict[str, object]:
    do_increment = int(increment) == 1
    with _VISITOR_COUNT_LOCK:
        count = _read_visitor_count()
        if do_increment:
            count += 1
            _write_visitor_count(count)
        return {
            "count": count,
            "incremented": do_increment,
        }


@app.get("/analytics/most-viewed")
def most_viewed_players(limit: int = Query(default=10)) -> dict[str, object]:
    lim = clamp_int(limit, lo=1, hi=50, default=10)
    with _PLAYER_VIEWS_LOCK:
        items = _read_player_views()
    rows = [x for x in items.values() if isinstance(x, dict)]
    rows.sort(
        key=lambda x: (
            int(x.get("views", 0) or 0),
            int(x.get("last_viewed_at", 0) or 0),
        ),
        reverse=True,
    )
    out = []
    now = int(time.time())
    for r in rows[:lim]:
        row = dict(r)
        row["views_1h"] = _views_last_hour(r, now)
        out.append(row)
    return {"count": len(rows), "items": out}


@app.get("/analytics/trending-hour")
def trending_hour_players(limit: int = Query(default=10)) -> dict[str, object]:
    lim = clamp_int(limit, lo=1, hi=50, default=10)
    with _PLAYER_VIEWS_LOCK:
        items = _read_player_views()
    rows = [x for x in items.values() if isinstance(x, dict)]
    now = int(time.time())
    ranked = []
    for r in rows:
        row = dict(r)
        row["views_1h"] = _views_last_hour(r, now)
        ranked.append(row)
    ranked.sort(
        key=lambda x: (
            int(x.get("views_1h", 0) or 0),
            int(x.get("views", 0) or 0),
            int(x.get("last_viewed_at", 0) or 0),
        ),
        reverse=True,
    )
    return {"count": len(ranked), "items": ranked[:lim]}


@app.get("/filters/options")
def filter_options(
    continent: str | None = Query(default=None),
    country: str | None = Query(default=None),
    position: str | None = Query(default=None),
    league: str | None = Query(default=None),
) -> dict[str, object]:
    payload = fetch_filter_options(_scope(continent, country, position, league))
    return payload


class BestMatchRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    continent: str | None = None
    country: str | None = None
    position: str | None = None
    league: str | None = None
    selected_metrics: list[str] = []
    metric_ranges: dict[str, dict[str, float | int]] = {}
    limit: int = Field(default=30, ge=1, le=100)


def _finite_num(v: object) -> float | None:
    try:
        x = float(v)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        return None
    if x != x or abs(x) > 1e12:  # NaN / absurd
        return None
    return x


def _normalized_metric_ranges(raw: dict[str, dict[str, float | int]] | None) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    if not raw:
        return out
    for i, (alias, rule) in enumerate(raw.items()):
        if i >= 48:
            break
        if not isinstance(alias, str):
            continue
        key_alias = sanitize_query_value(alias, max_len=64)
        if key_alias not in _METRIC_KEY_MAP:
            continue
        if not isinstance(rule, dict):
            continue
        lo = _finite_num(rule.get("min"))
        hi = _finite_num(rule.get("max"))
        cell: dict[str, float] = {}
        if lo is not None:
            cell["min"] = lo
        if hi is not None:
            cell["max"] = hi
        if cell:
            out[key_alias] = cell
    return out


@app.get("/analytics/overview")
def analytics_overview(
    continent: str | None = Query(default=None),
    country: str | None = Query(default=None),
    position: str | None = Query(default=None),
    league: str | None = Query(default=None),
) -> dict[str, object]:
    return fetch_analytics(_scope(continent, country, position, league))


@app.get("/analytics/advanced")
def analytics_advanced(
    continent: str | None = Query(default=None),
    country: str | None = Query(default=None),
    position: str | None = Query(default=None),
    league: str | None = Query(default=None),
) -> dict[str, object]:
    return fetch_advanced_analytics(_scope(continent, country, position, league))


@app.get("/analytics/hidden-player")
def analytics_hidden_player(
    continent: str | None = Query(default=None),
    country: str | None = Query(default=None),
    position: str | None = Query(default=None),
    league: str | None = Query(default=None),
) -> dict[str, object]:
    rows = fetch_players(_scope(continent, country, position, league), sort_by="minutes_played", sort_order="desc", limit=5000)
    if not rows:
        return {"found": False, "player": None}

    scored = sorted(
        ({"p": p, "s": _hidden_reco_score(p)} for p in rows),
        key=lambda x: float(x["s"]),
        reverse=True,
    )
    pool_size = max(8, min(40, len(scored)))
    pool = scored[:pool_size]
    picked = random.choice(pool)
    p = picked["p"]
    score = float(picked["s"])

    return {
        "found": True,
        "generated_at": int(time.time()),
        "hidden_score": round(score, 2),
        "player": {
            **_spotlight_payload(p),
            "minutes_played": p.get("minutes_played"),
            "hidden_score": round(score, 2),
        },
        "reason": {
            "minutes_played": int(float(p.get("minutes_played") or 0)),
            "goals": float(p.get("goals") or 0),
            "assists": float(p.get("assists") or 0),
            "space_creation_count": float(p.get("space_creation_count") or 0),
        },
    }


@app.get("/rankings/top30")
def rankings_top30(
    position: str | None = Query(default=None),
    continent: str | None = Query(default=None),
    country: str | None = Query(default=None),
    league: str | None = Query(default=None),
) -> dict[str, object]:
    f = _scope(continent, country, position, league)
    rows = fetch_rankings(
        position=f["position"] or None,
        continent=f["continent"] or None,
        country=f["country"] or None,
        league=f["league"] or None,
        limit=30,
    )
    return {"count": len(rows), "items": rows}


@app.post("/scouting/best-match")
def scouting_best_match(req: BestMatchRequest) -> dict[str, object]:
    selected = [m for m in (req.selected_metrics or []) if isinstance(m, str) and m in _METRIC_KEY_MAP][:32]
    if not selected:
        selected = ["pass_success", "duel_success", "shot_accuracy", "goals", "assists", "space_creation"]

    players = fetch_players(_scope(req.continent, req.country, req.position, req.league))
    if not players:
        return {"count": 0, "top_player": None, "items": []}

    metric_ranges = _normalized_metric_ranges(req.metric_ranges)

    # Apply metric min/max filters first.
    filtered: list[dict[str, object]] = []
    for p in players:
        ok = True
        for metric_alias, rule in metric_ranges.items():
            key = _METRIC_KEY_MAP.get(metric_alias)
            if not key:
                continue
            value = float(p.get(key) or 0.0)
            lo = rule.get("min")
            hi = rule.get("max")
            if lo is not None and value < float(lo):
                ok = False
                break
            if hi is not None and value > float(hi):
                ok = False
                break
        if ok:
            filtered.append(p)

    if not filtered:
        return {"count": 0, "top_player": None, "items": []}

    # Min-max normalize selected metrics to percentile-like score.
    ranges: dict[str, tuple[float, float]] = {}
    for m in selected:
        key = _METRIC_KEY_MAP[m]
        vals = [float(x.get(key) or 0.0) for x in filtered]
        ranges[m] = (min(vals), max(vals))

    scored: list[dict[str, object]] = []
    for p in filtered:
        metric_score: dict[str, float] = {}
        total = 0.0
        for m in selected:
            key = _METRIC_KEY_MAP[m]
            value = float(p.get(key) or 0.0)
            lo, hi = ranges[m]
            if hi - lo <= 1e-9:
                s = 100.0
            else:
                if m in _LOWER_IS_BETTER:
                    s = ((hi - value) / (hi - lo)) * 100.0
                else:
                    s = ((value - lo) / (hi - lo)) * 100.0
            s = max(0.0, min(100.0, s))
            metric_score[m] = round(s, 2)
            total += s
        match_percent = round(total / max(1, len(selected)), 2)
        scored.append(
            {
                "player_id": p.get("player_id"),
                "name": p.get("name"),
                "country": p.get("country"),
                "club": p.get("club"),
                "league": p.get("league"),
                "position": p.get("position"),
                "match_percent": match_percent,
                "metrics": metric_score,
            }
        )

    scored.sort(key=lambda x: float(x["match_percent"]), reverse=True)
    limited = scored[: max(1, min(100, req.limit))]
    return {"count": len(limited), "top_player": limited[0] if limited else None, "items": limited}


@app.get("/scouting/spotlight")
def scouting_spotlight(
    continent: str | None = Query(default=None),
    country: str | None = Query(default=None),
    position: str | None = Query(default=None),
    league: str | None = Query(default=None),
) -> dict[str, object]:
    players = fetch_players(
        _scope(continent, country, position, league),
        sort_by="minutes_played",
        sort_order="desc",
        limit=5000,
    )
    if not players:
        return {"found": False, "player": None}

    ranked = sorted(players, key=_spotlight_score, reverse=True)
    top = ranked[0]
    return {"found": True, "player": _spotlight_payload(top)}


@app.get("/scouting/spotlight-top5")
def scouting_spotlight_top5() -> dict[str, object]:
    cap = clamp_int(50_000, lo=1, hi=15_000, default=15_000)
    players = fetch_players({}, sort_by="minutes_played", sort_order="desc", limit=cap)
    if not players:
        return {"results": 0, "items": {}}

    buckets: dict[str, list[dict[str, object]]] = {}
    for p in players:
        continent = str(p.get("continent") or "Other")
        if continent == "Other":
            continue
        buckets.setdefault(continent, []).append(p)

    out: dict[str, list[dict[str, object]]] = {}
    for continent, rows in buckets.items():
        ranked = sorted(rows, key=_spotlight_score, reverse=True)[:5]
        out[continent] = [_spotlight_payload(x) for x in ranked]

    return {"results": len(out), "items": out}


@app.get("/scouting/spotlight-top-global")
def scouting_spotlight_top_global(limit: int = Query(default=5)) -> dict[str, object]:
    lim = clamp_int(limit, lo=1, hi=20, default=5)
    players = fetch_players({}, sort_by="minutes_played", sort_order="desc", limit=15_000)
    if not players:
        return {"results": 0, "items": []}
    ranked = sorted(players, key=_spotlight_score, reverse=True)[:lim]
    return {"results": len(ranked), "items": [_spotlight_payload(x) for x in ranked]}


@app.get("/live/marquee")
def live_marquee() -> dict[str, object]:
    if not MARQUEE_PATH.exists():
        return {"updated_at": 0, "results": 0, "response": []}
    try:
        return json.loads(MARQUEE_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"updated_at": 0, "results": 0, "response": []}


@app.get("/schedule/key-leagues")
def key_league_schedule() -> dict[str, object]:
    if not KEY_SCHEDULE_PATH.exists():
        return {"updated_at": 0, "results": 0, "response": []}
    try:
        return json.loads(KEY_SCHEDULE_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"updated_at": 0, "results": 0, "response": []}


@app.get("/adaptation/{player_id}")
def adaptation(player_id: str) -> dict[str, object]:
    pid = sanitize_player_id(player_id)
    if not pid:
        return JSONResponse({"found": False, "player_id": player_id, "matrix": [], "error": "invalid_player_id"}, status_code=400)
    players = fetch_players({}, sort_by="minutes_played", sort_order="desc", limit=50000)
    player = next((p for p in players if str(p["player_id"]) == pid), None)
    if player is None:
        return {"found": False, "player_id": pid, "matrix": []}
    return {
        "found": True,
        "player_id": pid,
        "name": player["name"],
        "current_league": player["league"],
        "matrix": league_adaptation_matrix(player),
    }
