from __future__ import annotations

from aiohttp import web
import pytest

from backend.downloader import BandwidthLimiter, TransferControl, download_file


async def serve(handler):
    application = web.Application()
    application.router.add_route("*", "/file", handler)
    runner = web.AppRunner(application)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return runner, f"http://127.0.0.1:{port}/file"


def record(url, destination):
    return {
        "id": "integration", "url": url, "destination": str(destination),
        "partial_path": f"{destination}.part", "speed_limit": 0,
        "etag": None, "last_modified": None,
    }


@pytest.mark.asyncio
async def test_downloads_a_file_atomically(tmp_path):
    body = (b"internet-manager-1.0\n" * 4096)

    async def handler(request):
        return web.Response(body=body, headers={"ETag": '"stable"'})

    runner, url = await serve(handler)
    destination = tmp_path / "complete.bin"
    try:
        result = await download_file(
            record(url, destination), lambda _message: None,
            TransferControl(), BandwidthLimiter(),
        )
    finally:
        await runner.cleanup()

    assert destination.read_bytes() == body
    assert not (tmp_path / "complete.bin.part").exists()
    assert result["downloadedBytes"] == len(body)


@pytest.mark.asyncio
async def test_resumes_from_partial_file_with_range(tmp_path):
    body = bytes(range(256)) * 1024
    ranges = []

    async def handler(request):
        if request.method == "HEAD":
            return web.Response(headers={"Content-Length": str(len(body)), "Accept-Ranges": "bytes", "ETag": '"v1"'})
        header = request.headers.get("Range")
        ranges.append(header)
        start = int(header.removeprefix("bytes=").split("-", 1)[0]) if header else 0
        status = 206 if header else 200
        headers = {"ETag": '"v1"', "Accept-Ranges": "bytes"}
        if header:
            headers["Content-Range"] = f"bytes {start}-{len(body) - 1}/{len(body)}"
        return web.Response(body=body[start:], status=status, headers=headers)

    runner, url = await serve(handler)
    destination = tmp_path / "resumed.bin"
    partial = tmp_path / "resumed.bin.part"
    partial.write_bytes(body[:65536])
    item = record(url, destination)
    item["etag"] = '"v1"'
    try:
        await download_file(item, lambda _message: None, TransferControl(), BandwidthLimiter())
    finally:
        await runner.cleanup()

    assert ranges == ["bytes=65536-"]
    assert destination.read_bytes() == body
