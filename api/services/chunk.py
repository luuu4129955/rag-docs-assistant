"""文本清洗与分块 —— 逐条移植自 server/utils/chunk.ts，行为保持一致。

为什么要先按标题切：固定字数切法会把「三、资源优化」的正文切到
「四、构建配置」那块去，检索到的块看着相关、其实上下文是错的。
按标题分节后正文不会跨节，而且每块都带上所属标题 —— 标题本身就是很强的检索信号。
"""

import re
import unicodedata

_CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
# 孤立代理项无法编码成合法 UTF-8
_LONE_HIGH = re.compile(r"[\ud800-\udbff](?![\udc00-\udfff])")
_LONE_LOW = re.compile(r"(?<![\ud800-\udbff])[\udc00-\udfff]")
# PDF 常用康熙部首区的字替代常规汉字（⼀ vs 一）；只对这些字符做兼容分解，
# 不用整串 NFKC，否则中文全角标点也会被换成半角。
_KANGXI = re.compile(r"[\u2e80-\u2eff\u2f00-\u2fdf\uf900-\ufaff]")
_FRONTMATTER = re.compile(r"^---\r?\n[\s\S]*?\r?\n---\r?\n?")
_HEADING = re.compile(r"^#{1,6}\s+\S")

DEFAULT_CHUNK_SIZE = 600
# overlap 取 size 的 10%~20%：太小挡不住语义被切断，太大则相邻块大量重复
DEFAULT_CHUNK_OVERLAP = 90


def sanitize_text(value: str) -> str:
    """清洗解析出来的内容。

    Postgres 的 text 类型不接受 NUL（\\u0000），而 PDF 解析经常产出 NUL
    和零散控制字符，直接入库会报 unsupported Unicode escape sequence。
    """
    text = _CONTROL.sub("", value)
    text = _LONE_HIGH.sub("", text)
    text = _LONE_LOW.sub("", text)
    return _KANGXI.sub(lambda m: unicodedata.normalize("NFKC", m.group(0)), text)


def chunk_text(
    input_text: str,
    size: int = DEFAULT_CHUNK_SIZE,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[str]:
    text = sanitize_text(input_text)
    # 去掉开头的 YAML 头：没有答案价值，却会被切成一个块占检索名额
    text = _FRONTMATTER.sub("", text, count=1)
    text = text.replace("\r\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return []

    chunks: list[str] = []

    for heading, body in _split_by_headings(text):
        pieces = _split_by_size(body, size, overlap) if body else []

        if not pieces:
            # 只有标题、没有正文：并进上一块，别让它单独占一个检索名额
            if chunks and heading:
                chunks[-1] = f"{chunks[-1]}\n{heading}"
            elif heading:
                chunks.append(heading)
            continue

        for piece in pieces:
            with_heading = f"{heading}\n{piece}" if heading else piece
            # 碎块（不足 80 字）并进上一块，避免切出「只有一句话」的块
            prev = chunks[-1] if chunks else None
            if prev is not None and len(with_heading) < 80 and len(prev) + len(with_heading) < size * 1.6:
                chunks[-1] = f"{prev}\n{with_heading}"
            else:
                chunks.append(with_heading)

    return chunks


def _split_by_headings(text: str) -> list[tuple[str, str]]:
    """按 markdown 标题把文本分成若干节；标题行本身留着，作为每块的前缀。"""
    sections: list[tuple[str, str]] = []
    heading = ""
    lines: list[str] = []

    def flush() -> None:
        body = "\n".join(lines).strip()
        if body or heading:
            sections.append((heading, body))
        lines.clear()

    for line in text.split("\n"):
        stripped = line.strip()
        if _HEADING.match(stripped):
            flush()
            heading = stripped
            continue
        lines.append(line)
    flush()

    return sections


def _split_by_size(text: str, size: int, overlap: int) -> list[str]:
    """按字数切块，尽量落在段落/句子边界；切不动就硬切。"""
    chunks: list[str] = []
    start = 0
    total = len(text)

    while start < total:
        end = min(start + size, total)

        if end < total:
            window = text[start:end]
            cut = max(
                window.rfind("\n\n"),
                window.rfind("。"),
                window.rfind("\n"),
                window.rfind(". "),
            )
            # 只有切点足够靠后才采用，否则宁可硬切，避免切出过短的碎块
            if cut > size * 0.5:
                end = start + cut + 1

        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)

        if end >= total:
            break
        # 保证每次至少前进 1 个字符，避免死循环
        start = max(end - overlap, start + 1)

    return chunks
