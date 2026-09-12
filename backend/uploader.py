from __future__ import annotations

import asyncio
import os
import posixpath
import stat
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, unquote, urlparse
from xml.etree import ElementTree

import aiohttp
import asyncssh
try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:  # Diğer provider'lar boto3 kurulmadan da çalışabilsin.
    boto3 = None

    class BotoCoreError(Exception):
        pass

    class ClientError(BotoCoreError):
        response: dict[str, Any] = {}

from downloader import BandwidthLimiter, ProgressMeter, TransferControl, TransferStopped, check_stopped

MULTIPART_THRESHOLD = 8 * 1024 * 1024
MULTIPART_PART_SIZE = 8 * 1024 * 1024
SessionLoader = Callable[[str], dict[str, Any] | None]
SessionSaver = Callable[[str, str, str, dict[str, Any]], None]
SessionClearer = Callable[[str], None]


class UploadProvider(ABC):
    name: str
    capabilities: dict[str, bool]

    def __init__(self, connection: dict[str, Any]) -> None:
        self.connection = connection

    @abstractmethod
    async def test(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def list(self, path: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    async def upload(
        self, record: dict[str, Any], emit, control: TransferControl,
        global_limiter: BandwidthLimiter, load_session: SessionLoader,
        save_session: SessionSaver, clear_session: SessionClearer,
    ) -> dict[str, Any]:
        raise NotImplementedError


class WebDavProvider(UploadProvider):
    name = "webdav"
    capabilities = {"resume": False, "browse": True, "share_url": True}

    def auth(self) -> aiohttp.BasicAuth:
        return aiohttp.BasicAuth(self.connection["username"], self.connection.get("password", ""))

    @staticmethod
    def connector() -> aiohttp.TCPConnector:
        return aiohttp.TCPConnector(ssl=os.environ.get("INTERNET_MANAGER_VERIFY_TLS", "1") != "0")

    async def test(self) -> None:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout, auth=self.auth(), connector=self.connector(), trust_env=True) as session:
            async with session.request("PROPFIND", self.connection["url"], headers={"Depth": "0"}) as response:
                if response.status >= 400:
                    response.raise_for_status()

    async def list(self, path: str) -> list[dict[str, Any]]:
        base = self.connection["url"].rstrip("/")
        url = f"{base}/{quote(path.strip('/'), safe='/')}".rstrip("/") + "/"
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout, auth=self.auth(), connector=self.connector(), trust_env=True) as session:
            async with session.request("PROPFIND", url, headers={"Depth": "1"}) as response:
                response.raise_for_status()
                body = await response.read()
        root = ElementTree.fromstring(body)
        entries: list[dict[str, Any]] = []
        base_path = unquote(urlparse(base).path).rstrip("/")
        requested_path = unquote(urlparse(url).path).rstrip("/")
        for item in root.findall("{DAV:}response"):
            href = item.findtext("{DAV:}href", "")
            item_path = unquote(urlparse(href).path).rstrip("/")
            if not item_path or item_path == requested_path:
                continue
            display_name = item.findtext(".//{DAV:}displayname") or posixpath.basename(item_path)
            is_directory = item.find(".//{DAV:}collection") is not None
            size_text = item.findtext(".//{DAV:}getcontentlength")
            relative_path = item_path[len(base_path):] if base_path and item_path.startswith(base_path) else item_path
            entries.append({
                "name": display_name,
                "path": relative_path or "/",
                "type": "folder" if is_directory else "file",
                "size": int(size_text) if size_text and size_text.isdigit() else None,
            })
        return sorted(entries, key=lambda entry: (entry["type"] != "folder", entry["name"].lower()))

    async def upload(self, record, emit, control, global_limiter, load_session, save_session, clear_session):
        source = Path(record["source_path"])
        total = source.stat().st_size
        remote = record["remote_path"].lstrip("/")
        base = self.connection["url"].rstrip("/")
        url = f"{base}/{quote(remote, safe='/')}"
        limiter = BandwidthLimiter(record.get("speed_limit", 0))
        meter = ProgressMeter(record["id"], total, 0, emit)
        timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout, auth=self.auth(), connector=self.connector(), trust_env=True) as session:
            url = await resolve_webdav_conflict(session, url, record["conflict_policy"])
            if url is None:
                return {"skipped": True, "uploadedBytes": 0, "totalBytes": total}

            async def body():
                with source.open("rb") as file:
                    while chunk := file.read(128 * 1024):
                        check_stopped(control)
                        await global_limiter.consume(len(chunk))
                        await limiter.consume(len(chunk))
                        meter.add(len(chunk))
                        yield chunk

            emit({"type": "upload.started", "transferId": record["id"], "totalBytes": total, "uploadedBytes": 0, "resumable": False})
            async with session.put(url, data=body()) as response:
                response.raise_for_status()
        return {"uploadedBytes": total, "totalBytes": total, "remotePath": record["remote_path"], "shareUrl": url}


