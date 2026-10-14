"""对话与检索的入参。

字段名沿用前端发过来的 camelCase（用 alias 映射），
这样前端一行都不用改。
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MAX_TURNS = 20
MAX_CHARS = 4000


class MessageIn(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    messages: list[MessageIn] = Field(default_factory=list)
    conversation_id: str | None = Field(default=None, alias="conversationId")


class SearchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str
    k: int = 5
    # 调试面板可以传 hybrid=false 做对照（关掉关键词那一路）
    hybrid: bool | None = None
