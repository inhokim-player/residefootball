from __future__ import annotations

import argparse
import sqlite3
import time
from pathlib import Path
from typing import Any

from scouting.football_client import FootballAPIClient

DB_PATH = Path(__file__).resolve().parent / "data" / "u25_scouting.db"


def _parse_measure(raw: Any) -> float:
    text = str(raw or "").strip().lower()
    if not text:
        return 0.0
    token = text.replace("cm", "").replace("kg", "").strip()
    try:
        return float(token)
    except Exception:  # noqa: BLE001
        return 0.0


def _parse_foot(player: dict[str, Any], stat: dict[str, Any]) -> str:
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
        lv = v.lower()
        if lv in {"left", "left-footed", "l"}:
            return "Left"
        if lv in {"right", "right-footed", "r"}:
            return "Right"
        if lv in {"both", "either", "ambi", "ambidextrous"}:
            return "Both"
        return v.title()
    return "Unknown"


def _pick_player_block(response_rows: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    if not response_rows:
        return {}, {}
    row = response_rows[0] or {}
    player = row.get("player") or {}
    stats = row.get("statistics") or []
    stat0 = stats[0] if stats else {}
    return player, stat0


def _fetch_player_profile(client: FootballAPIClient, player_id: str, season: int) -> tuple[float, float, str]:
    # 1) season 지정 조회
    res = client.get_json("/players", params={"id": player_id, "season": season})
    if res.success and res.data:
        player, stat0 = _pick_player_block(list(res.data.get("response") or []))
        h = _parse_measure(player.get("height"))
        w = _parse_measure(player.get("weight"))
        foot = _parse_foot(player, stat0)
        if h > 0 and w > 0:
            return h, w, foot
    # 2) season 없이 조회 fallback
    res2 = client.get_json("/players/profiles", params={"player": player_id})
    if res2.success and res2.data:
        rows = list(res2.data.get("response") or [])
        if rows:
            p = rows[0] or {}
            h = _parse_measure(p.get("height"))
            w = _parse_measure(p.get("weight"))
            foot = _parse_foot(p, {})
            if h > 0 and w > 0:
                return h, w, foot
    return 0.0, 0.0, "Unknown"


def run(*, season: int, limit: int, delay: float) -> int:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT player_id
        FROM players_u25
        WHERE age < 25
          AND (height_cm <= 0 OR weight_kg <= 0 OR dominant_foot = 'Unknown')
          AND name NOT LIKE '%U25 Player %'
          AND instr(player_id, '_') = 0
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    targets = [str(r["player_id"]) for r in rows]
    print(f"targets={len(targets)}")
    if not targets:
        conn.close()
        return 0

    client = FootballAPIClient()
    updated = 0
    skipped = 0
    for idx, pid in enumerate(targets, start=1):
        try:
            h, w, foot = _fetch_player_profile(client, pid, season)
            if h <= 0 or w <= 0:
                skipped += 1
            else:
                cur.execute(
                    """
                    UPDATE players_u25
                    SET height_cm = ?, weight_kg = ?, dominant_foot = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE player_id = ?
                    """,
                    (h, w, foot or "Unknown", pid),
                )
                updated += 1
            if idx % 20 == 0:
                conn.commit()
                print(f"progress {idx}/{len(targets)} updated={updated} skipped={skipped}")
        except Exception as exc:  # noqa: BLE001
            skipped += 1
            print(f"skip {pid}: {exc!r}")
        time.sleep(max(0.05, delay))
    conn.commit()
    conn.close()
    print(f"done updated={updated} skipped={skipped} total={len(targets)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill player height/weight/dominant foot from API-Football")
    parser.add_argument("--season", type=int, default=2025)
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--delay", type=float, default=0.25)
    args = parser.parse_args()
    return run(season=args.season, limit=max(1, args.limit), delay=max(0.05, args.delay))


if __name__ == "__main__":
    raise SystemExit(main())
