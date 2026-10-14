"""SQLAlchemy 模型：映射库里**已经存在**的 10 张表。

这些表由 sql/01–07 建好，模型只做映射，不负责建表；
以后 schema 变更走 Alembic（先把现状 stamp 成 baseline）。

关于 vector(1024)：asyncpg 不认识 pgvector 的类型，直接用会报未知类型。
所以这里自定义了一个 `Vector` 类型，读写时自动在「Python 列表」和
「'[0.1,0.2,...]' 文本」之间转换。
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Identity, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import UserDefinedType


class Vector(UserDefinedType):
    """pgvector 的 vector 类型。"""

    cache_ok = True

    def __init__(self, dim: int | None = None) -> None:
        self.dim = dim

    def get_col_spec(self, **kw: object) -> str:
        return f"vector({self.dim})" if self.dim else "vector"

    def bind_processor(self, dialect: object):  # type: ignore[no-untyped-def]
        def process(value):  # type: ignore[no-untyped-def]
            if value is None:
                return None
            if isinstance(value, str):
                return value
            return "[" + ",".join(repr(float(x)) for x in value) + "]"

        return process

    def result_processor(self, dialect: object, coltype: object):  # type: ignore[no-untyped-def]
        def process(value):  # type: ignore[no-untyped-def]
            if value is None or not isinstance(value, str):
                return value
            body = value.strip().strip("[]")
            return [float(x) for x in body.split(",")] if body else []

        return process


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=func.gen_random_uuid())
    title: Mapped[str | None] = mapped_column(Text)
    user_id: Mapped[UUID | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=func.gen_random_uuid())
    filename: Mapped[str] = mapped_column(Text)
    storage_path: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    char_count: Mapped[int | None] = mapped_column(Integer)
    user_id: Mapped[UUID | None] = mapped_column()
    # pending → embedding → ready；失败走 failed（可重试）或 dead（死信）
    status: Mapped[str] = mapped_column(Text, server_default="pending")
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dead_lettered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    conversation_id: Mapped[UUID] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text)
    sources: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Chunk(Base):
    __tablename__ = "chunks"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    document_id: Mapped[UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    idx: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    char_count: Mapped[int] = mapped_column(Integer)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ChatMetric(Base):
    __tablename__ = "chat_metrics"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[UUID | None] = mapped_column()
    conversation_id: Mapped[UUID | None] = mapped_column()
    model: Mapped[str | None] = mapped_column(Text)
    retrieval_ms: Mapped[int | None] = mapped_column(Integer)
    first_token_ms: Mapped[int | None] = mapped_column(Integer)
    total_ms: Mapped[int | None] = mapped_column(Integer)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer)
    completion_tokens: Mapped[int | None] = mapped_column(Integer)
    retrieved_count: Mapped[int | None] = mapped_column(Integer)
    used_count: Mapped[int | None] = mapped_column(Integer)
    refused: Mapped[bool] = mapped_column(Boolean, server_default="false")
    cached: Mapped[bool] = mapped_column(Boolean, server_default="false")
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmbeddingCache(Base):
    __tablename__ = "embedding_cache"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    model: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AnswerCache(Base):
    __tablename__ = "answer_cache"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[UUID] = mapped_column()
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    sources: Mapped[list | None] = mapped_column(JSONB)
    used_count: Mapped[int | None] = mapped_column(Integer)
    threshold: Mapped[float | None] = mapped_column(Float)
    model: Mapped[str | None] = mapped_column(Text)
    corpus_version: Mapped[str | None] = mapped_column(Text)
    hits: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_hit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RateLimit(Base):
    __tablename__ = "rate_limits"

    bucket_key: Mapped[str] = mapped_column(Text, primary_key=True)
    tokens: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ClientError(Base):
    __tablename__ = "client_errors"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[UUID | None] = mapped_column()
    kind: Mapped[str | None] = mapped_column(Text)
    message: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(Text)
    stack: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    user_agent: Mapped[str | None] = mapped_column(Text)
    meta: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UploadSession(Base):
    __tablename__ = "upload_sessions"

    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[UUID] = mapped_column()
    filename: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    fingerprint: Mapped[str] = mapped_column(Text)
    chunk_size: Mapped[int] = mapped_column(Integer)
    total_parts: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, server_default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
