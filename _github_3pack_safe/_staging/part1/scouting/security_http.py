"""
HTTP 보안 보조: CORS 화이트리스트, 응답 보안 헤더, 쿼리/경로 입력 정리.

- API 키 등 비밀은 여기 두지 않습니다(.env + scouting.config).
- CORS 기본값은 로컬 개발용 오리진만 허용합니다(U25_CORS_ORIGINS 로 확장).
"""

from __future__ import annotations

import hmac
import os
import re
import threading
import time
from collections import defaultdict, deque
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PLAYER_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,128}$")
_SORT_FIELD_RE = re.compile(r"^[a-zA-Z0-9_]{1,64}$")
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}

_DEFAULT_LOCAL_ORIGINS: tuple[str, ...] = (
    "http://127.0.0.1",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:5500",
    "http://localhost",
    "http://localhost:8080",
    "http://localhost:5500",
    # file:// 로 연 index.html 등(로컬 전용). 공개 배포 시 U25_CORS_ORIGINS 로만 제한하세요.
    "null",
)


def sanitize_query_value(value: str | None, *, max_len: int = 200) -> str:
    s = "" if value is None else str(value)
    s = _CONTROL_CHARS.sub("", s).strip()
    return s[:max_len]


def sanitize_player_id(value: str | None) -> str:
    s = "" if value is None else str(value).strip()
    if not _PLAYER_ID_RE.match(s):
        return ""
    return s


def sanitize_sort_by(value: str | None, *, default: str = "minutes_played") -> str:
    s = sanitize_query_value(value, max_len=64)
    return s if _SORT_FIELD_RE.match(s) else default


def sanitize_sort_order(value: str | None, *, default: str = "desc") -> str:
    s = (sanitize_query_value(value, max_len=8) or default).lower()
    return s if s in ("asc", "desc") else default


def clamp_int(value: int | None, *, lo: int, hi: int, default: int) -> int:
    try:
        n = int(value if value is not None else default)
    except Exception:  # noqa: BLE001
        n = default
    return max(lo, min(hi, n))


def get_cors_allow_origins() -> list[str]:
    raw = (os.environ.get("U25_CORS_ORIGINS") or "").strip()
    if raw:
        return [x.strip() for x in raw.split(",") if x.strip()]
    try:
        from scouting.automation_settings import read_automation_config

        cfg = read_automation_config()
        sec = cfg.get("security") if isinstance(cfg.get("security"), dict) else {}
        origins = sec.get("cors_origins")
        if isinstance(origins, list) and origins:
            out = [str(x).strip() for x in origins if str(x).strip()]
            if out:
                return out
    except Exception:  # noqa: BLE001
        pass
    return list(_DEFAULT_LOCAL_ORIGINS)


def expose_openapi_docs() -> bool:
    return (os.environ.get("U25_EXPOSE_DOCS") or "").strip().lower() in ("1", "true", "yes")


def _read_security_cfg() -> dict[str, Any]:
    try:
        from scouting.automation_settings import read_automation_config

        cfg = read_automation_config()
        sec = cfg.get("security")
        if isinstance(sec, dict):
            return sec
    except Exception:  # noqa: BLE001
        pass
    return {}


