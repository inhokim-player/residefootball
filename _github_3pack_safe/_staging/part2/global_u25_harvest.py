from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from scouting.football_client import FootballAPIClient
from scouting.notifications import notify_failure, notify_info, notify_warning
from scouting.u25_database import init_db, upsert_players
from scouting.u25_models import PlayerSnapshot

PROJECT_ROOT = Path(__file__).resolve().parent
CHECKPOINT_PATH = PROJECT_ROOT / "data" / "global_harvest_checkpoint.json"
FAILED_PATH = PROJECT_ROOT / "data" / "global_harvest_failed_teams.json"


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _continent(country: str) -> str:
    c = (country or "").lower().strip()
    europe = {
        "england", "spain", "italy", "germany", "france", "netherlands", "portugal", "belgium",
        "switzerland", "austria", "scotland", "wales", "ireland", "northern ireland", "poland",
        "czech republic", "slovakia", "slovenia", "croatia", "serbia", "bosnia", "montenegro",
        "albania", "north macedonia", "greece", "turkey", "ukraine", "romania", "bulgaria",
        "hungary", "denmark", "sweden", "norway", "finland", "iceland", "estonia", "latvia",
        "lithuania", "belarus", "moldova", "russia", "georgia", "armenia", "azerbaijan", "cyprus",
        "luxembourg", "malta", "kosovo",
    }
    south_america = {
        "brazil", "argentina", "uruguay", "chile", "colombia", "peru", "ecuador",
        "paraguay", "bolivia", "venezuela", "guyana", "suriname",
    }
    north_america = {
        "usa", "united states", "canada", "mexico", "costa rica", "panama", "jamaica",
        "honduras", "guatemala", "el salvador", "nicaragua", "trinidad and tobago",
        "haiti", "dominican republic",
    }
    asia = {
        "japan", "korea republic", "south korea", "korea", "china", "australia", "new zealand",
        "saudi arabia", "qatar", "uae", "united arab emirates", "iran", "iraq", "uzbekistan",
        "jordan", "oman", "bahrain", "kuwait", "india", "indonesia", "thailand", "vietnam",
        "malaysia", "singapore", "philippines",
    }
    africa = {
        "nigeria", "egypt", "morocco", "senegal", "south africa", "ghana", "ivory coast",
        "cameroon", "algeria", "tunisia", "mali", "burkina faso", "guinea", "uganda",
        "kenya", "tanzania", "zambia", "angola", "dr congo", "congo", "gabon",
    }

    if c in europe:
        return "Europe"
    if c in south_america:
        return "South America"
    if c in north_america:
        return "North America"
    if c in asia:
        return "Asia"
    if c in africa:
        return "Africa"

    # Common aliases fallback
    if "united kingdom" in c:
        return "Europe"
    if "korea" in c:
        return "Asia"
    if "united states" in c:
        return "North America"
    return "Other"


def _norm(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, float(value)))


def _parse_measure_to_float(raw: Any) -> float:
    text = str(raw or "").strip().lower()
    if not text:
        return 0.0
    token = text.replace("cm", "").replace("kg", "").strip()
    try:
        return float(token)
    except Exception:  # noqa: BLE001
        return 0.0


def _parse_dominant_foot(player: dict[str, Any], stat: dict[str, Any]) -> str:
    candidates = [
        player.get("foot"),
        player.get("dominant_foot"),
        player.get("preferred_foot"),
        stat.get("foot"),
        stat.get("dominant_foot"),
        stat.get("preferred_foot"),
    ]
    for value in candidates:
        v = str(value or "").strip()
        if not v:
            continue
        lower = v.lower()
        if lower in {"left", "left-footed", "l"}:
            return "Left"
        if lower in {"right", "right-footed", "r"}:
            return "Right"
        if lower in {"both", "either", "ambi", "ambidextrous"}:
            return "Both"
        return v.title()
    return "Unknown"