class SftpProvider(UploadProvider):
    name = "sftp"
    capabilities = {"resume": False, "browse": True, "share_url": False}

    def connect(self):
        return asyncssh.connect(
            self.connection["host"], port=int(self.connection.get("port", 22)),
            username=self.connection["username"], password=self.connection.get("password"),
        )

    async def test(self) -> None:
        async with self.connect():
            return

    async def list(self, path: str) -> list[dict[str, Any]]:
        remote = path or "/"
        entries: list[dict[str, Any]] = []
        async with self.connect() as client:
            async with client.start_sftp_client() as sftp:
                async for item in sftp.scandir(remote):
                    if item.filename in {".", ".."}:
                        continue
                    permissions = item.attrs.permissions or 0
                    entries.append({
                        "name": item.filename,
                        "path": posixpath.join(remote, item.filename),
                        "type": "folder" if stat.S_ISDIR(permissions) else "file",
                        "size": item.attrs.size,
                    })
        return sorted(entries, key=lambda entry: (entry["type"] != "folder", entry["name"].lower()))

    async def upload(self, record, emit, control, global_limiter, load_session, save_session, clear_session):
        source = Path(record["source_path"])
        total = source.stat().st_size
        limiter = BandwidthLimiter(record.get("speed_limit", 0))
        meter = ProgressMeter(record["id"], total, 0, emit)
        async with self.connect() as client:
            async with client.start_sftp_client() as sftp:
                remote = await resolve_sftp_conflict(sftp, record["remote_path"], record["conflict_policy"])
                if remote is None:
                    return {"skipped": True, "uploadedBytes": 0, "totalBytes": total}
                emit({"type": "upload.started", "transferId": record["id"], "totalBytes": total, "uploadedBytes": 0, "resumable": False})
                async with sftp.open(remote, "wb") as target:
                    with source.open("rb") as file:
                        while chunk := file.read(128 * 1024):
                            check_stopped(control)
                            await global_limiter.consume(len(chunk))
                            await limiter.consume(len(chunk))
                            await target.write(chunk)
                            meter.add(len(chunk))
        return {"uploadedBytes": total, "totalBytes": total, "remotePath": remote}


