"""
환경 변수(.env)에서 민감 정보를 읽는 전용 모듈.

인수인계 시 참고:
- API 키·시크릿은 반드시 이 모듈을 통해서만 읽습니다.
- 코드 저장소에는 .env를 넣지 말고, .env.example만 커밋하세요.
- load_dotenv()는 애플리케이션 진입점(스크립트 main, 웹앱 factory)에서
  한 번 호출하는 것을 권장합니다. 중복 호출은 무해합니다.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

from scouting.errors import ConfigurationError

# 프로젝트 루트: scouting 패키지의 부모 디렉터리
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# API-Football(api-sports) 대시보드에서 발급받은 키
ENV_API_FOOTBALL_KEY = "API_FOOTBALL_KEY"


def ensure_env_loaded() -> None:
    """
    .env 파일을 프로젝트 루트에서 읽어 os.environ에 반영합니다.

    우선순위는 python-dotenv 기본 동작과 동일합니다.
    이미 셸에 export 된 값이 있으면 .env보다 우선합니다.
    """
    load_dotenv(PROJECT_ROOT / ".env")


def get_api_football_key() -> str:
    """
    API-Football용 키를 반환합니다.

    Raises:
        ConfigurationError: 키가 비어 있거나 공백만 있는 경우.
    """
    ensure_env_loaded()
    key = (os.environ.get(ENV_API_FOOTBALL_KEY) or "").strip()
    if not key:
        raise ConfigurationError(
            f"{ENV_API_FOOTBALL_KEY}가 설정되어 있지 않습니다. "
            "프로젝트 루트의 .env 파일을 확인하세요.",
            technical_detail="missing_or_empty_env_API_FOOTBALL_KEY",
        )
    return key