def _to_snapshot(
    *,
    player_row: dict[str, Any],
    stat_row: dict[str, Any],
    country: str,
    league_name: str,
    club_name: str,
) -> PlayerSnapshot | None:
    player = player_row.get("player") or {}
    stats = stat_row.get("statistics") or []
    if not stats:
        return None
    s = stats[0]
    age = int(player.get("age") or 99)
    if age >= 25:
        return None

    games = s.get("games") or {}
    passes = s.get("passes") or {}
    shots = s.get("shots") or {}
    goals_d = s.get("goals") or {}
    tackles = s.get("tackles") or {}
    dribbles = s.get("dribbles") or {}
    duels = s.get("duels") or {}

    minutes = int(games.get("minutes") or 0)
    pass_attempts = int(passes.get("total") or 0)
    pass_success = _norm(passes.get("accuracy") or 0)
    pass_miss = max(0, pass_attempts - int(passes.get("key") or 0))
    duel_total = int(duels.get("total") or 0)
    duel_won = int(duels.get("won") or 0)
    duel_rate = _norm((duel_won / duel_total) * 100 if duel_total > 0 else 0)
    shot_attempts = int(shots.get("total") or 0)
    shot_on = int(shots.get("on") or 0)
    shot_accuracy = _norm((shot_on / shot_attempts) * 100 if shot_attempts > 0 else 0)
    goals = int(goals_d.get("total") or 0)
    assists = int(goals_d.get("assists") or 0)
    tackle_total = int(tackles.get("total") or 0)
    tackle_interceptions = int(tackles.get("interceptions") or 0)
    tackle_rate = _norm((int(tackles.get("blocks") or 0) / tackle_total) * 100 if tackle_total > 0 else 0)
    intercept_rate = _norm((tackle_interceptions / max(1, minutes / 90)) * 10)
    dribble_total = int(dribbles.get("attempts") or 0)
    dribble_success = int(dribbles.get("success") or 0)
    dribble_rate = _norm((dribble_success / dribble_total) * 100 if dribble_total > 0 else 0)

    position = str(games.get("position") or "FW")
    speed_base = 28.5 if position.startswith("DF") else 30.5
    physical_base = 62.0 if position.startswith("MF") else 68.0

    height_cm = _parse_measure_to_float(player.get("height"))
    weight_kg = _parse_measure_to_float(player.get("weight"))
    raw_country = str(country or player.get("nationality") or "").strip()
    normalized_country = raw_country if raw_country and raw_country.lower() != "unknown" else "Unassigned"
    return PlayerSnapshot(
        player_id=str(player.get("id")),
        name=str(player.get("name") or ""),
        photo_url=str(player.get("photo") or ""),
        country=normalized_country,
        continent=_continent(normalized_country),
        club=club_name,
        league=league_name,
        position=position,
        age=age,
        height_cm=height_cm,
        weight_kg=weight_kg,
        dominant_foot=_parse_dominant_foot(player, s),
        physical_index=_norm(physical_base + duel_rate * 0.25 + tackle_rate * 0.2),
        sprint_speed=_norm(speed_base + dribble_rate * 0.06, 20, 40),
        distance_per_match_km=_norm(8 + (minutes / max(1, int(games.get("appearences") or 1))) / 30, 5, 14),
        minutes_played=minutes,
        pass_attempts=pass_attempts,
        pass_success_rate=pass_success,
        pass_miss=pass_miss,
        duel_win_rate=duel_rate,
        duel_successes=duel_won,
        shot_attempts=shot_attempts,
        shot_accuracy=shot_accuracy,
        goals=goals,
        assists=assists,
        ball_recoveries=tackle_interceptions + tackle_total,
        tackle_success_rate=tackle_rate,
        intercept_success_rate=intercept_rate,
        after80_pass_success_rate=_norm(pass_success * 0.95),
        after80_attack_success_rate=_norm((dribble_rate * 0.45) + (shot_accuracy * 0.55)),
        after80_goals=max(0, int(goals * 0.25)),
        after80_assists=max(0, int(assists * 0.25)),
        space_creation_count=int(passes.get("key") or 0),
        dribble_success_rate=dribble_rate,
        dribble_success_count=dribble_success,
        injuries_count=0,
    )


def _fetch_countries(client: FootballAPIClient) -> list[dict[str, Any]]:
    result = client.get_json("/countries")
    if not result.success or not result.data:
        return []
    return list(result.data.get("response") or [])


def _fetch_leagues_by_country(client: FootballAPIClient, country: str, season: int) -> list[dict[str, Any]]:
    result = client.get_json("/leagues", params={"country": country, "season": season})
    if not result.success or not result.data:
        return []
    return list(result.data.get("response") or [])


