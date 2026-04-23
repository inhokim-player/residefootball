from __future__ import annotations

import random
import time
from typing import Any

from scouting.football_client import FootballAPIClient
from scouting.notifications import notify_info, notify_warning
from scouting.u25_models import PlayerSnapshot

POSITIONS = ["FW", "MF", "DF", "GK"]
LEAGUES = [
    "Premier League",
    "La Liga",
    "Serie A",
    "Bundesliga",
    "Ligue 1",
    "Eredivisie",
    "Primeira Liga",
    "MLS",
    "J1 League",
    "K League 1",
]
CONTINENT_BY_COUNTRY = {
    "England": "Europe",
    "Spain": "Europe",
    "Italy": "Europe",
    "Germany": "Europe",
    "France": "Europe",
    "Brazil": "South America",
    "Argentina": "South America",
    "Japan": "Asia",
    "Korea": "Asia",
    "USA": "North America",
    "Nigeria": "Africa",
    "Egypt": "Africa",
}


def _norm(value: float, low: float, high: float) -> float:
    return round(max(low, min(high, value)), 2)


def _from_country(country: str, idx: int) -> PlayerSnapshot:
    rnd = random.Random(f"{country}-{idx}")
    age = rnd.randint(17, 24)
    minutes = rnd.randint(350, 3200)
    pass_attempts = rnd.randint(80, 2200)
    pass_success = _norm(rnd.uniform(62, 94), 0, 100)
    pass_miss = max(0, int(pass_attempts * (1 - pass_success / 100)))
    duel_win = _norm(rnd.uniform(38, 79), 0, 100)
    shot_attempts = rnd.randint(5, 140)
    shot_accuracy = _norm(rnd.uniform(22, 71), 0, 100)
    goals = rnd.randint(0, 28)
    assists = rnd.randint(0, 18)
    ball_rec = rnd.randint(3, 220)
    tackle = _norm(rnd.uniform(30, 84), 0, 100)
    intercept = _norm(rnd.uniform(28, 82), 0, 100)
    after80_pass = _norm(rnd.uniform(45, 92), 0, 100)
    after80_attack = _norm(rnd.uniform(35, 88), 0, 100)
    after80_goals = rnd.randint(0, min(10, goals))
    after80_assists = rnd.randint(0, min(8, assists))
    space_creation = rnd.randint(0, 90)
    dribble_rate = _norm(rnd.uniform(30, 86), 0, 100)
    dribble_success = int((dribble_rate / 100) * rnd.randint(5, 180))
    physical = _norm(rnd.uniform(45, 95), 0, 100)
    sprint = _norm(rnd.uniform(26.1, 36.5), 0, 50)
    distance_km = _norm(rnd.uniform(7.1, 13.8), 0, 20)
    injuries = rnd.randint(0, 6)
    continent = CONTINENT_BY_COUNTRY.get(country, "Other")
    pos = rnd.choice(POSITIONS)
    league = rnd.choice(LEAGUES)
    club = f"{country} FC {idx % 40 + 1}"
    return PlayerSnapshot(
        player_id=f"{country.lower().replace(' ', '_')}_{idx}",
        name=f"{country} U25 Player {idx}",
        photo_url=f"https://ui-avatars.com/api/?name={country}%20U25%20{idx}&background=0f1419&color=e8eef5",
        country=country,
        continent=continent,
        club=club,
        league=league,
        position=pos,
        age=age,
        height_cm=_norm(rnd.uniform(165, 198), 150, 220),
        weight_kg=_norm(rnd.uniform(58, 95), 45, 130),
        physical_index=physical,
        sprint_speed=sprint,
        distance_per_match_km=distance_km,
        minutes_played=minutes,
        pass_attempts=pass_attempts,
        pass_success_rate=pass_success,
        pass_miss=pass_miss,
        duel_win_rate=duel_win,
        duel_successes=int((duel_win / 100) * rnd.randint(20, 220)),
        shot_attempts=shot_attempts,
        shot_accuracy=shot_accuracy,
        goals=goals,
        assists=assists,
        ball_recoveries=ball_rec,
        tackle_success_rate=tackle,
        intercept_success_rate=intercept,
        after80_pass_success_rate=after80_pass,
        after80_attack_success_rate=after80_attack,
        after80_goals=after80_goals,
        after80_assists=after80_assists,
        space_creation_count=space_creation,
        dribble_success_rate=dribble_rate,
        dribble_success_count=dribble_success,
        injuries_count=injuries,
    )


def _country_list_from_api(client: FootballAPIClient) -> list[str]:
    result = client.fetch_countries_merged()
    if not result.success or not result.data:
        notify_warning("국가 API 수집 실패: 내장 국가 샘플로 대체합니다.", technical_detail=result.technical_detail)
        return list(CONTINENT_BY_COUNTRY.keys())

    response = result.data.get("response") or []
    countries: list[str] = []
    for row in response:
        name = (row or {}).get("name")
        if name and name != "World":
            countries.append(str(name))
    if not countries:
        return list(CONTINENT_BY_COUNTRY.keys())
    return countries[:120]


def fetch_global_u25_players(*, per_country: int = 8) -> list[PlayerSnapshot]:
    client = FootballAPIClient()
    countries = _country_list_from_api(client)
    snapshots: list[PlayerSnapshot] = []
    start = int(time.time()) % 10000
    for c in countries:
        for i in range(per_country):
            snapshots.append(_from_country(c, start + i))
    notify_info(f"U25 글로벌 선수 샘플 {len(snapshots)}명 생성/수집 완료")
    return snapshots
