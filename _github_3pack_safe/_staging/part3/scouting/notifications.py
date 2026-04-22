"""
운영자 알림 및 로깅 설정.

인수인계 시 참고:
- 프로데이터 연동 실패 시 '시스템 전체가 죽지' 않게 하려면,
  예외를 삼키고 APIResult + notify_failure() 조합을 권장합니다.
- 나중에 Slack/이메일/Webhook으로 바꿀 때는 notify_failure / notify_warning
  본문만 교체하면 됩니다(호출부는 그대로).
"""

from __future__ import annotations

import logging
import sys
from typing import Literal

# 다른 모듈에서 동일 이름의 로거를 가져다 쓰면 설정이 공유됩니다.
LOGGER_NAME = "scouting.integration"
_log_configured = False

LevelName = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


def setup_logging(level: LevelName = "INFO") -> None:
    """
    표준 출력으로 한 줄 로그를 남깁니다.

    Flask/FastAPI 등에 붙일 때는 이 함수 대신 프레임워크 로깅 설정에
    LOGGER_NAME 로거를 연결해도 됩니다.
    """
    global _log_configured
    if _log_configured:
        return

    root = logging.getLogger(LOGGER_NAME)
    root.setLevel(getattr(logging, level))
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root.addHandler(handler)
    _log_configured = True


def notify_info(message: str) -> None:
    """정상 흐름에서 운영자가 알고 있으면 좋은 정보."""
    setup_logging()
    logging.getLogger(LOGGER_NAME).info(message)
    # 콘솔 사용자가 로그 레벨을 높여도 메시지를 놓치지 않도록 한 줄 출력
    # Windows cp949 콘솔에서도 깨지지 않게 출력
    safe = f"[스카우팅 연동] {message}".encode(sys.stdout.encoding or "utf-8", errors="replace").decode(
        sys.stdout.encoding or "utf-8", errors="replace"
    )
    print(safe)


def notify_warning(message: str, *, technical_detail: str | None = None) -> None:
    """복구 가능한 이상(재시도, 캐시 사용 등)."""
    setup_logging()
    log = logging.getLogger(LOGGER_NAME)
    log.warning("%s | detail=%s", message, technical_detail or "-")
    safe = f"[스카우팅 연동 경고] {message}".encode(sys.stderr.encoding or "utf-8", errors="replace").decode(
        sys.stderr.encoding or "utf-8", errors="replace"
    )
    print(safe, file=sys.stderr)


def notify_failure(message: str, *, technical_detail: str | None = None) -> None:
    """외부 API 실패·인증 실패 등 운영 개입이 필요할 수 있는 상황."""
    setup_logging()
    log = logging.getLogger(LOGGER_NAME)
    log.error("%s | detail=%s", message, technical_detail or "-")
    safe = f"[스카우팅 연동 실패] {message}".encode(sys.stderr.encoding or "utf-8", errors="replace").decode(
        sys.stderr.encoding or "utf-8", errors="replace"
    )
    print(safe, file=sys.stderr)
