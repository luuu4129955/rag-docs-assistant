"""文档相关入参。"""

from pydantic import BaseModel, Field


class UploadInitRequest(BaseModel):
    filename: str
    size: int
    # 文件名+大小+修改时间：用来认领没传完的上传，实现断点续传
    fingerprint: str = Field(default="")
