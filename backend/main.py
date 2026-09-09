from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from downloader import (
    BandwidthLimiter,
    TransferControl,
    TransferStopped,
    cleanup_partial_artifacts,
    download_file,
    partial_size,
    user_facing_error,
)
from protocol import BulkPayload, Command, DownloadPayload, PriorityPayload, ProfileTestPayload, ProviderListPayload, ScanPayload, SettingsPayload, TransferPayload, UploadPayload, UploadRetryPayload
from scanner import scan_url
from storage import TransferStore, public_transfer
from uploader import list_remote, test_connection, upload_error, upload_file


class TransferEngine:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.commands: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.controls: dict[str, TransferControl] = {}
        self.output_lock = threading.Lock()
        data_dir = Path(os.environ.get("INTERNET_MANAGER_DATA_DIR", Path(__file__).parent / "data"))
        self.store = TransferStore(data_dir)
        self.store.mark_interrupted_as_paused()
        self.max_concurrent = int(self.store.get_setting("max_concurrent", "3"))
        global_limit = int(self.store.get_setting("global_speed_limit", "0"))
        self.global_limiter = BandwidthLimiter(global_limit)
        self.upload_connections: dict[str, dict[str, Any]] = {}

    def emit(self, message: dict[str, Any]) -> None:
        with self.output_lock:
            sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def read_commands(self) -> None:
        for line in sys.stdin:
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                self.emit({"type": "engine.error", "message": "Geçersiz JSON mesajı."})
                continue
            self.loop.call_soon_threadsafe(self.commands.put_nowait, raw)
        self.loop.call_soon_threadsafe(self.commands.put_nowait, None)

    def snapshot(self) -> None:
        self.emit({
            "type": "transfers.snapshot",
            "transfers": [public_transfer(item) for item in self.store.list_all()],
            "settings": {
                "maxConcurrent": self.max_concurrent,
                "globalSpeedLimit": self.global_limiter.rate,
            },
        })

    def queue(self, transfer_id: str) -> None:
        if self.store.get(transfer_id) is None:
            raise ValueError("Transfer bulunamadı.")
        if transfer_id in self.tasks:
            raise ValueError("Bu transfer zaten çalışıyor.")
        self.store.update(transfer_id, status="waiting", error=None)
        record = self.store.get(transfer_id)
        self.emit({"type": f"{record['direction']}.queued", "transferId": transfer_id})
        self.schedule()

    def schedule(self) -> None:
        available = self.max_concurrent - len(self.tasks)
        if available <= 0:
            return
        waiting = [item for item in self.store.list_all() if item["status"] == "waiting"]
        for record in waiting[:available]:
            transfer_id = record["id"]
            if transfer_id in self.tasks:
                continue
            control = TransferControl()
            self.controls[transfer_id] = control
            runner = self.run_upload if record["direction"] == "upload" else self.run_transfer
            task = asyncio.create_task(runner(transfer_id, control))
            self.tasks[transfer_id] = task
            task.add_done_callback(lambda _task, item_id=transfer_id: self.cleanup(item_id))

    async def run_transfer(self, transfer_id: str, control: TransferControl) -> None:
        while True:
            record = self.store.get(transfer_id)
            if record is None:
                return
            self.store.update(transfer_id, status="downloading", error=None)

            def handle_event(message: dict[str, Any]) -> None:
                if message["type"] == "download.started":
                    self.store.update(
                        transfer_id, status="downloading",
                        downloaded_bytes=message["downloadedBytes"], total_bytes=message["totalBytes"],
                        supports_ranges=int(message["supportsRanges"]), etag=message.get("etag"),
                        last_modified=message.get("lastModified"),
                    )
                elif message["type"] == "download.progress":
                    self.store.update(transfer_id, downloaded_bytes=message["downloadedBytes"], total_bytes=message["totalBytes"])
                self.emit(message)

            try:
                result = await download_file(record, handle_event, control, self.global_limiter)
                self.store.update(transfer_id, status="completed", downloaded_bytes=result["downloadedBytes"], total_bytes=result["totalBytes"], error=None)
                self.emit({"type": "download.completed", "transferId": transfer_id, **result})
                return
            except TransferStopped as stopped:
                await self.finish_stopped(record, stopped.reason)
                return
            except Exception as error:
                latest = self.store.get(transfer_id)
                retry_count = (latest["retry_count"] if latest else 0) + 1
                max_retries = latest["max_retries"] if latest else 3
                message = user_facing_error(error)
                if retry_count <= max_retries and not control.stop_event.is_set():
                    delay = 2 ** retry_count
                    self.store.update(transfer_id, status="retrying", retry_count=retry_count, error=message)
                    self.emit({"type": "download.retrying", "transferId": transfer_id, "retryCount": retry_count, "maxRetries": max_retries, "retryInSeconds": delay, "message": message})
                    try:
                        await asyncio.wait_for(control.stop_event.wait(), timeout=delay)
                        await self.finish_stopped(record, control.reason)
                        return
                    except asyncio.TimeoutError:
                        continue
                self.store.update(transfer_id, status="failed", downloaded_bytes=self.artifact_size(record), retry_count=retry_count, error=message)
                self.emit({"type": "download.failed", "transferId": transfer_id, "message": message})
                return

    async def finish_stopped(self, record: dict[str, Any], reason: str) -> None:
        latest = self.store.get(record["id"]) or record
        status = "cancelled" if reason == "cancel" else "paused"
        if status == "cancelled" and record["direction"] == "download":
            cleanup_partial_artifacts(Path(record["partial_path"]))
        downloaded = 0 if status == "cancelled" else (self.artifact_size(latest) if latest["direction"] == "download" else latest["downloaded_bytes"])
        self.store.update(record["id"], status=status, downloaded_bytes=downloaded, error=None)
        self.emit({"type": f"{record['direction']}.{status}", "transferId": record["id"], "downloadedBytes": downloaded, "uploadedBytes": downloaded})

    async def run_upload(self, transfer_id: str, control: TransferControl) -> None:
        connection = self.upload_connections.get(transfer_id)
        if connection is None:
            self.store.update(transfer_id, status="failed", error="Bağlantı profili yeniden seçilmeli.")
            self.emit({"type": "upload.failed", "transferId": transfer_id, "message": "Bağlantı profili yeniden seçilmeli."})
            return
        while True:
            record = self.store.get(transfer_id)
            if record is None:
                return
            self.store.update(transfer_id, status="uploading", error=None)

            def handle_event(message: dict[str, Any]) -> None:
                amount = message.get("downloadedBytes", message.get("uploadedBytes", 0))
                if message["type"] == "download.progress":
                    message["type"] = "upload.progress"
                    message["uploadedBytes"] = amount
                self.store.update(transfer_id, status="uploading", downloaded_bytes=amount, total_bytes=message.get("totalBytes"))
                self.emit(message)

            try:
                result = await upload_file(
                    record, connection, handle_event, control, self.global_limiter,
                    self.store.get_upload_session, self.store.save_upload_session,
                    self.store.clear_upload_session,
                )
                status = "skipped" if result.get("skipped") else "completed"
                amount = result.get("uploadedBytes", 0)
                self.store.update(transfer_id, status=status, downloaded_bytes=amount, total_bytes=result.get("totalBytes"), error=None)
                self.emit({"type": f"upload.{status}", "transferId": transfer_id, **result})
                return
            except TransferStopped as stopped:
                await self.finish_stopped(record, stopped.reason)
                return
            except Exception as error:
                latest = self.store.get(transfer_id)
                retry_count = (latest["retry_count"] if latest else 0) + 1
                max_retries = latest["max_retries"] if latest else 3
                message = upload_error(error)
                if retry_count <= max_retries and not control.stop_event.is_set():
                    delay = 2 ** retry_count
                    self.store.update(transfer_id, status="retrying", retry_count=retry_count, error=message)
                    self.emit({"type": "upload.retrying", "transferId": transfer_id, "retryCount": retry_count, "maxRetries": max_retries, "retryInSeconds": delay, "message": message})
                    try:
                        await asyncio.wait_for(control.stop_event.wait(), timeout=delay)
                        await self.finish_stopped(record, control.reason)
                        return
                    except asyncio.TimeoutError:
                        continue
                self.store.update(transfer_id, status="failed", retry_count=retry_count, error=message)
                self.emit({"type": "upload.failed", "transferId": transfer_id, "message": message})
                return

    def artifact_size(self, record: dict[str, Any]) -> int:
        partial = Path(record["partial_path"])
        sequential = partial_size(partial)
        chunks = sum(partial_size(Path(f"{partial}.{index}")) for index in range(4))
        return max(sequential, chunks)

    def cleanup(self, transfer_id: str) -> None:
        self.tasks.pop(transfer_id, None)
        self.controls.pop(transfer_id, None)
        self.schedule()

    def prepare_destination(self, payload: DownloadPayload) -> tuple[Path, Path] | None:
        destination = Path(payload.destination)
        if destination.exists():
            if payload.conflict_policy == "skip":
                return None
            if payload.conflict_policy == "rename":
                destination = available_name(destination)
        return destination, destination.with_name(f"{destination.name}.part")

    async def act_on_transfer(self, transfer_id: str, action: str) -> None:
        record = self.store.get(transfer_id)
        if record is None:
            return
        if record["direction"] == "upload" and record["provider"] != "s3" and action in {"pause", "resume"}:
            return
        control = self.controls.get(transfer_id)
        if action == "pause":
            if record["status"] not in {"waiting", "downloading", "uploading", "retrying"}:
                return
            if control:
                control.stop("pause")
            elif record["status"] == "waiting":
                self.store.update(transfer_id, status="paused")
                amount = self.artifact_size(record) if record["direction"] == "download" else record["downloaded_bytes"]
                self.emit({
                    "type": f"{record['direction']}.paused", "transferId": transfer_id,
                    "downloadedBytes": amount, "uploadedBytes": amount,
                })
        elif action == "cancel":
            if record["status"] not in {"waiting", "downloading", "uploading", "retrying", "paused", "failed"}:
                return
            if control:
                control.stop("cancel")
            else:
                if record["direction"] == "download":
                    cleanup_partial_artifacts(Path(record["partial_path"]))
                self.store.update(transfer_id, status="cancelled", downloaded_bytes=0)
                self.emit({"type": f"{record['direction']}.cancelled", "transferId": transfer_id, "downloadedBytes": 0, "uploadedBytes": 0})
        elif action in {"resume", "retry"}:
            allowed = {"paused", "cancelled"} if action == "resume" else {"failed"}
            if record["status"] not in allowed:
                return
            if action == "retry":
                self.store.update(transfer_id, retry_count=0, error=None)
            self.queue(transfer_id)

    async def handle_command(self, raw: dict[str, Any]) -> bool:
        try:
            command = Command.model_validate(raw)
            result = await self.execute(command)
            self.emit({"type": "engine.ack", "requestId": command.request_id, "result": result})
            return command.type != "engine.shutdown"
        except (ValidationError, ValueError) as error:
            self.emit({"type": "engine.error", "requestId": raw.get("request_id"), "message": str(error)})
            return True
        except Exception:
            self.emit({"type": "engine.error", "requestId": raw.get("request_id"), "message": "İşlem tamamlanamadı. Bağlantı bilgilerini kontrol edin."})
            return True

    async def execute(self, command: Command) -> dict[str, Any] | None:
        if command.type == "engine.shutdown":
            for control in self.controls.values():
                control.stop("shutdown")
        elif command.type == "transfers.list":
            self.snapshot()
        elif command.type == "download.start":
            payload = DownloadPayload.model_validate(command.payload)
            prepared = self.prepare_destination(payload)
            if prepared is None:
                self.emit({"type": "download.skipped", "transferId": payload.transfer_id, "message": "Aynı adlı dosya zaten bulunduğu için indirme atlandı."})
                return {"skipped": True}
            destination, partial = prepared
            self.store.create({"id": payload.transfer_id, "url": str(payload.url), "destination": str(destination), "partial_path": str(partial), "conflict_policy": payload.conflict_policy, "priority": payload.priority, "speed_limit": payload.speed_limit})
            record = self.store.get(payload.transfer_id)
            self.emit({"type": "download.created", **public_transfer(record)})
            self.queue(payload.transfer_id)
            return {"transferId": payload.transfer_id, "destination": str(destination)}
        elif command.type in {"download.pause", "download.resume", "download.cancel", "download.retry"}:
            payload = TransferPayload.model_validate(command.payload)
            await self.act_on_transfer(payload.transfer_id, command.type.split(".")[1])
        elif command.type == "download.priority":
            payload = PriorityPayload.model_validate(command.payload)
            self.store.update(payload.transfer_id, priority=payload.priority)
            self.emit({"type": "download.priority", "transferId": payload.transfer_id, "priority": payload.priority})
            self.schedule()
        elif command.type == "transfers.bulk":
            payload = BulkPayload.model_validate(command.payload)
            for transfer_id in payload.transfer_ids:
                await self.act_on_transfer(transfer_id, payload.action)
        elif command.type == "settings.update":
            payload = SettingsPayload.model_validate(command.payload)
            self.max_concurrent = payload.max_concurrent
            self.global_limiter.set_rate(payload.global_speed_limit)
            self.store.set_setting("max_concurrent", str(payload.max_concurrent))
            self.store.set_setting("global_speed_limit", str(payload.global_speed_limit))
            self.emit({"type": "settings.updated", "maxConcurrent": self.max_concurrent, "globalSpeedLimit": self.global_limiter.rate})
            self.schedule()
        elif command.type == "upload.start":
            payload = UploadPayload.model_validate(command.payload)
            source = Path(payload.source_path)
            if not source.is_file():
                raise ValueError("Yüklenecek dosya bulunamadı.")
            self.store.create_upload({
                "id": payload.transfer_id, "source_path": str(source),
                "remote_path": payload.remote_path, "provider": payload.provider,
                "profile_id": payload.profile_id, "conflict_policy": payload.conflict_policy,
                "total_bytes": source.stat().st_size, "priority": payload.priority,
                "speed_limit": payload.speed_limit,
            })
            self.upload_connections[payload.transfer_id] = payload.connection
            record = self.store.get(payload.transfer_id)
            self.emit({"type": "upload.created", **public_transfer(record)})
            self.queue(payload.transfer_id)
            return {"transferId": payload.transfer_id}
        elif command.type in {"upload.pause", "upload.cancel"}:
            payload = TransferPayload.model_validate(command.payload)
            await self.act_on_transfer(payload.transfer_id, command.type.split(".")[1])
        elif command.type == "upload.retry":
            payload = UploadRetryPayload.model_validate(command.payload)
            self.upload_connections[payload.transfer_id] = payload.connection
            self.store.update(payload.transfer_id, retry_count=0, error=None)
            self.queue(payload.transfer_id)
        elif command.type == "profile.test":
            payload = ProfileTestPayload.model_validate(command.payload)
            return await test_connection(payload.provider, payload.connection)
        elif command.type == "provider.list":
            payload = ProviderListPayload.model_validate(command.payload)
            return await list_remote(payload.provider, payload.connection, payload.path)
        elif command.type == "scan.start":
            payload = ScanPayload.model_validate(command.payload)
            return await scan_url(str(payload.url))
        return None

    async def run(self) -> None:
        self.emit({"type": "engine.ready", "version": "0.6.0"})
        self.snapshot()
        while True:
            command = await self.commands.get()
            if command is None or not await self.handle_command(command):
                break
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.store.close()

    def start(self) -> None:
        threading.Thread(target=self.read_commands, daemon=True).start()
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.run())


def available_name(path: Path) -> Path:
    counter = 1
    while True:
        candidate = path.with_name(f"{path.stem} ({counter}){path.suffix}")
        if not candidate.exists() and not Path(f"{candidate}.part").exists():
            return candidate
        counter += 1


if __name__ == "__main__":
    TransferEngine().start()
