from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent
    cmd = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(root / "scripts" / "server_stack.ps1"),
        "-Mode",
        "Full",
    ]
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
"""
U25 자동화 스택 실행기 (Windows).

- 설정은 data/automation_config.json 한 곳에서 읽습니다.
- 복제본(data/automation_config.replica.json)은 automation_settings 가 본문과 동기화합니다.
- start_u25_full_auto.bat 에서 이 스크립트를 호출합니다.
"""

from __future__ import annotations

import subprocess

from scouting.automation_settings import ensure_automation_config_files, read_automation_config
from scouting.config import PROJECT_ROOT


def _start_console(title: str, inner_cmd: str) -> None:
    """별도 콘솔 창에서 inner_cmd 실행 (cmd /k 유지)."""
    root = str(PROJECT_ROOT)
    inner = f'cd /d "{root}" && {inner_cmd}'
    subprocess.Popen(
        ["cmd", "/c", "start", title, "cmd", "/k", inner],
        cwd=root,
    )


def main() -> int:
    ensure_automation_config_files()
    cfg = read_automation_config()
    times = ",".join(str(x) for x in (cfg.get("schedule_times") or []))
    if not times:
        times = "10:00"
    tz = str(cfg.get("timezone") or "Asia/Seoul")
    season = int(cfg.get("season") or 2025)
    poll = int(cfg.get("scheduler_poll_interval_sec") or 30)
    hd = float(cfg.get("harvest_delay") or 0.25)
    bbl = int(cfg.get("bio_backfill_limit") or 1500)
    bbd = float(cfg.get("bio_backfill_delay") or 0.15)
    lf = cfg.get("live_feed") or {}
    lf_iv = int(lf.get("interval_sec") or 30)
    lf_season = int(lf.get("season") or season)

    sch = (
        f"py u25_auto_scheduler.py --season {season} --schedule-times {times} "
        f"--poll-interval {poll} --timezone {tz} "
        f"--harvest-delay {hd} --bio-backfill-limit {bbl} --bio-backfill-delay {bbd}"
    )
    _start_console("U25 Auto Scheduler", sch)
    _start_console("U25 API Server", "py api_watchdog.py")
    _start_console("Key League Schedule Feed", f"py live_feed.py --interval {lf_iv} --season {lf_season}")
    print("[run_automation_stack] 3개 창을 시작했습니다. 설정: data/automation_config.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
