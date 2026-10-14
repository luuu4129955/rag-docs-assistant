"""返回最近一次 `node eval/run.mjs` 的结果，给页面上的「评测」面板用。

评测脚本是 Node 写的、打的是 HTTP 接口，迁移到 Python 后**完全不用改** ——
它只认接口形状，不认后端语言。这也是当初把评测集和实现分开的收益。
"""

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api", tags=["eval"])

_LATEST = Path(__file__).resolve().parents[2] / "eval" / "latest.json"


@router.get("/eval/latest")
async def latest_eval() -> dict:
    try:
        return json.loads(_LATEST.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="还没有评测记录") from None
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="评测记录读取失败") from None
