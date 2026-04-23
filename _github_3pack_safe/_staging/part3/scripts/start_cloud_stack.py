from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def _spawn(cmd: list[str]) -> subprocess.Popen[bytes]:
    return subprocess.Popen(cmd, cwd=str(ROOT))


def main() -> int:
    port = int(os.environ.get("PORT", "8010"))
    children: list[subprocess.Popen[bytes]] = []

    def _cleanup(*_: object) -> None:
        for p in children:
            if p.poll() is None:
                p.terminate()
        # give children brief time to exit gracefully
        time.sleep(1.0)
        for p in children:
            if p.poll() is None:
                p.kill()

    signal.signal(signal.SIGTERM, _cleanup)
    signal.signal(signal.SIGINT, _cleanup)

    # Keep automation workers running in same service so SQLite/data files stay consistent.
    children.append(_spawn([sys.executable, "u25_auto_scheduler.py"]))
    children.append(_spawn([sys.executable, "live_feed.py"]))

    api = _spawn(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "u25_api:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
        ]
    )
    children.append(api)

    exit_code = api.wait()
    _cleanup()
    return int(exit_code)


if __name__ == "__main__":
    raise SystemExit(main())
