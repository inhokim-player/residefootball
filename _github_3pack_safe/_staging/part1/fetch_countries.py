"""
국가 목록을 API-Football에서 받아 countries.json으로 저장하는 CLI 스크립트.

인수인계 시 참고:
- 실제 HTTP·에러 처리 로직은 scouting.football_client 에 있습니다.
- 이 파일은 '운영 배치' 또는 로컬 개발용 진입점만 담당합니다.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from scouting.football_client import FootballAPIClient
from scouting.notifications import notify_info

OUTPUT_PATH = Path(__file__).resolve().parent / "countries.json"


def main() -> int:
    """
    Returns:
        0: 파일 저장까지 성공
        1: 설정/API/네트워크 등으로 저장하지 못함 (예외 없이 종료)
    """
    client = FootballAPIClient()
    result = client.fetch_countries_merged()

    if not result.success or result.data is None:
        # 실패 알림은 클라이언트 내부에서 이미 notify_failure 호출됨
        return 1

    OUTPUT_PATH.write_text(
        json.dumps(result.data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    notify_info(f"{result.message_for_operator} → {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
