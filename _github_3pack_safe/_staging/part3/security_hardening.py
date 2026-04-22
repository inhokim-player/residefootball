from __future__ import annotations

import hashlib
import shutil
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "data"
DB_PATH = DATA_DIR / "u25_scouting.db"
SNAPSHOT_PATH = DATA_DIR / "u25_latest_snapshot.json"
BACKUP_DIR = DATA_DIR / "secure_backups"
MANIFEST_PATH = BACKUP_DIR / "manifest.jsonl"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def create_secure_backup(*, keep_latest: int = 20) -> dict[str, object]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = int(time.time())
    created: list[dict[str, object]] = []

    for src in (DB_PATH, SNAPSHOT_PATH):
        if not src.exists():
            continue
        dst = BACKUP_DIR / f"{src.stem}-{ts}{src.suffix}"
        shutil.copy2(src, dst)
        created.append(
            {
                "file": dst.name,
                "source": str(src.name),
                "bytes": dst.stat().st_size,
                "sha256": _sha256(dst),
                "ts": ts,
            }
        )

    if created:
        with MANIFEST_PATH.open("a", encoding="utf-8") as fp:
            for row in created:
                fp.write(
                    (
                        "{"
                        f"\"ts\":{row['ts']},"
                        f"\"file\":\"{row['file']}\","
                        f"\"source\":\"{row['source']}\","
                        f"\"bytes\":{row['bytes']},"
                        f"\"sha256\":\"{row['sha256']}\""
                        "}\n"
                    )
                )

    # Rotate old backups per source file type.
    for stem in ("u25_scouting", "u25_latest_snapshot"):
        files = sorted(BACKUP_DIR.glob(f"{stem}-*"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[keep_latest:]:
            try:
                old.unlink()
            except Exception:
                pass

    return {"created": len(created), "ts": ts}