class S3Provider(UploadProvider):
    name = "s3"
    capabilities = {"resume": True, "browse": True, "share_url": True}

    def client(self):
        if boto3 is None:
            raise ValueError("S3 desteği için boto3 bağımlılığı kurulmalı.")
        return boto3.client(
            "s3",
            region_name=self.connection.get("region") or None,
            endpoint_url=self.connection.get("endpoint_url") or None,
            aws_access_key_id=self.connection.get("access_key_id") or None,
            aws_secret_access_key=self.connection.get("secret_access_key") or None,
            aws_session_token=self.connection.get("session_token") or None,
        )

    async def test(self) -> None:
        client = self.client()
        await asyncio.to_thread(client.head_bucket, Bucket=self.connection["bucket"])

    async def list(self, path: str) -> list[dict[str, Any]]:
        client = self.client()
        prefix = path.strip("/")
        if prefix:
            prefix += "/"
        response = await asyncio.to_thread(
            client.list_objects_v2, Bucket=self.connection["bucket"], Prefix=prefix,
            Delimiter="/", MaxKeys=1000,
        )
        entries = [
            {"name": value["Prefix"][len(prefix):].rstrip("/"), "path": value["Prefix"].rstrip("/"), "type": "folder", "size": None}
            for value in response.get("CommonPrefixes", [])
        ]
        entries.extend(
            {"name": item["Key"][len(prefix):], "path": item["Key"], "type": "file", "size": item.get("Size")}
            for item in response.get("Contents", []) if item["Key"] != prefix
        )
        return sorted(entries, key=lambda entry: (entry["type"] != "folder", entry["name"].lower()))

    async def upload(self, record, emit, control, global_limiter, load_session, save_session, clear_session):
        source = Path(record["source_path"])
        total = source.stat().st_size
        bucket = self.connection["bucket"]
        client = self.client()
        key = await resolve_s3_conflict(client, bucket, record["remote_path"].lstrip("/"), record["conflict_policy"])
        if key is None:
            return {"skipped": True, "uploadedBytes": 0, "totalBytes": total}
        if total < MULTIPART_THRESHOLD:
            check_stopped(control)
            data = source.read_bytes()
            await global_limiter.consume(len(data))
            await BandwidthLimiter(record.get("speed_limit", 0)).consume(len(data))
            emit({"type": "upload.started", "transferId": record["id"], "totalBytes": total, "uploadedBytes": 0, "resumable": False})
            await asyncio.to_thread(client.put_object, Bucket=bucket, Key=key, Body=data)
            return {"uploadedBytes": total, "totalBytes": total, "remotePath": key, "shareUrl": self.object_url(key)}

        state = load_session(record["id"])
        if not state or state.get("bucket") != bucket or state.get("key") != key:
            created = await asyncio.to_thread(client.create_multipart_upload, Bucket=bucket, Key=key)
            state = {"upload_id": created["UploadId"], "bucket": bucket, "key": key, "parts": []}
            save_session(record["id"], self.name, key, state)
        uploaded = sum(int(part["Size"]) for part in state["parts"])
        meter = ProgressMeter(record["id"], total, uploaded, emit)
        limiter = BandwidthLimiter(record.get("speed_limit", 0))
        emit({"type": "upload.started", "transferId": record["id"], "totalBytes": total, "uploadedBytes": uploaded, "resumable": True})
        try:
            with source.open("rb") as file:
                file.seek(uploaded)
                part_number = len(state["parts"]) + 1
                while chunk := file.read(MULTIPART_PART_SIZE):
                    check_stopped(control)
                    await global_limiter.consume(len(chunk))
                    await limiter.consume(len(chunk))
                    result = await asyncio.to_thread(
                        client.upload_part, Bucket=bucket, Key=key,
                        UploadId=state["upload_id"], PartNumber=part_number, Body=chunk,
                    )
                    state["parts"].append({"ETag": result["ETag"], "PartNumber": part_number, "Size": len(chunk)})
                    save_session(record["id"], self.name, key, state)
                    meter.add(len(chunk))
                    part_number += 1
            completed_parts = [{"ETag": part["ETag"], "PartNumber": part["PartNumber"]} for part in state["parts"]]
            await asyncio.to_thread(
                client.complete_multipart_upload, Bucket=bucket, Key=key,
                UploadId=state["upload_id"], MultipartUpload={"Parts": completed_parts},
            )
            clear_session(record["id"])
        except TransferStopped as stopped:
            if stopped.reason == "cancel":
                await asyncio.to_thread(
                    client.abort_multipart_upload, Bucket=bucket, Key=key, UploadId=state["upload_id"]
                )
                clear_session(record["id"])
            raise
        return {"uploadedBytes": total, "totalBytes": total, "remotePath": key, "shareUrl": self.object_url(key), "resumable": True}

    def object_url(self, key: str) -> str:
        endpoint = (self.connection.get("endpoint_url") or "").rstrip("/")
        encoded_key = quote(key, safe="/")
        if endpoint:
            return f"{endpoint}/{self.connection['bucket']}/{encoded_key}"
        region = self.connection.get("region") or "us-east-1"
        return f"https://{self.connection['bucket']}.s3.{region}.amazonaws.com/{encoded_key}"


