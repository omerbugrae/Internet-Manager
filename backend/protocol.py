from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class StrictMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DownloadPayload(StrictMessage):
    transfer_id: str = Field(min_length=1, max_length=128)
    url: HttpUrl
    destination: str = Field(min_length=1)
    conflict_policy: Literal["overwrite", "rename", "skip"] = "overwrite"
    priority: int = Field(default=0, ge=-100, le=100)
    speed_limit: int = Field(default=0, ge=0)


class TransferPayload(StrictMessage):
    transfer_id: str = Field(min_length=1, max_length=128)


class PriorityPayload(TransferPayload):
    priority: int = Field(ge=-100, le=100)


class BulkPayload(StrictMessage):
    action: Literal["pause", "resume", "cancel"]
    transfer_ids: list[str] = Field(min_length=1, max_length=1000)


class SettingsPayload(StrictMessage):
    max_concurrent: int = Field(ge=1, le=12)
    global_speed_limit: int = Field(ge=0)


class UploadPayload(StrictMessage):
    transfer_id: str = Field(min_length=1, max_length=128)
    source_path: str = Field(min_length=1)
    remote_path: str = Field(min_length=1)
    provider: Literal["sftp", "webdav", "s3"]
    profile_id: str = Field(min_length=1)
    connection: dict
    conflict_policy: Literal["overwrite", "rename", "skip"] = "overwrite"
    priority: int = Field(default=0, ge=-100, le=100)
    speed_limit: int = Field(default=0, ge=0)


class UploadRetryPayload(TransferPayload):
    connection: dict


class ProfileTestPayload(StrictMessage):
    provider: Literal["sftp", "webdav", "s3"]
    connection: dict


class ProviderListPayload(ProfileTestPayload):
    path: str = ""


class ScanPayload(StrictMessage):
    url: HttpUrl


class Command(StrictMessage):
    request_id: str = Field(min_length=1, max_length=128)
    type: Literal[
        "download.start",
        "download.pause",
        "download.resume",
        "download.cancel",
        "download.retry",
        "download.priority",
        "transfers.bulk",
        "settings.update",
        "upload.start",
        "upload.pause",
        "upload.cancel",
        "upload.retry",
        "profile.test",
        "provider.list",
        "scan.start",
        "transfers.list",
        "engine.shutdown",
    ]
    payload: dict = Field(default_factory=dict)
