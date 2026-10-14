"""分片上传：init → 传分片 → complete。

为什么需要这条路：大文件没法一次塞进请求体，得切成小片分别传、最后在服务端合并。
分片还要能「断点续传」—— 所以每次开传前先问一句：
这个文件（按文件名+大小+修改时间认指纹）之前传到哪了？
有未完成的会话就把已收到的分片列表还给前端，只补没传的那几片。

分片落在 Storage 的 `{user}/uploads/{uploadId}/part-N`，完成后即清理。
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..config import get_settings
from ..deps import AdminSessionDep, CurrentUser, SessionDep
from ..repositories import documents as docs_repo
from ..repositories import upload as repo
from ..schemas import UploadInitRequest
from ..services import storage
from ..services.ingest import extension_of, is_supported
from ..services.rate_limit import enforce

router = APIRouter(prefix="/api/documents/upload", tags=["upload"])

# 1MB：够小，单请求不会撞上限；够大，40MB 也才 40 个请求
CHUNK_SIZE = 1024 * 1024


def _prefix(user_id: UUID, upload_id: UUID) -> str:
    return f"{user_id}/uploads/{upload_id}"


def _received_parts(objects: list[dict]) -> list[int]:
    parts: list[int] = []
    for obj in objects:
        name = str(obj.get("name", ""))
        if name.startswith("part-"):
            suffix = name[5:]
            if suffix.isdigit():
                parts.append(int(suffix))
    return sorted(parts)


@router.post("/init")
async def init_upload(
    body: UploadInitRequest,
    user: CurrentUser,
    session: SessionDep,
    admin: AdminSessionDep,
) -> dict:
    settings = get_settings()
    await enforce(admin, settings, str(user.id), "uploadInit")

    filename = body.filename.strip()
    if not filename:
        raise HTTPException(status_code=400, detail="缺少文件名")
    if body.size <= 0:
        raise HTTPException(status_code=400, detail="文件为空")

    ext = extension_of(filename)
    if not is_supported(ext):
        raise HTTPException(status_code=400, detail=f"暂不支持 .{ext} 格式，请上传 PDF / Markdown / TXT")

    max_mb = settings.max_upload_mb or 40
    if body.size > max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"文件超过 {max_mb}MB 上限")

    total_parts = max(1, (body.size + CHUNK_SIZE - 1) // CHUNK_SIZE)
    fingerprint = body.fingerprint.strip() or f"{filename}:{body.size}"

    existing = await repo.find_open_session(session, user.id, fingerprint)
    if existing is not None:
        upload_id, chunk_size, total = existing.id, existing.chunk_size, existing.total_parts
    else:
        record = await repo.create_session(
            session,
            user_id=user.id,
            filename=filename,
            size_bytes=body.size,
            fingerprint=fingerprint,
            chunk_size=CHUNK_SIZE,
            total_parts=total_parts,
        )
        upload_id, chunk_size, total = record.id, CHUNK_SIZE, total_parts

    # 存储里实际已经收到哪些分片（以存储为准，不信前端记的进度）
    objects = await storage.list_objects(settings, _prefix(user.id, upload_id), limit=1000)
    return {
        "uploadId": str(upload_id),
        "chunkSize": chunk_size,
        "totalParts": total,
        "received": _received_parts(objects),
        "resumed": existing is not None,
    }


@router.post("/{upload_id}/part")
async def upload_part(
    upload_id: UUID,
    user: CurrentUser,
    session: SessionDep,
    admin: AdminSessionDep,
    index: Annotated[int, Form()],
    part: Annotated[UploadFile, File()],
) -> dict:
    settings = get_settings()
    await enforce(admin, settings, str(user.id), "uploadPart")

    # 会话必须是本人的、且还开着；否则拿到别人的 uploadId 就能往里写
    record = await repo.get_session(session, upload_id, user.id)
    if record is None or record.status != "open":
        raise HTTPException(status_code=404, detail="上传会话不存在或已结束")
    if index < 0 or index >= record.total_parts:
        raise HTTPException(status_code=400, detail="分片序号超出范围")

    data = await part.read()
    if not data:
        raise HTTPException(status_code=400, detail="没有收到分片数据")

    # upsert 覆盖而不是拒绝重复：续传时前端可能重传某一片
    await storage.upload(
        settings,
        f"{_prefix(user.id, upload_id)}/part-{index}",
        data,
        "application/octet-stream",
        upsert=True,
    )
    await repo.touch(session, upload_id)
    return {"ok": True, "received": index}


def _final_path(user_id: UUID, ext: str) -> str:
    import secrets
    import time

    return f"{user_id}/{int(time.time() * 1000)}-{secrets.token_hex(4)}.{ext}"


@router.post("/{upload_id}/complete")
async def complete_upload(
    upload_id: UUID,
    user: CurrentUser,
    session: SessionDep,
    admin: AdminSessionDep,
) -> dict:
    """合并分片，正式建文档。

    合并发生在服务端（而不是让前端拿预签名 URL 直传）——
    那样需要前端掌握存储凭据，跟「浏览器里不放任何密钥」的原则冲突。
    代价是单文件受函数内存限制（NUXT_MAX_UPLOAD_MB，默认 40MB）。
    """
    settings = get_settings()
    await enforce(admin, settings, str(user.id), "uploadComplete")

    record = await repo.get_session(session, upload_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="上传会话不存在")
    if record.status != "open":
        raise HTTPException(status_code=409, detail="这个上传已经结束了")

    prefix = _prefix(user.id, upload_id)
    objects = await storage.list_objects(settings, prefix, limit=1000)
    parts = _received_parts(objects)
    if len(parts) != record.total_parts:
        raise HTTPException(
            status_code=400,
            detail=f"分片不完整：应有 {record.total_parts} 片，实际 {len(parts)} 片",
        )

    # 按序读出、拼接
    buffers = [await storage.download(settings, f"{prefix}/part-{index}") for index in parts]
    merged = b"".join(buffers)

    max_mb = settings.max_upload_mb or 40
    if len(merged) > max_mb * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"合并后 {len(merged) / 1024 / 1024:.1f}MB，超过 {max_mb}MB 上限",
        )

    ext = extension_of(record.filename)
    final_path = _final_path(user.id, ext)
    await storage.upload(
        settings,
        final_path,
        merged,
        "application/pdf" if ext == "pdf" else "text/plain; charset=utf-8",
    )

    try:
        doc = await docs_repo.insert_document(
            session,
            user_id=user.id,
            filename=record.filename,
            storage_path=final_path,
            size_bytes=len(merged),
        )
    except Exception:  # noqa: BLE001
        # 补偿：数据库没写成就把刚上传的合并文件删掉，别留孤儿
        await storage.remove(settings, [final_path])
        raise HTTPException(status_code=500, detail="写入文档记录失败") from None

    # 收尾：会话标结束、临时分片清掉（临时文件不留着占空间）
    await repo.mark_done(session, upload_id)
    await storage.remove(settings, [f"{prefix}/part-{index}" for index in parts])

    return {
        "id": str(doc.id),
        "filename": doc.filename,
        "status": doc.status,
        "queued": True,
        "sizeBytes": len(merged),
    }
