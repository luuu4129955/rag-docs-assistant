"""文档路由：列表 / 单次上传 / 原文预览。

上传在这里只做两件便宜的事：把文件存进桶、写一条 status=pending 的记录。
解析、分块、向量化都交给后台任务（/api/jobs/tick）——
它们耗时长还可能失败，放在请求里会让用户干等、超时后还留下半截数据。
"""

from typing import Annotated
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from ..config import get_settings
from ..deps import AdminSessionDep, CurrentUser, SessionDep
from ..log import log_event
from ..repositories import documents as repo
from ..services import storage
from ..services.ingest import extension_of, is_supported
from ..services.rate_limit import enforce

router = APIRouter(prefix="/api", tags=["documents"])

# 单次上传这条（兼容老前端）保持 4MB 上限；更大的文件走分片上传
MAX_SINGLE_SHOT_BYTES = 4 * 1024 * 1024

_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "md": "text/markdown; charset=utf-8",
    "markdown": "text/markdown; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
}


def _content_type(ext: str) -> str:
    return _CONTENT_TYPES.get(ext, "text/plain; charset=utf-8")


def _storage_path(user_id: UUID, ext: str) -> str:
    """存储键 = 用户目录 + 随机名：原文件名可能有中文、空格、重名。"""
    import secrets
    import time

    return f"{user_id}/{int(time.time() * 1000)}-{secrets.token_hex(4)}.{ext}"


@router.get("/documents")
async def list_documents(user: CurrentUser, session: SessionDep) -> list[dict]:
    documents = await repo.list_documents(session, user.id)
    doc_ids = [d.id for d in documents]
    counts = await repo.chunk_counts(session, doc_ids)
    embedded = await repo.embedded_counts(session, doc_ids)

    return [
        {
            "id": str(doc.id),
            "filename": doc.filename,
            "char_count": doc.char_count,
            "status": doc.status,
            "error": doc.error,
            "created_at": doc.created_at,
            "attempts": doc.attempts,
            "next_retry_at": doc.next_retry_at,
            "dead_lettered_at": doc.dead_lettered_at,
            "chunkCount": counts.get(doc.id, 0),
            "embeddedCount": embedded.get(doc.id, 0),
        }
        for doc in documents
    ]


@router.post("/documents")
async def upload_document(
    user: CurrentUser,
    session: SessionDep,
    admin: AdminSessionDep,
    file: Annotated[UploadFile, File()],
) -> dict:
    settings = get_settings()
    await enforce(admin, settings, str(user.id), "uploadComplete")

    filename = file.filename or "unnamed"
    ext = extension_of(filename)
    if not is_supported(ext):
        raise HTTPException(status_code=400, detail=f"暂不支持 .{ext} 格式，请上传 PDF / Markdown / TXT")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_SINGLE_SHOT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"单次上传上限 {MAX_SINGLE_SHOT_BYTES // 1024 // 1024}MB，更大的文件请走分片上传",
        )

    path = _storage_path(user.id, ext)
    await storage.upload(settings, path, data, file.content_type or "application/octet-stream")

    try:
        doc = await repo.insert_document(
            session,
            user_id=user.id,
            filename=filename,
            storage_path=path,
            size_bytes=len(data),
        )
    except Exception as exc:  # noqa: BLE001
        # 补偿：数据库回滚了，存储不会跟着回滚，得手动补上
        await storage.remove(settings, [path])
        log_event("documents.insert_failed", message=str(exc)[:200])
        raise HTTPException(status_code=500, detail="写入文档记录失败") from None

    return {"id": str(doc.id), "filename": doc.filename, "status": doc.status, "queued": True}


@router.get("/documents/{document_id}/file")
async def get_document_file(
    document_id: UUID,
    user: CurrentUser,
    session: SessionDep,
    download: bool = False,
) -> Response:
    """取原始文件：给「来源」面板的在线预览用（?download=1 则直接下载）。

    两个安全点：先按本人查一次 documents（拿别人的 id 查不到，直接 404）；
    真正读存储走服务端凭据 —— 能不能读在上一句已经判定过了。
    """
    settings = get_settings()
    doc = await repo.get_document(session, document_id, user.id)
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")

    data = await storage.download(settings, doc.storage_path)
    ext = extension_of(doc.filename)
    disposition = "attachment" if download else "inline"

    return Response(
        content=data,
        media_type=_content_type(ext),
        headers={
            "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(doc.filename)}",
            # 原始文件不会变，可以放心让浏览器缓存一会儿
            "Cache-Control": "private, max-age=300",
        },
    )
