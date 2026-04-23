"""
스카우팅 시스템 외부 API 연동 전용 예외 계층.

인수인계 시 참고:
- 비즈니스/운영 코드에서는 가능하면 예외 대신 APIResult(성공·실패 객체)를 사용하고,
  그래도 예외가 필요할 때만 이 모듈의 타입을 씁니다.
- 모든 예외는 ScoutingIntegrationError를 상속하므로, 최상위에서 한 번에 잡을 수 있습니다.
"""

from __future__ import annotations


class ScoutingIntegrationError(Exception):
    """외부 데이터 연동과 관련된 모든 오류의 공통 부모입니다."""

    def __init__(self, message: str, *, technical_detail: str | None = None) -> None:
        super().__init__(message)
        self.user_message = message
        self.technical_detail = technical_detail


class ConfigurationError(ScoutingIntegrationError):
    """
    .env 누락, 필수 환경 변수 없음, 값 형식 오류 등
    '배포 전에 고쳐야 하는 설정 문제'에 사용합니다.
    """


class AuthenticationError(ScoutingIntegrationError):
    """API 키가 없거나, 거부되었을 때(HTTP 401/403 등) 사용합니다."""


class ExternalAPIError(ScoutingIntegrationError):
    """
    네트워크 실패, 타임아웃, 5xx, 또는 API 본문의 errors 필드 등
    '외부 서비스 쪽 문제'에 사용합니다.
    """
