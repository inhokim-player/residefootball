"""
새 인수인계 Markdown 스냅샷을 docs/handover/ 에 생성합니다.

사용:
  python scripts/write_handover_snapshot.py

생성 후 파일을 열어 이번 변경 내용을 직접 채워 넣으세요.
비밀번호·API 키·토큰 값은 절대 적지 마세요.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    out_dir = root / "docs" / "handover"
    out_dir.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    path = out_dir / f"HANDOVER_{today}.md"
    if path.exists():
        print(f"이미 존재합니다: {path}")
        return 0
    path.write_text(
        "\n".join(
            [
                f"# U25 인수인계 스냅샷 — {today}",
                "",
                "## 이번 변경 요약",
                "",
                "- (여기에 한 줄 요약)",
                "",
                "## 영향 범위",
                "",
                "- 백엔드:",
                "- 프런트:",
                "- 데이터/배치:",
                "",
                "## 환경 변수 / 설정",
                "",
                "- `.env` 키: (값은 적지 말 것)",
                "- `data/automation_config.json`:",
                "",
                "## 실행 / 검증",
                "",
                "```bash",
                "# 예: python -m uvicorn u25_api:app --host 127.0.0.1 --port 8010",
                "```",
                "",
                "## 롤백 / 주의",
                "",
                "-",
                "",
            ]
        ),
        encoding="utf-8",
    )
    print(f"작성됨: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
