"""上下文组装与系统提示。

移植自 server/utils/context.ts 的 buildContext / buildSystemPrompt。

三个刻意的设计：
  1. 小检索、大上下文：检索用小块（精准命中），喂模型时把命中块的**前后邻居**
     一起带上，避免答案正好跨在切口上、模型看到的是半句话。
  2. 预算约束：上下文不是越长越好 —— 越长越贵，也越容易被无关内容带偏。
  3. 编号与来源一一对应：块的编号就是前端来源列表里的编号，[1] 永远指向同一条。
"""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..log import log_event
from ..models import Chunk
from .retrieve import RetrievedChunk

DEFAULT_CONTEXT_BUDGET_CHARS = 3200


@dataclass(frozen=True)
class ContextBlock:
    n: int
    label: str
    text: str


async def build_context(
    session: AsyncSession,
    hits: list[RetrievedChunk],
    budget_chars: int = DEFAULT_CONTEXT_BUDGET_CHARS,
) -> list[ContextBlock]:
    if not hits:
        return []

    doc_ids = list({h.document_id for h in hits})

    # 一次性把涉及的文档分块取回来（文档不多时够用），再在内存里挑邻居
    try:
        rows = (
            await session.execute(
                select(Chunk.document_id, Chunk.idx, Chunk.content).where(
                    Chunk.document_id.in_(doc_ids)
                )
            )
        ).all()
    except Exception as exc:  # noqa: BLE001
        log_event("context.fetch_failed", message=str(exc)[:200])
        rows = []

    by_key = {f"{row.document_id}#{row.idx}": row.content for row in rows}

    blocks: list[ContextBlock] = []
    used = 0

    for index, hit in enumerate(hits):
        room = budget_chars - used
        # 留不出像样的空间就不再追加，避免塞进半截材料
        if room < 200:
            break

        keys = [
            f"{hit.document_id}#{hit.idx - 1}",
            f"{hit.document_id}#{hit.idx}",
            f"{hit.document_id}#{hit.idx + 1}",
        ]
        parts = [by_key[key] for key in keys if key in by_key]
        content = "\n…\n".join(parts) if parts else hit.content
        if len(content) > room:
            content = content[:room] + "…"
        used += len(content)

        blocks.append(
            ContextBlock(n=index + 1, label=f"《{hit.filename}》第 {hit.idx} 块", text=content)
        )

    return blocks


def build_system_prompt(blocks: list[ContextBlock]) -> str:
    """把召回的分块拼成系统提示。

    三条规则对应三种失效：用自己的知识补充 → 幻觉；不标引用 → 无法溯源；
    材料没有却硬答 → 编造。
    """
    context = "\n\n".join(f"[{b.n}]（来自{b.label}）\n{b.text}" for b in blocks)

    return f"""你是文档问答助手，只能依据下面提供的材料回答。

输出格式（必须严格遵守）：
1. 先说结论，再分点说明，用中文，保持简洁。
2. 每一个要点结尾都必须标注依据编号，写成 [1] 或 [1][3]。
   正确示例：主包从 569KB 降到 62KB [1]
   错误示例：主包从 569KB 降到 62KB（没有编号 —— 不允许出现）
3. 只使用材料里的事实，不要用你自己的知识补充或推测。
4. 材料往往只是要点式的笔记，只要里面有相关信息，就基于它归纳作答，
   并说明材料覆盖到哪一步；只有材料完全答不了这个问题时，才回答「材料里没有提到」。

材料：
{context}"""
