"""分块算法的单测。

这些是最该有测试的地方 —— 逻辑分支多、又直接影响检索质量，
而且完全不需要数据库就能验。
"""

from api.services.chunk import chunk_text, sanitize_text


def test_sanitize_removes_control_chars_but_keeps_whitespace():
    # Postgres 的 text 类型不接受 NUL，PDF 解析又经常产出它
    assert sanitize_text("a\x00b\x07c") == "abc"
    assert sanitize_text("a\nb\tc\rd") == "a\nb\tc\rd"


def test_empty_input_yields_no_chunks():
    assert chunk_text("") == []
    assert chunk_text("   \n\n   ") == []


def test_frontmatter_is_dropped():
    text = "---\ntitle: 某文档\n---\n# 标题\n正文内容"
    chunks = chunk_text(text)
    assert all("title: 某文档" not in c for c in chunks)
    assert any("标题" in c for c in chunks)


def test_heading_is_kept_as_prefix_of_every_chunk():
    text = "# 第一节\n" + "内容" * 400
    chunks = chunk_text(text, size=200, overlap=20)
    assert len(chunks) > 1
    assert all(c.startswith("# 第一节") for c in chunks)


def test_body_does_not_leak_across_headings():
    """固定字数切法会把上一节的正文切到下一节里 —— 按标题分节就是为了防这个。"""
    text = "# A\n" + "甲" * 100 + "\n# B\n" + "乙" * 100
    chunks = chunk_text(text, size=600, overlap=90)
    assert any("甲" in c and "乙" not in c for c in chunks)
    assert any("乙" in c and "甲" not in c for c in chunks)


def test_tiny_section_merges_into_previous_chunk():
    text = "# A\n" + "甲" * 300 + "\n# B\n短"
    chunks = chunk_text(text, size=600, overlap=50)
    assert len(chunks) == 1
    assert "短" in chunks[0]


def test_long_text_produces_multiple_chunks():
    text = "正文" * 2000  # 4000 字符
    chunks = chunk_text(text, size=600, overlap=90)
    assert len(chunks) > 1
    # 每块都不该明显超过 size（允许标题前缀带来的少量超出）
    assert all(len(c) <= 600 + 120 for c in chunks)
