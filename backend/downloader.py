from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiohttp

PARALLEL_THRESHOLD = 8 * 1024 * 1024
PARALLEL_CONNECTIONS = 4
DISK_MARGIN = 64 * 1024 * 1024


@dataclass
class TransferControl:
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    reason: str = "pause"

    def stop(self, reason: str) -> None:
        self.reason = reason
        self.stop_event.set()


class TransferStopped(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class SourceChanged(Exception):
    pass


class InsufficientDiskSpace(Exception):
    pass


class RangeNotSupported(Exception):
    pass


class BandwidthLimiter:
    def __init__(self, bytes_per_second: int = 0) -> None:
        self.rate = max(bytes_per_second, 0)
        self.next_slot = 0.0
        self.lock = asyncio.Lock()

    def set_rate(self, bytes_per_second: int) -> None:
        self.rate = max(bytes_per_second, 0)
        self.next_slot = 0.0

    async def consume(self, size: int) -> None:
        if self.rate <= 0:
            return
        async with self.lock:
            now = time.monotonic()
            start = max(now, self.next_slot)
            self.next_slot = start + size / self.rate
            delay = start - now
        if delay > 0:
            await asyncio.sleep(delay)


class ProgressMeter:
    def __init__(self, transfer_id: str, total: int | None, initial: int, emit) -> None:
        self.transfer_id = transfer_id
        self.total = total
        self.downloaded = initial
        self.emit = emit
        self.samples: deque[tuple[float, int]] = deque([(time.monotonic(), initial)])
        self.last_emit = 0.0

    def add(self, size: int) -> None:
        self.downloaded += size
        now = time.monotonic()
        self.samples.append((now, self.downloaded))
        while len(self.samples) > 1 and now - self.samples[0][0] > 5:
            self.samples.popleft()
        if now - self.last_emit < 0.2:
            return
        elapsed = max(now - self.samples[0][0], 0.001)
        speed = max(self.downloaded - self.samples[0][1], 0) / elapsed
        remaining = (
            max((self.total - self.downloaded) / speed, 0)
            if self.total is not None and speed > 0
            else None
        )
        self.emit({
            "type": "download.progress",
            "transferId": self.transfer_id,
            "downloadedBytes": self.downloaded,
            "totalBytes": self.total,
            "bytesPerSecond": speed,
            "remainingSeconds": remaining,
        })
        self.last_emit = now


async def download_file(
    record: dict[str, Any], emit, control: TransferControl, global_limiter: BandwidthLimiter
) -> dict[str, Any]:
    final_path = Path(record["destination"])
    partial_path = Path(record["partial_path"])
    final_path.parent.mkdir(parents=True, exist_ok=True)
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
    task_limiter = BandwidthLimiter(record.get("speed_limit", 0))

    verify_tls = os.environ.get("INTERNET_MANAGER_VERIFY_TLS", "1") != "0"
    connector = aiohttp.TCPConnector(ssl=verify_tls)
    async with aiohttp.ClientSession(timeout=timeout, connector=connector, trust_env=True) as session:
        info = await probe_resource(session, record["url"])
        existing = partial_size(partial_path)
        chunk_files = chunk_paths(partial_path)
        chunk_bytes = sum(partial_size(item) for item in chunk_files)
        remaining = max((info["total"] or 0) - max(existing, chunk_bytes), 0)
        ensure_disk_space(final_path.parent, remaining)

        can_parallel = bool(
            info["supports_ranges"]
            and info["total"]
            and info["total"] >= PARALLEL_THRESHOLD
            and (existing == 0 or chunk_bytes > 0)
        )
        if can_parallel:
            try:
                return await parallel_download(
                    session, record, info, emit, control, global_limiter, task_limiter
                )
            except RangeNotSupported:
                cleanup_chunks(partial_path)

        return await sequential_download(
            session, record, info, emit, control, global_limiter, task_limiter
        )


async def probe_resource(session: aiohttp.ClientSession, url: str) -> dict[str, Any]:
    result = {"total": None, "supports_ranges": False, "etag": None, "last_modified": None}
    try:
        async with session.head(url, allow_redirects=True) as response:
            if response.status < 400:
                result.update({
                    "total": response.content_length,
                    "supports_ranges": response.headers.get("Accept-Ranges", "").lower() == "bytes",
                    "etag": response.headers.get("ETag"),
                    "last_modified": response.headers.get("Last-Modified"),
                })
    except (aiohttp.ClientError, asyncio.TimeoutError):
        pass
    return result


async def sequential_download(session, record, info, emit, control, global_limiter, task_limiter):
    transfer_id = record["id"]
    final_path = Path(record["destination"])
    partial_path = Path(record["partial_path"])
    existing = partial_size(partial_path)
    headers = {"User-Agent": "InternetManager/1.0.0"}
    if existing:
        headers["Range"] = f"bytes={existing}-"
        validator = record.get("etag") or record.get("last_modified")
        if validator:
            headers["If-Range"] = validator

    async with session.get(record["url"], headers=headers, allow_redirects=True) as response:
        if response.status == 416 and existing:
            total = total_from_content_range(response.headers.get("Content-Range"))
            if total == existing:
                partial_path.replace(final_path)
                return {"downloadedBytes": existing, "totalBytes": total, "mode": "single"}
        response.raise_for_status()
        append = existing > 0 and response.status == 206
        if append and content_range_start(response.headers.get("Content-Range")) != existing:
            partial_path.unlink(missing_ok=True)
            raise SourceChanged
        downloaded = existing if append else 0
        total = response.content_length
        if append and total is not None:
            total += existing
        etag = response.headers.get("ETag") or info["etag"]
        last_modified = response.headers.get("Last-Modified") or info["last_modified"]
        if append and source_changed(record, etag, last_modified):
            partial_path.unlink(missing_ok=True)
            raise SourceChanged
        supports_ranges = response.status == 206 or info["supports_ranges"]
        emit_started(emit, transfer_id, downloaded, total, supports_ranges, etag, last_modified, "single", 1, existing > 0 and not append)
        meter = ProgressMeter(transfer_id, total, downloaded, emit)
        with partial_path.open("ab" if append else "wb") as output:
            async for chunk in response.content.iter_chunked(128 * 1024):
                check_stopped(control)
                await global_limiter.consume(len(chunk))
                await task_limiter.consume(len(chunk))
                output.write(chunk)
                meter.add(len(chunk))
        partial_path.replace(final_path)
        return {"downloadedBytes": meter.downloaded, "totalBytes": total or meter.downloaded, "destination": str(final_path), "mode": "single"}


async def parallel_download(session, record, info, emit, control, global_limiter, task_limiter):
    total = int(info["total"])
    transfer_id = record["id"]
    partial_path = Path(record["partial_path"])
    final_path = Path(record["destination"])
    segments = make_segments(total, PARALLEL_CONNECTIONS)
    files = [Path(f"{partial_path}.{index}") for index in range(len(segments))]
    if any(file.exists() for file in files) and source_changed(record, info["etag"], info["last_modified"]):
        cleanup_chunks(partial_path)
    initial = sum(min(partial_size(file), end - start + 1) for file, (start, end) in zip(files, segments))
    ensure_disk_space(final_path.parent, total - initial + total)
    meter = ProgressMeter(transfer_id, total, initial, emit)
    emit_started(emit, transfer_id, initial, total, True, info["etag"], info["last_modified"], "parallel", len(segments), False)

    async def fetch_part(index: int, start: int, end: int) -> None:
        part = files[index]
        completed = min(partial_size(part), end - start + 1)
        if completed >= end - start + 1:
            return
        headers = {"Range": f"bytes={start + completed}-{end}", "User-Agent": "InternetManager/1.0.0"}
        async with session.get(record["url"], headers=headers, allow_redirects=True) as response:
            if response.status != 206:
                raise RangeNotSupported
            if content_range_start(response.headers.get("Content-Range")) != start + completed:
                raise RangeNotSupported
            with part.open("ab") as output:
                async for chunk in response.content.iter_chunked(128 * 1024):
                    check_stopped(control)
                    await global_limiter.consume(len(chunk))
                    await task_limiter.consume(len(chunk))
                    output.write(chunk)
                    meter.add(len(chunk))

    tasks = [
        asyncio.create_task(fetch_part(index, *segment))
        for index, segment in enumerate(segments)
    ]
    try:
        await asyncio.gather(*tasks)
    except Exception:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    for file, (start, end) in zip(files, segments):
        if partial_size(file) != end - start + 1:
            raise OSError("Parça boyutu doğrulanamadı.")
    with partial_path.open("wb") as merged:
        for file in files:
            with file.open("rb") as source:
                shutil.copyfileobj(source, merged, 1024 * 1024)
    if partial_size(partial_path) != total:
        raise OSError("Birleştirilen dosya boyutu doğrulanamadı.")
    cleanup_chunks(partial_path)
    partial_path.replace(final_path)
    return {"downloadedBytes": total, "totalBytes": total, "destination": str(final_path), "mode": "parallel", "connections": len(segments)}


def emit_started(emit, transfer_id, downloaded, total, ranges, etag, modified, mode, connections, restarted):
    emit({"type": "download.started", "transferId": transfer_id, "downloadedBytes": downloaded, "totalBytes": total, "supportsRanges": ranges, "etag": etag, "lastModified": modified, "mode": mode, "connections": connections, "restarted": restarted})


def make_segments(total: int, count: int) -> list[tuple[int, int]]:
    size = total // count
    return [(index * size, total - 1 if index == count - 1 else (index + 1) * size - 1) for index in range(count)]


def source_changed(record, etag, last_modified) -> bool:
    return bool((record.get("etag") and etag and record["etag"] != etag) or (record.get("last_modified") and last_modified and record["last_modified"] != last_modified))


def check_stopped(control: TransferControl) -> None:
    if control.stop_event.is_set():
        raise TransferStopped(control.reason)


def ensure_disk_space(directory: Path, required: int) -> None:
    if required > 0 and shutil.disk_usage(directory).free < required + DISK_MARGIN:
        raise InsufficientDiskSpace


def partial_size(path: Path | str) -> int:
    item = Path(path)
    return item.stat().st_size if item.exists() else 0


def chunk_paths(partial_path: Path) -> list[Path]:
    return [Path(f"{partial_path}.{index}") for index in range(PARALLEL_CONNECTIONS)]


def cleanup_chunks(partial_path: Path) -> None:
    for item in chunk_paths(partial_path):
        item.unlink(missing_ok=True)


def cleanup_partial_artifacts(partial_path: Path) -> None:
    partial_path.unlink(missing_ok=True)
    cleanup_chunks(partial_path)


def total_from_content_range(value: str | None) -> int | None:
    match = re.match(r"bytes \*/(\d+)$", value or "")
    return int(match.group(1)) if match else None


def content_range_start(value: str | None) -> int | None:
    match = re.match(r"bytes (\d+)-\d+/", value or "")
    return int(match.group(1)) if match else None


def user_facing_error(error: Exception) -> str:
    if isinstance(error, SourceChanged):
        return "Kaynak dosya değişti; güvenli olması için indirme baştan başlatılıyor."
    if isinstance(error, InsufficientDiskSpace):
        return "İndirme için yeterli boş disk alanı yok."
    if isinstance(error, aiohttp.InvalidURL):
        return "Bağlantı adresi geçerli değil."
    if isinstance(error, aiohttp.ClientResponseError):
        return f"Sunucu indirmeyi reddetti (HTTP {error.status})."
    if isinstance(error, (aiohttp.ClientConnectionError, asyncio.TimeoutError)):
        return "Sunucuya bağlanılamadı. Bağlantıyı kontrol edip yeniden deneyin."
    if isinstance(error, PermissionError):
        return "Seçilen klasöre dosya yazma izni yok."
    if isinstance(error, OSError):
        return "Dosya diske yazılamadı. Disk alanını ve klasör izinlerini kontrol edin."
    return "İndirme beklenmeyen bir nedenle tamamlanamadı."
