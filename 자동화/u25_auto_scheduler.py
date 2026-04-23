from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from scouting.automation_settings import ensure_automation_config_files, read_automation_config
from scouting.notifications import notify_failure, notify_info
from u25_pipeline import run_once

PROJECT_ROOT = Path(__file__).resolve().parent
LIVE_FIXTURES_PATH = PROJECT_ROOT / "data" / "live_fixtures.json"
STATE_PATH = PROJECT_ROOT / "data" / "u25_auto_scheduler_state.json"


def _read_json(path: Path, default: dict[str, object]) -> dict[str, object]:
    if not path.exists():
        return default
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload
    except Exception:  # noqa: BLE001
        pass
    return default


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _current_live_count() -> int:
    payload = _read_json(LIVE_FIXTURES_PATH, {"results": 0})
    return int(payload.get("results") or 0)


def _run_pipeline(reason: str, *, season: int, harvest_delay: float, bio_backfill_limit: int, bio_backfill_delay: float) -> None:
    notify_info(f"[AUTO] 파이프라인 시작: reason={reason}")
    run_once(
        season=season,
        max_countries=None,
        harvest_delay=max(0.05, harvest_delay),
        bio_backfill_limit=max(1, bio_backfill_limit),
        bio_backfill_delay=max(0.05, bio_backfill_delay),
    )
    notify_info(f"[AUTO] 파이프라인 완료: reason={reason}")


def _parse_time_slots(raw: str) -> list[str]:
    slots: list[str] = []
    for token in str(raw or "").split(","):
        t = token.strip()
        if len(t) != 5 or t[2] != ":":
            continue
        hh = t[:2]
        mm = t[3:]
        if not (hh.isdigit() and mm.isdigit()):
            continue
        h = int(hh)
        m = int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            slots.append(f"{h:02d}:{m:02d}")
    # remove duplicates while preserving order
    out: list[str] = []
    seen = set()
    for s in slots:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out or ["10:00"]


def run_loop(
    *,
    season: int,
    harvest_delay: float,
    bio_backfill_limit: int,
    bio_backfill_delay: float,
    schedule_times: list[str],
    timezone_name: str,
    poll_interval_sec: int,
) -> int:
    state = _read_json(
        STATE_PATH,
        {
            "last_run_slots": {},
            "last_success_ts": 0,
            "last_reason": "",
            "schedule_times": schedule_times,
        },
    )
    state["schedule_times"] = schedule_times

    try:
        tz = ZoneInfo(timezone_name)
    except Exception:  # noqa: BLE001
        tz = None
        timezone_name = "localtime"

    notify_info(
        f"[AUTO] 시작: schedule_times={','.join(schedule_times)}, poll={poll_interval_sec}s"
    )

    while True:
        now = datetime.now(tz) if tz else datetime.now()
        now_ts = int(time.time())
        today = now.strftime("%Y-%m-%d")
        now_hm = now.strftime("%H:%M")

        try:
            last_run_slots = state.get("last_run_slots") or {}
            if now_hm in schedule_times:
                last_date_for_slot = str((last_run_slots or {}).get(now_hm) or "")
                if last_date_for_slot != today:
                    _run_pipeline(
                        f"scheduled_{now_hm}",
                        season=season,
                        harvest_delay=harvest_delay,
                        bio_backfill_limit=bio_backfill_limit,
                        bio_backfill_delay=bio_backfill_delay,
                    )
                    last_run_slots[now_hm] = today
                    state["last_run_slots"] = last_run_slots
                    state["last_success_ts"] = now_ts
                    state["last_reason"] = f"scheduled_{now_hm}"
            _write_json(STATE_PATH, state)

        except Exception as exc:  # noqa: BLE001
            notify_failure("[AUTO] 스케줄러 루프 오류", technical_detail=repr(exc))

        time.sleep(max(10, poll_interval_sec))


def main() -> int:
    ensure_automation_config_files()
    cfg = read_automation_config()
    cfg_times = cfg.get("schedule_times") or ["10:00"]
    default_times = ",".join(str(x) for x in cfg_times)
    cfg_tz = str(cfg.get("timezone") or "Asia/Seoul")
    parser = argparse.ArgumentParser(description="U25 자동 스케줄러 (하루 지정 시간대 실행)")
    parser.add_argument("--season", type=int, default=int(cfg.get("season") or 2025))
    parser.add_argument("--harvest-delay", type=float, default=float(cfg.get("harvest_delay") or 0.25))
    parser.add_argument("--bio-backfill-limit", type=int, default=int(cfg.get("bio_backfill_limit") or 1500))
    parser.add_argument("--bio-backfill-delay", type=float, default=float(cfg.get("bio_backfill_delay") or 0.15))
    parser.add_argument(
        "--schedule-times",
        type=str,
        default=default_times,
        help="하루 실행 시각 CSV (예: 08:00,18:00,23:00). 기본값은 automation_config.json",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=int(cfg.get("scheduler_poll_interval_sec") or 30),
        help="스케줄 검사 주기(초). 기본값은 automation_config.json",
    )
    parser.add_argument(
        "--timezone",
        type=str,
        default=cfg_tz,
        help="스케줄 기준 타임존 (예: Asia/Seoul). 기본값은 automation_config.json",
    )
    args = parser.parse_args()
    return run_loop(
        season=args.season,
        harvest_delay=max(0.05, args.harvest_delay),
        bio_backfill_limit=max(1, args.bio_backfill_limit),
        bio_backfill_delay=max(0.05, args.bio_backfill_delay),
        schedule_times=_parse_time_slots(args.schedule_times),
        timezone_name=str(args.timezone or "Asia/Seoul"),
        poll_interval_sec=max(10, args.poll_interval),
    )


if __name__ == "__main__":
    raise SystemExit(main())
