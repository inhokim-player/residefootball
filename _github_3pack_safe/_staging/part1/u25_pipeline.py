from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from global_u25_harvest import harvest_global_u25
from backfill_player_bio import run as run_bio_backfill
from security_hardening import create_secure_backup
from scouting.notifications import notify_failure, notify_info
from scouting.u25_database import fetch_players, init_db, replace_scores
from scouting.u25_engine import build_rankings

PROJECT_ROOT = Path(__file__).resolve().parent
SNAPSHOT_PATH = PROJECT_ROOT / "data" / "u25_latest_snapshot.json"


def run_once(
    *,
    season: int,
    max_countries: int | None,
    harvest_delay: float,
    bio_backfill_limit: int,
    bio_backfill_delay: float,
) -> int:
    init_db()
    harvest_global_u25(season=season, max_countries=max_countries, delay_sec=harvest_delay)
    # Keep height/weight/foot synchronized with API data for players missing bio fields.
    run_bio_backfill(
        season=season,
        limit=max(1, bio_backfill_limit),
        delay=max(0.05, bio_backfill_delay),
    )

    player_rows = fetch_players()
    rankings = build_rankings(player_rows)
    replace_scores(rankings)

    SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_PATH.write_text(
        json.dumps(
            {
                "timestamp": int(time.time()),
                "players_count": len(player_rows),
                "rankings_count": len(rankings),
                "top_30": rankings[:30],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    backup_meta = create_secure_backup(keep_latest=20)
    notify_info(f"U25 파이프라인 완료: players={len(player_rows)}, rankings={len(rankings)}")
    notify_info(f"보안 백업 완료: created={backup_meta.get('created')} ts={backup_meta.get('ts')}")
    return 0


def run_loop(
    *,
    interval_sec: int,
    season: int,
    max_countries: int | None,
    harvest_delay: float,
    bio_backfill_limit: int,
    bio_backfill_delay: float,
) -> int:
    while True:
        try:
            run_once(
                season=season,
                max_countries=max_countries,
                harvest_delay=harvest_delay,
                bio_backfill_limit=bio_backfill_limit,
                bio_backfill_delay=bio_backfill_delay,
            )
        except Exception as exc:  # noqa: BLE001
            notify_failure("U25 자동화 파이프라인 실행 실패", technical_detail=repr(exc))
        time.sleep(max(15, interval_sec))


def main() -> int:
    parser = argparse.ArgumentParser(description="U25 글로벌 스카우팅 자동화 파이프라인")
    parser.add_argument("--once", action="store_true", help="1회 실행 후 종료")
    parser.add_argument("--interval", type=int, default=1800, help="반복 실행 주기(초), 기본 1800(30분)")
    parser.add_argument("--season", type=int, default=2025, help="global 모드 시즌")
    parser.add_argument("--max-countries", type=int, default=None, help="global 모드 테스트용 국가 제한")
    parser.add_argument("--harvest-delay", type=float, default=0.25, help="API 요청 간 대기(초), 기본 0.25")
    parser.add_argument("--bio-backfill-limit", type=int, default=50000, help="루프당 키/몸무게/주발 백필 최대 선수 수")
    parser.add_argument("--bio-backfill-delay", type=float, default=0.15, help="백필 API 요청 간 대기(초)")
    args = parser.parse_args()
    if args.once:
        return run_once(
            season=args.season,
            max_countries=args.max_countries,
            harvest_delay=max(0.05, args.harvest_delay),
            bio_backfill_limit=max(1, args.bio_backfill_limit),
            bio_backfill_delay=max(0.05, args.bio_backfill_delay),
        )
    return run_loop(
        interval_sec=args.interval,
        season=args.season,
        max_countries=args.max_countries,
        harvest_delay=max(0.05, args.harvest_delay),
        bio_backfill_limit=max(1, args.bio_backfill_limit),
        bio_backfill_delay=max(0.05, args.bio_backfill_delay),
    )


if __name__ == "__main__":
    sys.exit(main())
