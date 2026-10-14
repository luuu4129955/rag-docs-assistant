"""结构化日志：一行一个 JSON。

和 TS 版的 `logEvent` 口径一致 —— 平台日志里可以直接按字段搜
（比如 `event=chat.error`、`userId=xxx`），不用在中文句子里肉眼找。
"""

import json
from datetime import UTC, datetime
from typing import Any


def log_event(event: str, **data: Any) -> None:
    payload: dict[str, Any] = {"ts": datetime.now(UTC).isoformat(), "event": event, **data}
    print(json.dumps(payload, ensure_ascii=False, default=str), flush=True)
