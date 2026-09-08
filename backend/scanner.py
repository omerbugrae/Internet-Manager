from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.parse import unquote, urljoin, urlparse

import aiohttp

MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_CANDIDATES = 120
DOWNLOAD_EXTENSIONS = {
    ".7z", ".apk", ".avi", ".csv", ".deb", ".dmg", ".doc", ".docx", ".exe",
    ".flac", ".gz", ".iso", ".jpg", ".jpeg", ".m4a", ".mkv", ".mov", ".mp3",
    ".mp4", ".msi", ".pdf", ".png", ".ppt", ".pptx", ".rar", ".rpm", ".tar",
    ".tgz", ".txt", ".wav", ".webm", ".webp", ".xls", ".xlsx", ".zip",
}


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: set[str] = set()

    def handle_starttag(self, tag: str, attrs) -> None:
        values = dict(attrs)
        if tag == "a" and values.get("href"):
            self.links.add(values["href"])
        if tag in {"video", "audio", "source"} and values.get("src"):
            self.links.add(values["src"])


async def scan_url(url: str) -> dict:
    await ensure_public_url(url)
    timeout = aiohttp.ClientTimeout(total=30, connect=10, sock_read=15)
    headers = {"User-Agent": "InternetManager/0.4.1"}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        async with session.get(url, allow_redirects=True) as response:
            await ensure_public_url(str(response.url))
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
            if content_type and content_type not in {"text/html", "application/xhtml+xml"}:
                return {"sourceUrl": url, "items": [item_from_headers(str(response.url), response.headers)]}
            body = await response.content.read(MAX_HTML_BYTES + 1)
            if len(body) > MAX_HTML_BYTES:
                raise ValueError("Sayfa tarama sınırından büyük.")
            charset = response.charset or "utf-8"
            html = body.decode(charset, errors="replace")
            base_url = str(response.url)

        parser = LinkParser()
        parser.feed(html)
        candidates = []
        for value in parser.links:
            absolute = urljoin(base_url, value)
            parsed = urlparse(absolute)
            if parsed.scheme in {"http", "https"} and absolute not in candidates:
                candidates.append(absolute)
            if len(candidates) >= MAX_CANDIDATES:
                break

        semaphore = asyncio.Semaphore(8)

        async def inspect(candidate: str):
            async with semaphore:
                return await inspect_url(session, candidate)

        inspected = await asyncio.gather(*(inspect(item) for item in candidates), return_exceptions=True)
        items = [item for item in inspected if isinstance(item, dict) and item.get("downloadable")]
        items.sort(key=lambda item: (item["category"], item["filename"].lower()))
        return {"sourceUrl": url, "items": items}


async def inspect_url(session: aiohttp.ClientSession, url: str) -> dict:
    parsed = urlparse(url)
    extension = PurePosixPath(parsed.path).suffix.lower()
    try:
        await ensure_public_url(url)
        async with session.head(url, allow_redirects=True) as response:
            await ensure_public_url(str(response.url))
            headers = response.headers
            content_type = headers.get("Content-Type", "").split(";", 1)[0].lower()
            disposition = headers.get("Content-Disposition", "")
            downloadable = (
                extension in DOWNLOAD_EXTENSIONS
                or "attachment" in disposition.lower()
                or bool(content_type and not content_type.startswith("text/html"))
            )
            item = item_from_headers(str(response.url), headers)
            item["downloadable"] = downloadable
            return item
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
        return {
            "url": url, "filename": filename_from_url(url), "size": None,
            "contentType": None, "category": category_for(None, extension),
            "downloadable": extension in DOWNLOAD_EXTENSIONS,
        }


def item_from_headers(url: str, headers) -> dict:
    content_type = headers.get("Content-Type", "").split(";", 1)[0].lower() or None
    disposition = headers.get("Content-Disposition", "")
    match = re.search(r"filename\*?=(?:UTF-8''|\")?([^\";]+)", disposition, re.IGNORECASE)
    filename = unquote(match.group(1).strip()) if match else filename_from_url(url)
    size = headers.get("Content-Length")
    extension = PurePosixPath(urlparse(url).path).suffix.lower()
    return {
        "url": url, "filename": filename, "size": int(size) if size and size.isdigit() else None,
        "contentType": content_type, "category": category_for(content_type, extension),
        "downloadable": True,
    }


def filename_from_url(url: str) -> str:
    name = PurePosixPath(urlparse(url).path).name
    return unquote(name) or "download"


def category_for(content_type: str | None, extension: str) -> str:
    value = content_type or ""
    if value.startswith("video/") or extension in {".mkv", ".mp4", ".webm", ".avi", ".mov"}:
        return "Video"
    if value.startswith("audio/") or extension in {".mp3", ".wav", ".flac", ".m4a"}:
        return "Ses"
    if value.startswith("image/"):
        return "Görsel"
    if extension in {".zip", ".rar", ".7z", ".tar", ".gz", ".tgz"}:
        return "Arşiv"
    if extension in {".exe", ".msi", ".apk", ".dmg", ".deb", ".rpm"}:
        return "Uygulama"
    return "Belge/Dosya"


async def ensure_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Yalnızca HTTP/HTTPS bağlantıları taranabilir.")
    loop = asyncio.get_running_loop()
    addresses = await loop.run_in_executor(None, socket.getaddrinfo, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("Yerel veya özel ağ adresleri taranamaz.")
