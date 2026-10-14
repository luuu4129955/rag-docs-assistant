"""会话与消息入参。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ConversationPatch(BaseModel):
    title: str


class CitationSource(BaseModel):
    n: int = 0
    filename: str = ""
    idx: int = 0
    similarity: float = 0.0
    content: str = ""


class Citations(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    sources: list[CitationSource] = Field(default_factory=list)
    used_count: int = Field(default=0, alias="usedCount")
    threshold: float = 0.0


class MessageCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    conversation_id: str = Field(alias="conversationId")
    role: Literal["system", "user", "assistant"]
    content: str
    citations: Citations | None = None
