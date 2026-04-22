"""
외부 API 호출 결과를 담는 불변(immutable) 데이터 객체.

인수인계 시 참고:
- 호출이 실패해도 프로세스가 예외로 중단되지 않게 하려면,
  이 타입을 반환하는 클라이언트 메서드를 사용하세요(success 플래그 확인).
- technical_detail은 운영자 로그·슬랙 등에 넣기 좋고,
  message_for_operator는 사람이 읽기 쉬운 한국어 안내입니다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class APIResult(Generic[T]):
    """외부 API 한 번(또는 한 흐름)의 호출 결과를 표현합니다."""

    success: bool
    """True면 data가 유효합니다."""

    data: T | None = None
    """성공 시 페이로드(보통 dict 또는 list). 실패 시 None."""

    message_for_operator: str = ""
    """대시보드·콘솔·알림에 보여줄 사용자용 메시지(한국어 권장)."""

    technical_detail: str | None = None
    """개발자·로그용 부가 정보(스택 트레이스 문자열은 넣지 마세요)."""
