"""文档解析：二进制 → 纯文本。

对应 TS 版的 server/utils/ingest.ts（原来用 unpdf）。
Python 侧用 pypdf：纯 Python、无系统依赖，装起来省事。

已知边界（与 TS 版一致）：扫描版 PDF 没有文字层，需要先做 OCR；
这里只会返回极少或空白文本，由上层判定为「没有解析出文字内容」。
"""

from io import BytesIO

TEXT_EXTENSIONS = frozenset({"md", "markdown", "txt", "text", "csv", "json"})


def extension_of(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def is_supported(ext: str) -> bool:
    return ext == "pdf" or ext in TEXT_EXTENSIONS


def extract_text(data: bytes, ext: str) -> str:
    if ext == "pdf":
        return _pdf_to_text(data)
    # 纯文本：解不出来也别整个失败，替换掉坏字节即可
    return data.decode("utf-8", errors="replace")


def _pdf_to_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(data))
    pages: list[str] = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            # 单页坏掉不该让整份文档失败
            pages.append("")
    return "\n\n".join(pages)
