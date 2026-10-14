"""检索相关纯逻辑的单测：缓存键、RRF 融合、向量字面量。"""

from uuid import uuid4

from api.services.answer_cache import cache_key_of, normalize_question
from api.services.retrieve import RetrievedChunk, fuse_by_rrf, vector_literal


def _chunk(idx: int, doc_id=None, similarity: float = 0.5, content: str = "x") -> RetrievedChunk:
    return RetrievedChunk(
        id=idx,
        document_id=doc_id or uuid4(),
        filename="a.md",
        idx=idx,
        content=content,
        similarity=similarity,
    )


def test_cache_key_is_order_sensitive_and_stable():
    a = cache_key_of(["u1", "model", 0.35])
    b = cache_key_of(["u1", "model", 0.35])
    c = cache_key_of(["model", "u1", 0.35])
    assert a == b
    assert a != c


def test_normalize_question_collapses_whitespace_and_case():
    assert normalize_question("  What   IS  RAG? ") == normalize_question("what is rag?")


def test_vector_literal_uses_pgvector_format():
    assert vector_literal([0.5, 1.0, -0.25]) == "[0.5,1.0,-0.25]"
    assert vector_literal([]) == "[]"


def test_rrf_prefers_chunks_found_by_both_paths():
    """两路都命中的块应该排在只被单路命中的前面 —— 这正是 RRF 的价值。"""
    doc = uuid4()
    vector_list = [_chunk(1, doc, 0.9), _chunk(2, doc, 0.8)]
    keyword_list = [_chunk(2, doc, 0.0), _chunk(3, doc, 0.0)]

    fused = fuse_by_rrf([("vector", vector_list), ("keyword", keyword_list)], limit=3)

    assert fused[0].idx == 2
    assert set(fused[0].found_by) == {"vector", "keyword"}
    assert fused[0].fusion_score is not None
    assert fused[0].fusion_score == 1 / 62 + 1 / 61


def test_rrf_dedupes_by_document_and_index():
    doc = uuid4()
    fused = fuse_by_rrf(
        [("vector", [_chunk(1, doc)]), ("keyword", [_chunk(1, doc, similarity=0.0)])],
        limit=5,
    )
    assert len(fused) == 1


def test_rrf_respects_limit():
    doc = uuid4()
    items = [_chunk(i, doc) for i in range(10)]
    fused = fuse_by_rrf([("vector", items)], limit=3)
    assert len(fused) == 3
    # 名次靠前的分数更高，所以保留下来的应该是前三个
    assert [c.idx for c in fused] == [0, 1, 2]
