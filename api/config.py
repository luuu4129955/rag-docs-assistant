"""配置：全部来自环境变量 / .env，代码里不出现任何密钥。

字段的 env 名同时接受两种写法：带 NUXT_ 前缀的（沿用现有 .env，不用改）
和不带前缀的。这样迁移期间前后端可以共用同一份 .env。
"""

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# docs-qa/.env —— 用绝对路径，避免 cwd 不同时读不到
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # ---------- Supabase ----------
    supabase_url: str = Field(
        default="",
        validation_alias=AliasChoices("SUPABASE_URL", "NUXT_SUPABASE_URL"),
    )
    supabase_service_key: str = Field(
        default="",
        validation_alias=AliasChoices("SUPABASE_SERVICE_KEY", "NUXT_SUPABASE_SERVICE_KEY"),
    )
    # 直连数据库（B 档新增）。service key 不能当数据库密码用，必须是完整连接串。
    # app 角色受 RLS 约束；admin 角色带 BYPASSRLS，给后台任务用，留空则复用上面那条。
    supabase_db_url: str = Field(
        default="",
        validation_alias=AliasChoices("SUPABASE_DB_URL", "NUXT_SUPABASE_DB_URL"),
    )
    supabase_db_admin_url: str = Field(
        default="",
        validation_alias=AliasChoices("SUPABASE_DB_ADMIN_URL", "NUXT_SUPABASE_DB_ADMIN_URL"),
    )
    # 不填就走 JWKS 公钥验签（推荐）；填了则按 HS256 对称密钥验签
    supabase_jwt_secret: str = Field(
        default="",
        validation_alias=AliasChoices("SUPABASE_JWT_SECRET", "NUXT_SUPABASE_JWT_SECRET"),
    )

    # ---------- 聊天模型（P5 才用，先占位）----------
    deepseek_key: str = Field(
        default="",
        validation_alias=AliasChoices("DEEPSEEK_KEY", "NUXT_DEEPSEEK_KEY"),
    )
    chat_key: str = Field(
        default="",
        validation_alias=AliasChoices("CHAT_KEY", "NUXT_CHAT_KEY"),
    )
    chat_base: str = Field(
        default="https://api.deepseek.com",
        validation_alias=AliasChoices("CHAT_BASE", "NUXT_CHAT_BASE"),
    )
    chat_model: str = Field(
        default="deepseek-chat",
        validation_alias=AliasChoices("CHAT_MODEL", "NUXT_CHAT_MODEL"),
    )

    # ---------- 向量化与重排 ----------
    embedding_key: str = Field(
        default="",
        validation_alias=AliasChoices("EMBEDDING_KEY", "NUXT_EMBEDDING_KEY"),
    )
    embedding_base: str = Field(
        default="https://api.siliconflow.cn/v1",
        validation_alias=AliasChoices("EMBEDDING_BASE", "NUXT_EMBEDDING_BASE"),
    )
    embedding_model: str = Field(
        default="BAAI/bge-m3",
        validation_alias=AliasChoices("EMBEDDING_MODEL", "NUXT_EMBEDDING_MODEL"),
    )
    rerank_model: str = Field(
        default="BAAI/bge-reranker-v2-m3",
        validation_alias=AliasChoices("RERANK_MODEL", "NUXT_RERANK_MODEL"),
    )
    rerank_top_n: int = Field(
        default=20,
        validation_alias=AliasChoices("RERANK_TOP_N", "NUXT_RERANK_TOP_N"),
    )
    rerank_threshold: float = Field(
        default=0.1,
        validation_alias=AliasChoices("RERANK_THRESHOLD", "NUXT_RERANK_THRESHOLD"),
    )

    # ---------- 检索参数 ----------
    rag_top_k: int = Field(
        default=6,
        validation_alias=AliasChoices("RAG_TOP_K", "NUXT_RAG_TOP_K"),
    )
    rag_threshold: float = Field(
        default=0.35,
        validation_alias=AliasChoices("RAG_THRESHOLD", "NUXT_RAG_THRESHOLD"),
    )

    # ---------- 鉴权细节 ----------
    supabase_jwt_audience: str = Field(
        default="authenticated",
        validation_alias=AliasChoices("SUPABASE_JWT_AUDIENCE", "NUXT_SUPABASE_JWT_AUDIENCE"),
    )

    # ---------- 存储 ----------
    storage_bucket: str = Field(
        default="docs",
        validation_alias=AliasChoices("STORAGE_BUCKET", "NUXT_STORAGE_BUCKET"),
    )
    max_upload_mb: int = Field(
        default=40,
        validation_alias=AliasChoices("MAX_UPLOAD_MB", "NUXT_MAX_UPLOAD_MB"),
    )

    # ---------- 开关键（与 Nuxt 侧同名，方便两边同时调）----------
    hybrid_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("HYBRID_ENABLED", "NUXT_HYBRID_ENABLED"),
    )
    embedding_cache: bool = Field(
        default=True,
        validation_alias=AliasChoices("EMBEDDING_CACHE", "NUXT_EMBEDDING_CACHE"),
    )
    answer_cache: bool = Field(
        default=True,
        validation_alias=AliasChoices("ANSWER_CACHE", "NUXT_ANSWER_CACHE"),
    )
    cache_ttl_days: int = Field(
        default=7,
        validation_alias=AliasChoices("CACHE_TTL_DAYS", "NUXT_CACHE_TTL_DAYS"),
    )

    # ---------- 限流 ----------
    rate_limit_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("RATE_LIMIT_ENABLED", "NUXT_RATE_LIMIT_ENABLED"),
    )
    rate_limit_chat_per_min: int = Field(
        default=30,
        validation_alias=AliasChoices("RATE_LIMIT_CHAT_PER_MIN", "NUXT_RATE_LIMIT_CHAT_PER_MIN"),
    )
    rate_limit_chat_burst: int = Field(
        default=20,
        validation_alias=AliasChoices("RATE_LIMIT_CHAT_BURST", "NUXT_RATE_LIMIT_CHAT_BURST"),
    )

    # ---------- 后台任务 ----------
    jobs_secret: str = Field(
        default="",
        validation_alias=AliasChoices("JOBS_SECRET", "NUXT_JOBS_SECRET"),
    )
    jobs_max_attempts: int = Field(
        default=3,
        validation_alias=AliasChoices("JOBS_MAX_ATTEMPTS", "NUXT_JOBS_MAX_ATTEMPTS"),
    )
    jobs_retry_base_sec: int = Field(
        default=30,
        validation_alias=AliasChoices("JOBS_RETRY_BASE_SEC", "NUXT_JOBS_RETRY_BASE_SEC"),
    )

    # ---------- 告警与成本 ----------
    alert_webhook: str = Field(
        default="",
        validation_alias=AliasChoices("ALERT_WEBHOOK", "NUXT_ALERT_WEBHOOK"),
    )
    price_in_per_m: float = Field(
        default=0.0,
        validation_alias=AliasChoices("PRICE_IN_PER_M", "NUXT_PRICE_IN_PER_M"),
    )
    price_out_per_m: float = Field(
        default=0.0,
        validation_alias=AliasChoices("PRICE_OUT_PER_M", "NUXT_PRICE_OUT_PER_M"),
    )

    # 重排序接口地址：留空则复用 embedding_base（硅基流动同一个域名）
    rerank_base: str = Field(
        default="",
        validation_alias=AliasChoices("RERANK_BASE", "NUXT_RERANK_BASE"),
    )

    # 对外 HTTP 是否读取系统/环境代理。默认关：httpx 会把 macOS 系统代理也读进来，
    # 而那个代理未必连得通，会让本该直连的域名报 ConnectError（见 api/http.py）。
    http_trust_env: bool = Field(
        default=False,
        validation_alias=AliasChoices("HTTP_TRUST_ENV", "NUXT_HTTP_TRUST_ENV"),
    )

    @property
    def chat_key_resolved(self) -> str:
        """chat_key 优先，没配就退回 deepseek_key（与 TS 版口径一致）。"""
        return (self.chat_key or self.deepseek_key).strip()

    @property
    def rerank_base_resolved(self) -> str:
        return (self.rerank_base or self.embedding_base).rstrip("/")

    @property
    def db_url(self) -> str:
        return self.supabase_db_url.strip()

    @property
    def db_admin_url(self) -> str:
        return (self.supabase_db_admin_url or self.supabase_db_url).strip()


@lru_cache
def get_settings() -> Settings:
    return Settings()
