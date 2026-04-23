"""
U25 자동화 단일 설정 소스.

- 본문: data/automation_config.json
- 복제본: data/automation_config.replica.json (본문과 동일 바이트 유지)

스케줄·시즌·API 포트 등은 이 파일만 수정하면 됩니다.
프론트(site/index.html)의 API_BASE는 api.host / api.port 와 반드시 맞추세요.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scouting.config import PROJECT_ROOT

AUTOMATION_CONFIG_PATH = PROJECT_ROOT / "data" / "automation_config.json"
AUTOMATION_CONFIG_REPLICA_PATH = PROJECT_ROOT / "data" / "automation_config.replica.json"
AUTOMATION_BACKUP_DIR = PROJECT_ROOT / "data" / "automation_backups"
MAX_AUTOMATION_BACKUPS = 20


def default_automation_dict() -> dict[str, Any]:
    return {
        "version": 1,
        "season": 2025,
        "schedule_times": ["10:00"],
        "timezone": "Asia/Seoul",
        "scheduler_poll_interval_sec": 30,
        "harvest_delay": 0.25,
        "bio_backfill_limit": 50000,
        "bio_backfill_delay": 0.15,
        "api": {"host": "127.0.0.1", "port": 8010},
        "live_feed": {"interval_sec": 30, "season": 2025},
        "security": {
            "cors_origins": [],
            "request_rate_limit_per_minute": 180,
            "request_rate_limit_window_sec": 60,
            "allow_local_token_bypass": False,
            "max_request_body_bytes": 65536,
        },
        "meta": {
            "note_ko": "스케줄/시즌/포트 변경은 이 파일만 고치면 됩니다. site/index.html 의 API_BASE도 동일 호스트·포트로 맞추세요. 로컬에서만 U25 토큰 생략하려면 security.allow_local_token_bypass=true 또는 U25_ALLOW_LOCAL_TOKEN_BYPASS=1 (운영 공개는 false 권장).",
        },
    }


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)  # type: ignore[arg-type]
        else:
            out[k] = v
    return out


def _read_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            return raw
    except Exception:  # noqa: BLE001
        return None
    return None


def _sync_replica_from_canonical() -> None:
    if not AUTOMATION_CONFIG_PATH.exists():
        return
    try:
        AUTOMATION_CONFIG_REPLICA_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(AUTOMATION_CONFIG_PATH, AUTOMATION_CONFIG_REPLICA_PATH)
    except Exception:  # noqa: BLE001
        pass


def _sync_versioned_backup_from_canonical() -> None:
    if not AUTOMATION_CONFIG_PATH.exists():
        return
    try:
        AUTOMATION_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_path = AUTOMATION_BACKUP_DIR / f"automation_config.{ts}.json"
        shutil.copy2(AUTOMATION_CONFIG_PATH, backup_path)
        backups = sorted(AUTOMATION_BACKUP_DIR.glob("automation_config.*.json"))
        if len(backups) > MAX_AUTOMATION_BACKUPS:
            for old in backups[: len(backups) - MAX_AUTOMATION_BACKUPS]:
                try:
                    old.unlink(missing_ok=True)
                except Exception:  # noqa: BLE001
                    pass
    except Exception:  # noqa: BLE001
        pass


def ensure_automation_config_files() -> dict[str, Any]:
    """
    automation_config.json 이 없으면 기본값으로 생성하고 복제본을 맞춥니다.
    """
    defaults = default_automation_dict()
    if not AUTOMATION_CONFIG_PATH.exists():
        AUTOMATION_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        AUTOMATION_CONFIG_PATH.write_text(
            json.dumps(defaults, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        _sync_versioned_backup_from_canonical()
    _sync_replica_from_canonical()
    return read_automation_config()


def read_automation_config() -> dict[str, Any]:
    """
    본문 JSON을 읽어 기본값과 병합합니다. 손상 시 기본값으로 폴백합니다.
    복제본은 본문과 동기화합니다(가능한 경우).
    """
    base = default_automation_dict()
    loaded = _read_json_file(AUTOMATION_CONFIG_PATH)
    if loaded is None:
        merged = dict(base)
    else:
        merged = _deep_merge(base, loaded)
    # 정규화: schedule_times 문자열 리스트
    st = merged.get("schedule_times")
    if isinstance(st, list):
        merged["schedule_times"] = [str(x) for x in st]
    elif isinstance(st, str):
        merged["schedule_times"] = [s.strip() for s in st.split(",") if s.strip()]
    else:
        merged["schedule_times"] = list(base["schedule_times"])

    api = merged.get("api")
    if not isinstance(api, dict):
        merged["api"] = dict(base["api"])
    else:
        merged["api"] = {**base["api"], **api}

    lf = merged.get("live_feed")
    if not isinstance(lf, dict):
        merged["live_feed"] = dict(base["live_feed"])
    else:
        merged["live_feed"] = {**base["live_feed"], **lf}

    sec = merged.get("security")
    if not isinstance(sec, dict):
        merged["security"] = dict(base["security"])
    else:
        merged["security"] = {**base["security"], **sec}

    _sync_replica_from_canonical()
    _sync_versioned_backup_from_canonical()
    return merged


def api_bind_tuple() -> tuple[str, int]:
    cfg = read_automation_config()
    api = cfg.get("api") or {}
    host = str(api.get("host") or "127.0.0.1")
    port = int(api.get("port") or 8010)
    return host, port
