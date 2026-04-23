"""
API-Football(api-sports.io)과 통신하는 클라이언트.

인수인계 시 참고:
- 베이스 URL·헤더 이름은 API-Football 공식 문서와 동일해야 합니다.
- 스카우팅 시스템의 다른 부분은 이 클래스만 import 하면 됩니다.
- 네트워크/인증/API 비즈니스 오류는 예외로 던지지 않고 APIResult로 돌려
  상위 레이어가 멈추지 않게 설계했습니다.
"""

from __future__ import annotations

import re
import time
from typing import Any

import requests

from scouting.api_result import APIResult
from scouting.config import get_api_football_key
from scouting.errors import ConfigurationError
from scouting.notifications import notify_failure

# 공식 문서 기준(버전 v3)
DEFAULT_BASE_URL = "https://v3.football.api-sports.io"
_ALLOWED_PATH_RE = re.compile(r"^/[A-Za-z0-9/_\-]{0,200}$")


class FootballAPIClient:
    """
    API-Football REST API용 얇은(thin) 클라이언트.

    Args:
        base_url: 스테이징/프록시 URL로 바꿀 때만 지정합니다. 기본은 공식 엔드포인트.
        timeout_sec: 요청당 타임아웃(초). 네트워크가 느린 환경에서는 늘리세요.
        session: 테스트에서 requests.Session 모의 객체를 주입할 수 있습니다.
    """

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout_sec: float = 60.0,
        session: requests.Session | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_sec = timeout_sec
        self._session = session or requests.Session()
        # 마지막 응답의 레이트리밋 관련 헤더 요약(운영 시 폴링 간격 조절에 사용)
        self._last_rate_limit_hint: str = ""
        self._last_daily_requests_remaining: int | None = None

    @property
    def rate_limit_hint(self) -> str:
        """직전 요청의 일일/분당 남은 호출 힌트(헤더 기반). 없으면 빈 문자열."""
        return self._last_rate_limit_hint

    @property
    def daily_requests_remaining(self) -> int | None:
        """직전 응답 헤더의 일일 남은 요청 수. 없으면 None."""
        return self._last_daily_requests_remaining

    def _capture_rate_hint(self, response: requests.Response) -> None:
        """공식 문서: x-ratelimit-requests-remaining(일일), X-Ratelimit-Remaining(분당) 등."""
        h = response.headers
        day = h.get("x-ratelimit-requests-remaining") or h.get("X-RateLimit-Requests-Remaining")
        minute = h.get("x-ratelimit-remaining") or h.get("X-Ratelimit-Remaining")
        self._last_daily_requests_remaining = None
        if day is not None:
            try:
                self._last_daily_requests_remaining = int(str(day).strip())
            except ValueError:
                pass
        parts: list[str] = []
        if day is not None:
            parts.append(f"일일잔여~{day}")
        if minute is not None:
            parts.append(f"분당잔여~{minute}")
        self._last_rate_limit_hint = " | ".join(parts) if parts else ""

    def _headers(self) -> dict[str, str]:
        """문서상 헤더 이름은 'x-apisports-key' 입니다."""
        return {"x-apisports-key": get_api_football_key()}

    def get_json(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> APIResult[dict[str, Any]]:
        """
        GET 요청 후 JSON 객체(dict)를 반환합니다.

        path 예: '/countries' (선행 슬래시 있거나 없어도 허용)
        """
        try:
            headers = self._headers()
        except ConfigurationError as exc:
            notify_failure(exc.user_message, technical_detail=exc.technical_detail)
            return APIResult(
                success=False,
                message_for_operator=exc.user_message,
                technical_detail=exc.technical_detail,
            )

        url_path = path if path.startswith("/") else f"/{path}"
        if not _ALLOWED_PATH_RE.match(url_path) or ".." in url_path or "//" in url_path:
            msg = "허용되지 않은 API 경로입니다."
            notify_failure(msg, technical_detail=f"blocked_path={url_path!r}")
            return APIResult(
                success=False,
                message_for_operator=msg,
                technical_detail="invalid_api_path",
            )
        url = f"{self._base_url}{url_path}"

        try:
            response = self._session.get(
                url,
                headers=headers,
                params=params or {},
                timeout=self._timeout_sec,
            )
        except requests.RequestException as exc:
            msg = "외부 API 서버에 연결하지 못했습니다. 네트워크 또는 방화벽을 확인하세요."
            notify_failure(msg, technical_detail=repr(exc))
            return APIResult(
                success=False,
                message_for_operator=msg,
                technical_detail=repr(exc),
            )

        if response.status_code == 429:
            self._capture_rate_hint(response)
            msg = (
                "요청 한도(레이트 리밋)에 걸렸습니다. "
                "폴링 간격을 늘리거나, 무료 플랜 일일 100회 한도를 확인하세요."
            )
            notify_failure(msg, technical_detail=response.text[:500])
            return APIResult(
                success=False,
                message_for_operator=msg,
                technical_detail=f"HTTP 429 {self._last_rate_limit_hint}",
            )

        if response.status_code in (401, 403):
            self._capture_rate_hint(response)
            msg = "API 키가 거부되었습니다. 대시보드에서 키·요금제·할당량을 확인하세요."
            notify_failure(msg, technical_detail=f"HTTP {response.status_code}")
            return APIResult(
                success=False,
                message_for_operator=msg,
                technical_detail=f"HTTP {response.status_code} body={response.text[:500]}",
            )

        if response.status_code >= 500:
            self._capture_rate_hint(response)
            msg = "외부 API 서버 오류입니다. 잠시 후 다시 시도하세요."
            notify_failure(msg, technical_detail=f"HTTP {response.status_code}")
            return APIResult(
                success=False,
                message_for_operator=msg,
                technical_detail=f"HTTP {response.status_code}",
            )

        if not response.ok:
            self._capture_rate_hint(response)
            msg = f"예상치 못한 HTTP 응답입니다({response.status_code})."
            notify_failure(msg, technical_detail=response.text[:500])
            return APIResult(
                success=False,
                message_for_operator=msg,
                technical_detail=f"HTTP {response.status_code}",
            )

        try:
            payload: dict[str, Any] = response.json()
        except ValueError as exc:
            self._capture_rate_hint(response)
            msg = "외부 API가 JSON이 아닌 응답을 반환했습니다."
            notify_failure(msg, technical_detail=repr(exc))
            return APIResult(success=False, message_for_operator=msg, technical_detail=repr(exc))

        self._capture_rate_hint(response)

        errors = payload.get("errors")
        if errors:
            msg = "외부 API가 오류 정보를 반환했습니다. 키·파라미터·쿼터를 확인하세요."
            notify_failure(msg, technical_detail=str(errors))
            return APIResult(
                success=False,
                message_for_operator=msg,
                technical_detail=str(errors),
            )

        return APIResult(success=True, data=payload, message_for_operator="요청이 정상 처리되었습니다.")

    def fetch_countries_merged(self) -> APIResult[dict[str, Any]]:
        """
        /countries 엔드포인트를 페이지 단위로 모두 가져와 하나의 dict로 합칩니다.

        반환 dict 키:
            - get, results, paging, response, parameters, errors
        """
        merged: list[Any] = []
        last_payload: dict[str, Any] | None = None
        page = 1

        while True:
            result = self.get_json("/countries", params={"page": page})
            if not result.success or result.data is None:
                return result

            last_payload = result.data
            chunk = last_payload.get("response") or []
            merged.extend(chunk)

            paging = last_payload.get("paging") or {}
            current = int(paging.get("current", page))
            total_pages = int(paging.get("total", 1))
            if current >= total_pages:
                break
            page = current + 1
            time.sleep(0.25)

        assert last_payload is not None
        out: dict[str, Any] = {
            "get": "countries",
            "results": len(merged),
            "paging": {"current": 1, "total": 1},
            "response": merged,
            "parameters": last_payload.get("parameters", []),
            "errors": last_payload.get("errors", []),
        }
        return APIResult(
            success=True,
            data=out,
            message_for_operator=f"국가 {len(merged)}건을 수집했습니다.",
        )

    def fetch_live_fixtures(
        self,
        *,
        league_ids: list[int] | None = None,
    ) -> APIResult[dict[str, Any]]:
        """
        진행 중(live) 경기 목록을 가져옵니다.

        - league_ids가 None이면 전 세계 `live=all` (한 번의 호출로 전체 라이브).
        - 특정 리그만 보려면 리그 ID를 넣습니다. 예: [39] 프리미어리그, [39, 140] 여러 리그.
          API 규격상 `live` 파라미터 값은 ID를 하이픈으로 이어 붙입니다(예: 39-140).

        참고: API-Football은 WebSocket이 아니며, '실시간'에 가깝게 쓰려면
        이 메서드를 15~60초 간격 등으로 반복 호출하는 패턴이 공식 권장과 같습니다.
        무료 플랜은 일일 요청 한도(100회)가 매우 작으니 간격을 짧게 잡지 마세요.
        """
        if league_ids:
            live_param = "-".join(str(x) for x in league_ids)
        else:
            live_param = "all"
        return self.get_json("/fixtures", params={"live": live_param})
