"""
스카우팅 시스템 — 외부 축구 데이터(API-Football) 연동 패키지.

다른 개발자가 처음 볼 때:
- 설정: scouting.config (환경 변수)
- 호출: scouting.football_client.FootballAPIClient
- 결과 타입: scouting.api_result.APIResult
- 로그/알림: scouting.notifications
"""

from scouting.api_result import APIResult
from scouting.football_client import FootballAPIClient

__all__ = ["APIResult", "FootballAPIClient"]