def _allow_local_token_bypass() -> bool:
    raw = (os.environ.get("U25_ALLOW_LOCAL_TOKEN_BYPASS") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    sec = _read_security_cfg()
    return bool(sec.get("allow_local_token_bypass", True))


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """JSON API용 최소 보안 헤더(스웨거 비노출 시에도 무방)."""

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault(
            "Permissions-Policy",
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
        )
        response.headers.setdefault("Cache-Control", "no-store, max-age=0")
        response.headers.setdefault("Pragma", "no-cache")
        response.headers.setdefault("X-Robots-Tag", "noindex, nofollow")
        response.headers.setdefault("X-DNS-Prefetch-Control", "off")
        response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
        return response


def _api_bearer_token() -> str:
    return (os.environ.get("U25_API_TOKEN") or "").strip()


class APITokenMiddleware(BaseHTTPMiddleware):
    """
    U25_API_TOKEN 이 설정된 경우에만 활성화.
    /health 및 CORS preflight(OPTIONS)는 예외.
    """

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        token = _api_bearer_token()
        if not token:
            return await call_next(request)
        if request.method == "OPTIONS":
            return await call_next(request)
        path = str(request.url.path or "")
        if path == "/health":
            return await call_next(request)
        client_host = ((request.client.host if request.client else "") or "").strip()
        # 로컬 개발 편의(기본값 true). 운영에서는 U25_ALLOW_LOCAL_TOKEN_BYPASS=0 권장.
        if _allow_local_token_bypass() and client_host in _LOCAL_HOSTS:
            return await call_next(request)
        auth = (request.headers.get("authorization") or "").strip()
        parts = auth.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return JSONResponse({"detail": "Unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        got = parts[1].strip()
        if len(got) != len(token):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        if not hmac.compare_digest(got.encode("utf-8"), token.encode("utf-8")):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        return await call_next(request)


class RequestSurfaceGuardMiddleware(BaseHTTPMiddleware):
    """불필요한 HTTP 메서드/과도한 URL 길이 차단."""

    _ALLOW_METHODS = {"GET", "POST", "HEAD", "OPTIONS"}
    _MAX_URL_PATH_LEN = 1024
    _MAX_QUERY_LEN = 2048

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        method = (request.method or "").upper()
        if method not in self._ALLOW_METHODS:
            return JSONResponse({"detail": "Method not allowed"}, status_code=405)
        if len(str(request.url.path or "")) > self._MAX_URL_PATH_LEN:
            return JSONResponse({"detail": "Path too long"}, status_code=414)
        if len(str(request.url.query or "")) > self._MAX_QUERY_LEN:
            return JSONResponse({"detail": "Query too long"}, status_code=414)
        return await call_next(request)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """고정 윈도우 기반 간단 레이트 리밋."""

    def __init__(self, app: Any) -> None:
        super().__init__(app)
        sec = _read_security_cfg()
        per_min = int(sec.get("request_rate_limit_per_minute", 240) or 240)
        window_sec = int(sec.get("request_rate_limit_window_sec", 60) or 60)
        self._limit = max(30, min(per_min, 5000))
        self._window_sec = max(10, min(window_sec, 600))
        self._sensitive_limit_map = self._build_sensitive_limit_map(sec)
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _build_sensitive_limit_map(self, sec: dict[str, Any]) -> list[tuple[str, int]]:
        default_map = {
            "/players": 120,
            "/players/": 90,
            "/adaptation/": 60,
            "/scouting/best-match": 60,
            "/analytics/hidden-player": 90,
            "/scouting/spotlight-top5": 90,
            "/scouting/spotlight-top-global": 90,
        }
        raw = sec.get("endpoint_rate_limits_per_minute")
        if isinstance(raw, dict):
            for k, v in raw.items():
                key = str(k or "").strip()
                if not key:
                    continue
                try:
                    default_map[key] = int(v)
                except Exception:  # noqa: BLE001
                    continue
        out: list[tuple[str, int]] = []
        for path_prefix, limit in default_map.items():
            out.append((path_prefix, max(10, min(int(limit), 2000))))
        out.sort(key=lambda x: len(x[0]), reverse=True)
        return out

    def _key(self, request: Request) -> str:
        client_host = ((request.client.host if request.client else "") or "").strip() or "unknown"
        token = request.headers.get("authorization", "")
        auth_bucket = "auth" if token.strip() else "anon"
        return f"{client_host}:{auth_bucket}"

    def _limit_for_path(self, path: str) -> int:
        for prefix, limit in self._sensitive_limit_map:
            if path == prefix or path.startswith(prefix):
                return limit
        return self._limit

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        path = str(request.url.path or "")
        if request.method == "OPTIONS" or path == "/health":
            return await call_next(request)
        now = time.monotonic()
        key = self._key(request)
        path = str(request.url.path or "")
        max_hits = self._limit_for_path(path)
        with self._lock:
            bucket = self._hits[key]
            floor = now - self._window_sec
            while bucket and bucket[0] < floor:
                bucket.popleft()
            if len(bucket) >= max_hits:
                retry_after = max(1, int(self._window_sec - (now - bucket[0])))
                return JSONResponse(
                    {"detail": "Too many requests"},
                    status_code=429,
                    headers={"Retry-After": str(retry_after)},
                )
            bucket.append(now)
        return await call_next(request)