def _fetch_teams(client: FootballAPIClient, league_id: int, season: int) -> list[dict[str, Any]]:
    result = client.get_json("/teams", params={"league": league_id, "season": season})
    if not result.success or not result.data:
        return []
    return list(result.data.get("response") or [])


def _fetch_team_players(client: FootballAPIClient, team_id: int, league_id: int, season: int) -> list[dict[str, Any]]:
    page = 1
    merged: list[dict[str, Any]] = []
    while True:
        result = client.get_json(
            "/players",
            params={"team": team_id, "league": league_id, "season": season, "page": page},
        )
        if not result.success or not result.data:
            break
        body = result.data
        merged.extend(list(body.get("response") or []))
        paging = body.get("paging") or {}
        current = int(paging.get("current") or page)
        total = int(paging.get("total") or 1)
        if current >= total:
            break
        page += 1
        time.sleep(0.2)
    return merged


def harvest_global_u25(*, season: int, max_countries: int | None = None, delay_sec: float = 0.2) -> int:
    init_db()
    client = FootballAPIClient()
    checkpoint = _read_json(CHECKPOINT_PATH, {"country_index": 0, "country": "", "league": 0, "team": 0})
    failed = _read_json(FAILED_PATH, [])

    countries = _fetch_countries(client)
    if max_countries is not None:
        countries = countries[: max(1, max_countries)]
    if not countries:
        notify_failure("국가 목록을 가져오지 못했습니다.")
        return 1

    start_idx = int(checkpoint.get("country_index") or 0)
    total_players = 0
    for i in range(start_idx, len(countries)):
        country_name = str((countries[i] or {}).get("name") or "")
        if not country_name or country_name == "World":
            continue
        notify_info(f"[{i + 1}/{len(countries)}] 국가 수집 시작: {country_name}")
        leagues = _fetch_leagues_by_country(client, country_name, season)
        for l in leagues:
            league = l.get("league") or {}
            league_id = int(league.get("id") or 0)
            league_name = str(league.get("name") or "Unknown League")
            if league_id <= 0:
                continue
            teams = _fetch_teams(client, league_id, season)
            for t in teams:
                team = t.get("team") or {}
                team_id = int(team.get("id") or 0)
                club_name = str(team.get("name") or "Unknown Club")
                if team_id <= 0:
                    continue
                try:
                    raw_players = _fetch_team_players(client, team_id, league_id, season)
                    snapshots: list[PlayerSnapshot] = []
                    for row in raw_players:
                        s = _to_snapshot(
                            player_row=row,
                            stat_row=row,
                            country=country_name,
                            league_name=league_name,
                            club_name=club_name,
                        )
                        if s is not None:
                            snapshots.append(s)
                    upsert_players(snapshots)
                    total_players += len(snapshots)
                    notify_info(
                        f"{country_name} | {league_name} | {club_name} -> U25 {len(snapshots)}명 저장 (누적 {total_players})"
                    )
                except Exception as exc:  # noqa: BLE001
                    failed.append(
                        {
                            "country": country_name,
                            "league_id": league_id,
                            "league_name": league_name,
                            "team_id": team_id,
                            "team_name": club_name,
                            "error": repr(exc),
                        }
                    )
                    notify_warning("팀 선수 수집 실패", technical_detail=repr(exc))

                _write_json(
                    CHECKPOINT_PATH,
                    {
                        "country_index": i,
                        "country": country_name,
                        "league": league_id,
                        "team": team_id,
                        "season": season,
                        "saved_players": total_players,
                    },
                )
                _write_json(FAILED_PATH, failed)
                time.sleep(max(0.05, delay_sec))

    notify_info(f"전세계 U25 수집 완료: 총 {total_players}명")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="전세계(국가/리그/팀 전체) U25 선수 수집")
    parser.add_argument("--season", type=int, default=2025, help="수집 시즌")
    parser.add_argument("--max-countries", type=int, default=None, help="테스트용 국가 수 제한")
    parser.add_argument("--delay", type=float, default=0.2, help="요청 간 딜레이(초)")
    args = parser.parse_args()
    return harvest_global_u25(
        season=args.season,
        max_countries=args.max_countries,
        delay_sec=max(0.05, args.delay),
    )


if __name__ == "__main__":
    raise SystemExit(main())
