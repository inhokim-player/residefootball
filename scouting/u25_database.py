from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from scouting.u25_models import PlayerSnapshot

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "data" / "u25_scouting.db"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Data integrity first: durable commits and FK enforcement.
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db() -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS players_u25 (
                player_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                photo_url TEXT NOT NULL DEFAULT '',
                country TEXT NOT NULL,
                continent TEXT NOT NULL,
                club TEXT NOT NULL,
                league TEXT NOT NULL,
                position TEXT NOT NULL,
                age INTEGER NOT NULL,
                height_cm REAL NOT NULL,
                weight_kg REAL NOT NULL,
                dominant_foot TEXT NOT NULL DEFAULT 'Unknown',
                physical_index REAL NOT NULL,
                sprint_speed REAL NOT NULL,
                distance_per_match_km REAL NOT NULL,
                minutes_played INTEGER NOT NULL,
                pass_attempts INTEGER NOT NULL,
                pass_success_rate REAL NOT NULL,
                pass_miss INTEGER NOT NULL,
                duel_win_rate REAL NOT NULL,
                duel_successes INTEGER NOT NULL,
                shot_attempts INTEGER NOT NULL,
                shot_accuracy REAL NOT NULL,
                goals INTEGER NOT NULL,
                assists INTEGER NOT NULL,
                ball_recoveries INTEGER NOT NULL,
                tackle_success_rate REAL NOT NULL,
                intercept_success_rate REAL NOT NULL,
                after80_pass_success_rate REAL NOT NULL,
                after80_attack_success_rate REAL NOT NULL,
                after80_goals INTEGER NOT NULL,
                after80_assists INTEGER NOT NULL,
                space_creation_count INTEGER NOT NULL,
                dribble_success_rate REAL NOT NULL,
                dribble_success_count INTEGER NOT NULL,
                injuries_count INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scouting_scores (
                player_id TEXT PRIMARY KEY,
                league TEXT NOT NULL,
                position TEXT NOT NULL,
                performance_score REAL NOT NULL,
                potential_score REAL NOT NULL,
                adaptation_probability REAL NOT NULL,
                total_rank_score REAL NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(player_id) REFERENCES players_u25(player_id)
            )
            """
        )
        # Backward-compatible migration for existing DBs created before photo_url was added.
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(players_u25)").fetchall()]
        if "photo_url" not in cols:
            conn.execute("ALTER TABLE players_u25 ADD COLUMN photo_url TEXT NOT NULL DEFAULT ''")
        if "dominant_foot" not in cols:
            conn.execute("ALTER TABLE players_u25 ADD COLUMN dominant_foot TEXT NOT NULL DEFAULT 'Unknown'")
        conn.commit()
    finally:
        conn.close()


def upsert_players(players: list[PlayerSnapshot]) -> None:
    if not players:
        return
    conn = _connect()
    try:
        conn.executemany(
            """
            INSERT INTO players_u25 (
                player_id, name, photo_url, country, continent, club, league, position, age,
                height_cm, weight_kg, dominant_foot, physical_index, sprint_speed, distance_per_match_km,
                minutes_played, pass_attempts, pass_success_rate, pass_miss,
                duel_win_rate, duel_successes, shot_attempts, shot_accuracy,
                goals, assists, ball_recoveries, tackle_success_rate, intercept_success_rate,
                after80_pass_success_rate, after80_attack_success_rate, after80_goals,
                after80_assists, space_creation_count, dribble_success_rate, dribble_success_count,
                injuries_count, updated_at
            ) VALUES (
                :player_id, :name, :photo_url, :country, :continent, :club, :league, :position, :age,
                :height_cm, :weight_kg, :dominant_foot, :physical_index, :sprint_speed, :distance_per_match_km,
                :minutes_played, :pass_attempts, :pass_success_rate, :pass_miss,
                :duel_win_rate, :duel_successes, :shot_attempts, :shot_accuracy,
                :goals, :assists, :ball_recoveries, :tackle_success_rate, :intercept_success_rate,
                :after80_pass_success_rate, :after80_attack_success_rate, :after80_goals,
                :after80_assists, :space_creation_count, :dribble_success_rate, :dribble_success_count,
                :injuries_count, CURRENT_TIMESTAMP
            )
            ON CONFLICT(player_id) DO UPDATE SET
                name=excluded.name,
                photo_url=excluded.photo_url,
                country=CASE
                    WHEN excluded.country IS NOT NULL
                         AND TRIM(excluded.country) != ''
                         AND LOWER(TRIM(excluded.country)) != 'unknown'
                    THEN excluded.country
                    ELSE players_u25.country
                END,
                continent=excluded.continent,
                club=excluded.club,
                league=excluded.league,
                position=excluded.position,
                age=excluded.age,
                height_cm=CASE
                    WHEN excluded.height_cm > 0 THEN excluded.height_cm
                    ELSE players_u25.height_cm
                END,
                weight_kg=CASE
                    WHEN excluded.weight_kg > 0 THEN excluded.weight_kg
                    ELSE players_u25.weight_kg
                END,
                dominant_foot=CASE
                    WHEN excluded.dominant_foot IS NOT NULL
                         AND excluded.dominant_foot != ''
                         AND excluded.dominant_foot != 'Unknown'
                    THEN excluded.dominant_foot
                    ELSE players_u25.dominant_foot
                END,
                physical_index=excluded.physical_index,
                sprint_speed=excluded.sprint_speed,
                distance_per_match_km=excluded.distance_per_match_km,
                minutes_played=excluded.minutes_played,
                pass_attempts=excluded.pass_attempts,
                pass_success_rate=excluded.pass_success_rate,
                pass_miss=excluded.pass_miss,
                duel_win_rate=excluded.duel_win_rate,
                duel_successes=excluded.duel_successes,
                shot_attempts=excluded.shot_attempts,
                shot_accuracy=excluded.shot_accuracy,
                goals=excluded.goals,
                assists=excluded.assists,
                ball_recoveries=excluded.ball_recoveries,
                tackle_success_rate=excluded.tackle_success_rate,
                intercept_success_rate=excluded.intercept_success_rate,
                after80_pass_success_rate=excluded.after80_pass_success_rate,
                after80_attack_success_rate=excluded.after80_attack_success_rate,
                after80_goals=excluded.after80_goals,
                after80_assists=excluded.after80_assists,
                space_creation_count=excluded.space_creation_count,
                dribble_success_rate=excluded.dribble_success_rate,
                dribble_success_count=excluded.dribble_success_count,
                injuries_count=excluded.injuries_count,
                updated_at=CURRENT_TIMESTAMP
            """,
            [p.__dict__ for p in players],
        )
        conn.commit()
    finally:
        conn.close()


def replace_scores(rows: list[dict[str, Any]]) -> None:
    conn = _connect()
    try:
        conn.execute("DELETE FROM scouting_scores")
        if rows:
            conn.executemany(
                """
                INSERT INTO scouting_scores (
                    player_id, league, position, performance_score, potential_score,
                    adaptation_probability, total_rank_score, updated_at
                ) VALUES (
                    :player_id, :league, :position, :performance_score, :potential_score,
                    :adaptation_probability, :total_rank_score, CURRENT_TIMESTAMP
                )
                """,
                rows,
            )
        conn.commit()
    finally:
        conn.close()


def fetch_players(
    filters: dict[str, str] | None = None,
    *,
    sort_by: str = "minutes_played",
    sort_order: str = "desc",
    limit: int = 50000,
    offset: int = 0,
) -> list[dict[str, Any]]:
    filters = filters or {}
    q = """
        SELECT *
        FROM players_u25
        WHERE age < 25
          AND name NOT LIKE '%U25 Player %'
          AND instr(player_id, '_') = 0
    """
    args: list[Any] = []
    if filters.get("continent"):
        q += " AND continent = ?"
        args.append(filters["continent"])
    if filters.get("country"):
        q += " AND country = ?"
        args.append(filters["country"])
    if filters.get("position"):
        q += " AND position = ?"
        args.append(filters["position"])
    if filters.get("league"):
        q += " AND league = ?"
        args.append(filters["league"])
    sortable = {
        "minutes_played",
        "pass_success_rate",
        "duel_win_rate",
        "shot_accuracy",
        "shot_attempts",
        "pass_attempts",
        "goals",
        "assists",
        "physical_index",
        "sprint_speed",
        "distance_per_match_km",
        "tackle_success_rate",
        "intercept_success_rate",
        "space_creation_count",
        "dribble_success_rate",
        "age",
        "height_cm",
        "weight_kg",
    }
    key = sort_by if sort_by in sortable else "minutes_played"
    order = "ASC" if str(sort_order).lower() == "asc" else "DESC"
    q += f" ORDER BY {key} {order} LIMIT ? OFFSET ?"
    lim = max(1, min(50000, int(limit)))
    off = max(0, int(offset))
    args.append(lim)
    args.append(off)

    conn = _connect()
    try:
        return [dict(r) for r in conn.execute(q, args).fetchall()]
    finally:
        conn.close()


def fetch_rankings(
    *,
    position: str | None = None,
    continent: str | None = None,
    country: str | None = None,
    league: str | None = None,
    limit: int = 30,
) -> list[dict[str, Any]]:
    q = """
        SELECT s.*, p.name, p.photo_url, p.country, p.continent, p.club, p.age
        FROM scouting_scores s
        JOIN players_u25 p ON p.player_id = s.player_id
        WHERE p.age < 25
          AND p.name NOT LIKE '%U25 Player %'
          AND instr(p.player_id, '_') = 0
    """
    args: list[Any] = []
    if position:
        q += " AND s.position = ?"
        args.append(position)
    if continent:
        q += " AND p.continent = ?"
        args.append(continent)
    if country:
        q += " AND p.country = ?"
        args.append(country)
    if league:
        q += " AND p.league = ?"
        args.append(league)
    q += " ORDER BY s.total_rank_score DESC LIMIT ?"
    args.append(limit)

    conn = _connect()
    try:
        return [dict(r) for r in conn.execute(q, args).fetchall()]
    finally:
        conn.close()


def fetch_analytics(filters: dict[str, str] | None = None) -> dict[str, Any]:
    filters = filters or {}
    base_q = """
        FROM players_u25
        WHERE age < 25
          AND name NOT LIKE '%U25 Player %'
          AND instr(player_id, '_') = 0
    """
    args: list[Any] = []
    if filters.get("continent"):
        base_q += " AND continent = ?"
        args.append(filters["continent"])
    if filters.get("country"):
        base_q += " AND country = ?"
        args.append(filters["country"])
    if filters.get("position"):
        base_q += " AND position = ?"
        args.append(filters["position"])
    if filters.get("league"):
        base_q += " AND league = ?"
        args.append(filters["league"])

    conn = _connect()
    try:
        overview = conn.execute(
            f"""
            SELECT
                COUNT(*) AS players_count,
                COUNT(DISTINCT country) AS countries_count,
                COUNT(DISTINCT league) AS leagues_count,
                ROUND(AVG(age), 2) AS avg_age,
                ROUND(AVG(minutes_played), 1) AS avg_minutes,
                ROUND(AVG(pass_success_rate), 2) AS avg_pass_success,
                ROUND(AVG(duel_win_rate), 2) AS avg_duel_win,
                ROUND(AVG(shot_accuracy), 2) AS avg_shot_accuracy
            {base_q}
            """,
            args,
        ).fetchone()

        by_position = conn.execute(
            f"""
            SELECT position, COUNT(*) AS cnt
            {base_q}
            GROUP BY position
            ORDER BY cnt DESC
            """,
            args,
        ).fetchall()

        top_goalers = conn.execute(
            f"""
            SELECT name, country, league, goals, assists, minutes_played
            {base_q}
            ORDER BY goals DESC, assists DESC, minutes_played DESC
            LIMIT 10
            """,
            args,
        ).fetchall()

        return {
            "overview": dict(overview) if overview else {},
            "by_position": [dict(r) for r in by_position],
            "top_goalers": [dict(r) for r in top_goalers],
        }
    finally:
        conn.close()


def fetch_advanced_analytics(filters: dict[str, str] | None = None) -> dict[str, Any]:
    filters = filters or {}
    base_q = """
        FROM players_u25
        WHERE age < 25
          AND name NOT LIKE '%U25 Player %'
          AND instr(player_id, '_') = 0
    """
    args: list[Any] = []
    if filters.get("continent"):
        base_q += " AND continent = ?"
        args.append(filters["continent"])
    if filters.get("country"):
        base_q += " AND country = ?"
        args.append(filters["country"])
    if filters.get("position"):
        base_q += " AND position = ?"
        args.append(filters["position"])
    if filters.get("league"):
        base_q += " AND league = ?"
        args.append(filters["league"])

    conn = _connect()
    try:
        row = conn.execute(
            f"""
            SELECT
              ROUND(AVG((goals*0.7) + (assists*0.5) + (shot_accuracy*0.03)), 2) AS attacking_index,
              ROUND(AVG((pass_success_rate*0.55) + (after80_pass_success_rate*0.25) + (space_creation_count*0.2)), 2) AS build_up_index,
              ROUND(AVG((tackle_success_rate*0.35) + (intercept_success_rate*0.35) + (ball_recoveries*0.3)), 2) AS defensive_index,
              ROUND(AVG((sprint_speed*2.2) + (distance_per_match_km*4.5) + (physical_index*0.4)), 2) AS athletic_index,
              ROUND(AVG((after80_attack_success_rate*0.5) + (after80_goals*5) + (after80_assists*4)), 2) AS clutch_index,
              ROUND(AVG((dribble_success_rate*0.6) + (dribble_success_count*0.4)), 2) AS dribble_threat_index
            {base_q}
            """,
            args,
        ).fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


def fetch_filter_options(filters: dict[str, str] | None = None) -> dict[str, list[str]]:
    filters = filters or {}
    base_q = """
        FROM players_u25
        WHERE age < 25
          AND name NOT LIKE '%U25 Player %'
          AND instr(player_id, '_') = 0
    """
    args: list[Any] = []
    if filters.get("continent"):
        base_q += " AND continent = ?"
        args.append(filters["continent"])
    if filters.get("country"):
        base_q += " AND country = ?"
        args.append(filters["country"])
    if filters.get("position"):
        base_q += " AND position = ?"
        args.append(filters["position"])
    if filters.get("league"):
        base_q += " AND league = ?"
        args.append(filters["league"])

    conn = _connect()
    try:
        continents = [
            str(r["continent"])
            for r in conn.execute(
                f"SELECT DISTINCT continent {base_q} ORDER BY continent ASC",
                args,
            ).fetchall()
        ]
        countries = [
            str(r["country"])
            for r in conn.execute(
                f"SELECT DISTINCT country {base_q} ORDER BY country ASC",
                args,
            ).fetchall()
        ]
        positions = [
            str(r["position"])
            for r in conn.execute(
                f"SELECT DISTINCT position {base_q} ORDER BY position ASC",
                args,
            ).fetchall()
        ]
        leagues = [
            str(r["league"])
            for r in conn.execute(
                f"SELECT DISTINCT league {base_q} ORDER BY league ASC",
                args,
            ).fetchall()
        ]
        return {
            "continents": continents,
            "countries": countries,
            "positions": positions,
            "leagues": leagues,
        }
    finally:
        conn.close()


def fetch_system_status() -> dict[str, Any]:
    conn = _connect()
    try:
        players_total = conn.execute(
            """
            SELECT COUNT(*) AS cnt
            FROM players_u25
            WHERE age < 25
              AND name NOT LIKE '%U25 Player %'
              AND instr(player_id, '_') = 0
            """
        ).fetchone()
        latest = conn.execute(
            """
            SELECT MAX(updated_at) AS latest_updated_at
            FROM players_u25
            """
        ).fetchone()
        by_continent = conn.execute(
            """
            SELECT continent, COUNT(*) AS cnt
            FROM players_u25
            WHERE age < 25
              AND name NOT LIKE '%U25 Player %'
              AND instr(player_id, '_') = 0
            GROUP BY continent
            ORDER BY cnt DESC
            """
        ).fetchall()
        players_cnt = int(players_total["cnt"]) if players_total is not None and "cnt" in players_total.keys() else 0
        latest_updated_at = latest["latest_updated_at"] if latest is not None and "latest_updated_at" in latest.keys() else None
        return {
            "players_total": players_cnt,
            "latest_updated_at": latest_updated_at,
            "by_continent": [dict(r) for r in by_continent],
        }
    finally:
        conn.close()
