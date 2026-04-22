from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def _parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _ok(msg: str) -> None:
    print(f"[OK] {msg}")


def _warn(msg: str) -> None:
    print(f"[WARN] {msg}")


def _fail(msg: str) -> None:
    print(f"[FAIL] {msg}")


def main() -> int:
    parser = argparse.ArgumentParser(description="U25 pre-deploy security and automation checks")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--api-domain", type=str, default="https://api.residefootball.com")
    args = parser.parse_args()

    root = args.root.resolve()
    env_path = root / ".env"
    cfg_path = root / "data" / "automation_config.json"
    idx_path = root / "site" / "index.html"
    admin_path = root / "site" / "admin.html"

    fails = 0
    warns = 0

    if not env_path.exists():
        _fail(".env file not found")
        return 2

    env = _parse_env(env_path)
    required_keys = ["API_FOOTBALL_KEY", "U25_API_TOKEN", "U25_CORS_ORIGINS"]
    for k in required_keys:
        v = (env.get(k) or "").strip()
        if not v:
            _fail(f"{k} is missing or empty in .env")
            fails += 1
        else:
            _ok(f"{k} is set")

    football_key = (env.get("API_FOOTBALL_KEY") or "").strip()
    if football_key:
        if re.search(r"\s", football_key):
            _fail("API_FOOTBALL_KEY contains whitespace (possible typo)")
            fails += 1
        elif len(football_key) < 20:
            _warn("API_FOOTBALL_KEY length looks short; verify copy/paste")
            warns += 1
        else:
            _ok("API_FOOTBALL_KEY basic format check passed")

    api_token = (env.get("U25_API_TOKEN") or "").strip()
    if api_token and len(api_token) < 24:
        _warn("U25_API_TOKEN is short; use at least 24+ chars")
        warns += 1
    elif api_token:
        _ok("U25_API_TOKEN length looks safe")

    cors = [x.strip() for x in (env.get("U25_CORS_ORIGINS") or "").split(",") if x.strip()]
    need_origins = {"https://residefootball.com", "https://www.residefootball.com"}
    missing = sorted(need_origins - set(cors))
    if missing:
        _warn(f"U25_CORS_ORIGINS is missing recommended domains: {', '.join(missing)}")
        warns += 1
    else:
        _ok("U25_CORS_ORIGINS includes residefootball domains")

    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        _fail(f"Cannot read automation config: {exc!r}")
        return 2

    sec = cfg.get("security") if isinstance(cfg.get("security"), dict) else {}
    if bool(sec.get("allow_local_token_bypass", True)):
        _fail("security.allow_local_token_bypass must be false for public deploy")
        fails += 1
    else:
        _ok("allow_local_token_bypass is false")

    if not sec.get("cors_origins"):
        _warn("automation_config.security.cors_origins is empty (env var must be set on server)")
        warns += 1
    else:
        _ok("automation_config.security.cors_origins is configured")

    index_html = idx_path.read_text(encoding="utf-8")
    admin_html = admin_path.read_text(encoding="utf-8")

    if 'name="robots" content="noindex, nofollow"' in index_html:
        _fail("site/index.html is noindex; Google cannot index it")
        fails += 1
    else:
        _ok("site/index.html robots meta allows indexing")

    if 'name="robots" content="noindex, nofollow"' in admin_html:
        _ok("site/admin.html is noindex (good for admin page)")
    else:
        _warn("site/admin.html is indexable; recommended to keep noindex")
        warns += 1

    if args.api_domain not in index_html:
        _warn(f"site/index.html does not reference {args.api_domain} as default API")
        warns += 1
    else:
        _ok("site/index.html default API domain is set")

    if args.api_domain not in admin_html:
        _warn(f"site/admin.html does not reference {args.api_domain} as default API")
        warns += 1
    else:
        _ok("site/admin.html default API domain is set")

    print("")
    print(f"Summary: FAIL={fails}, WARN={warns}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
