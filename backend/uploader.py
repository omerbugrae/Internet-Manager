from __future__ import annotations

import asyncio
import posixpath
from pathlib import Path
from typing import Any
from urllib.parse import quote

import aiohttp
import asyncssh

from downloader import BandwidthLimiter, ProgressMeter, TransferControl, TransferStopped, check_stopped


async def upload_file(record: dict[str, Any], connection: dict[str, Any], emit, control: TransferControl, global_limiter: BandwidthLimiter) -> dict[str, Any]:
    if record["provider"] == "sftp":
        return await upload_sftp(record, connection, emit, control, global_limiter)
    return await upload_webdav(record, connection, emit, control, global_limiter)


async def test_connection(provider: str, connection: dict[str, Any]) -> None:
    if provider == "sftp":
        async with asyncssh.connect(
            connection["host"], port=int(connection.get("port", 22)),
            username=connection["username"], password=connection.get("password"),
        ):
            return
    timeout = aiohttp.ClientTimeout(total=15)
    auth = aiohttp.BasicAuth(connection["username"], connection.get("password", ""))
    async with aiohttp.ClientSession(timeout=timeout, auth=auth) as session:
        async with session.request("PROPFIND", connection["url"], headers={"Depth": "0"}) as response:
            if response.status >= 400:
                response.raise_for_status()


async def upload_webdav(record, connection, emit, control, global_limiter):
    source = Path(record["source_path"])
    total = source.stat().st_size
    remote = record["remote_path"].lstrip("/")
    base = connection["url"].rstrip("/")
    url = f"{base}/{quote(remote, safe='/')}"
    auth = aiohttp.BasicAuth(connection["username"], connection.get("password", ""))
    limiter = BandwidthLimiter(record.get("speed_limit", 0))
    meter = ProgressMeter(record["id"], total, 0, emit)
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
    async with aiohttp.ClientSession(timeout=timeout, auth=auth) as session:
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

        emit({"type": "upload.started", "transferId": record["id"], "totalBytes": total, "uploadedBytes": 0})
        async with session.put(url, data=body()) as response:
            response.raise_for_status()
    return {"uploadedBytes": total, "totalBytes": total, "remotePath": record["remote_path"]}


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


async def upload_sftp(record, connection, emit, control, global_limiter):
    source = Path(record["source_path"])
    total = source.stat().st_size
    limiter = BandwidthLimiter(record.get("speed_limit", 0))
    meter = ProgressMeter(record["id"], total, 0, emit)
    async with asyncssh.connect(
        connection["host"], port=int(connection.get("port", 22)),
        username=connection["username"], password=connection.get("password"),
    ) as client:
        async with client.start_sftp_client() as sftp:
            remote = await resolve_sftp_conflict(sftp, record["remote_path"], record["conflict_policy"])
            if remote is None:
                return {"skipped": True, "uploadedBytes": 0, "totalBytes": total}
            emit({"type": "upload.started", "transferId": record["id"], "totalBytes": total, "uploadedBytes": 0})
            async with sftp.open(remote, "wb") as target:
                with source.open("rb") as file:
                    while chunk := file.read(128 * 1024):
                        check_stopped(control)
                        await global_limiter.consume(len(chunk))
                        await limiter.consume(len(chunk))
                        await target.write(chunk)
                        meter.add(len(chunk))
    return {"uploadedBytes": total, "totalBytes": total, "remotePath": remote}


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
    if isinstance(error, (asyncssh.Error, OSError, aiohttp.ClientError, asyncio.TimeoutError)):
        return "Yükleme hedefiyle bağlantı kurulamadı veya dosya aktarılamadı."
    return "Yükleme beklenmeyen bir nedenle tamamlanamadı."