PROVIDERS = {"sftp": SftpProvider, "webdav": WebDavProvider, "s3": S3Provider}


def get_provider(name: str, connection: dict[str, Any]) -> UploadProvider:
    provider_class = PROVIDERS.get(name)
    if provider_class is None:
        raise ValueError("Desteklenmeyen yükleme sağlayıcısı.")
    return provider_class(connection)


async def upload_file(record, connection, emit, control, global_limiter, load_session, save_session, clear_session):
    return await get_provider(record["provider"], connection).upload(
        record, emit, control, global_limiter, load_session, save_session, clear_session
    )


async def test_connection(provider: str, connection: dict[str, Any]) -> dict[str, bool]:
    adapter = get_provider(provider, connection)
    await adapter.test()
    return adapter.capabilities


async def list_remote(provider: str, connection: dict[str, Any], path: str) -> dict[str, Any]:
    adapter = get_provider(provider, connection)
    return {"path": path, "entries": await adapter.list(path), "capabilities": adapter.capabilities}


async def resolve_s3_conflict(client, bucket: str, key: str, policy: str) -> str | None:
    if not await s3_object_exists(client, bucket, key) or policy == "overwrite":
        return key
    if policy == "skip":
        return None
    folder, name = posixpath.split(key)
    stem, suffix = posixpath.splitext(name)
    for index in range(1, 1000):
        candidate = posixpath.join(folder, f"{stem} ({index}){suffix}")
        if not await s3_object_exists(client, bucket, candidate):
            return candidate
    raise OSError("Uygun uzak dosya adı bulunamadı.")


async def s3_object_exists(client, bucket: str, key: str) -> bool:
    try:
        await asyncio.to_thread(client.head_object, Bucket=bucket, Key=key)
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise


async def resolve_webdav_conflict(session, url: str, policy: str) -> str | None:
    async with session.head(url) as response:
        exists = response.status < 400
    if not exists or policy == "overwrite":
        return url
    if policy == "skip":
        return None
    stem, dot, suffix = url.rpartition(".")
    for index in range(1, 1000):
        candidate = f"{stem} ({index}).{suffix}" if dot else f"{url} ({index})"
        async with session.head(candidate) as response:
            if response.status >= 400:
                return candidate
    raise OSError("Uygun uzak dosya adı bulunamadı.")


async def resolve_sftp_conflict(sftp, remote: str, policy: str) -> str | None:
    try:
        await sftp.stat(remote)
    except asyncssh.SFTPNoSuchFile:
        return remote
    if policy == "overwrite":
        return remote
    if policy == "skip":
        return None
    folder, name = posixpath.split(remote)
    stem, suffix = posixpath.splitext(name)
    for index in range(1, 1000):
        candidate = posixpath.join(folder, f"{stem} ({index}){suffix}")
        try:
            await sftp.stat(candidate)
        except asyncssh.SFTPNoSuchFile:
            return candidate
    raise OSError("Uygun uzak dosya adı bulunamadı.")


def upload_error(error: Exception) -> str:
    if isinstance(error, TransferStopped):
        return "Yükleme durduruldu."
    if isinstance(error, (asyncssh.Error, BotoCoreError, ClientError, OSError, aiohttp.ClientError, asyncio.TimeoutError)):
        return "Yükleme hedefiyle bağlantı kurulamadı veya dosya aktarılamadı."
    return "Yükleme beklenmeyen bir nedenle tamamlanamadı."
