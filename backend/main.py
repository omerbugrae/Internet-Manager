from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import uuid
from datetime import UTC, datetime, timedelta
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
from protocol import AutomationPayload, BulkPayload, Command, DownloadPayload, NetworkPayload, PriorityPayload, ProbePayload, ProfileTestPayload, ProviderListPayload, ScanPayload, SchedulePayload, SettingsPayload, TransferPayload, UploadPayload, UploadRetryPayload
from scanner import probe_urls, scan_url
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
        self.base_speed_limit = int(self.store.get_setting("global_speed_limit", "0"))
        self.global_limiter = BandwidthLimiter(self.base_speed_limit)
        self.upload_connections: dict[str, dict[str, Any]] = {}
        self.speed_windows = self.load_speed_windows()
        self.missed_policy = self.store.get_setting("missed_schedule_policy", "run")
        self.active_window_limit: int | None = None
        self.auto_paused: set[str] = set()
        self.online = True

    def load_speed_windows(self) -> list[dict[str, Any]]:
        try:
            windows = json.loads(self.store.get_setting("speed_windows", "[]"))
        except json.JSONDecodeError:
            return []
        return windows if isinstance(windows, list) else []

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
                "automation": self.automation_settings(),
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

    def automation_settings(self) -> dict[str, Any]:
        return {
            "speedWindows": self.speed_windows,
            "missedPolicy": self.missed_policy,
            "activeWindowLimit": self.active_window_limit,
            "baseSpeedLimit": self.base_speed_limit,
        }

    @staticmethod
    def parse_moment(value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)

    @staticmethod
    def next_occurrence(moment: datetime, rule: str) -> datetime | None:
        if rule == "daily":
            return moment + timedelta(days=1)
        if rule == "weekly":
            return moment + timedelta(weeks=1)
        return None

    def current_window_limit(self) -> int | None:
        current = datetime.now().strftime("%H:%M")
        for window in self.speed_windows:
            start, end, limit = window.get("start"), window.get("end"), window.get("limit")
            if not isinstance(start, str) or not isinstance(end, str) or not isinstance(limit, int):
                continue
            inside = start <= current < end if start <= end else (current >= start or current < end)
            if inside:
                return max(limit, 0)
        return None

    def apply_speed_window(self) -> None:
        limit = self.current_window_limit()
        if limit == self.active_window_limit:
            return
        self.active_window_limit = limit
        effective = self.base_speed_limit if limit is None else limit
        self.global_limiter.set_rate(effective)
        self.emit({
            "type": "settings.updated",
            "maxConcurrent": self.max_concurrent,
            "globalSpeedLimit": effective,
            "activeWindowLimit": limit,
        })

    def apply_missed_schedules(self) -> None:
        if self.missed_policy != "skip":
            return
        now = datetime.now(UTC)
        for record in self.store.list_all():
            if record["status"] != "scheduled":
                continue
            moment = self.parse_moment(record["scheduled_at"])
            if moment is None or moment > now:
                continue
            upcoming = moment
            while upcoming <= now:
                following = self.next_occurrence(upcoming, record["repeat_rule"])
                if following is None:
                    self.store.update(record["id"], status="cancelled", scheduled_at=None)
                    self.emit({
                        "type": f"{record['direction']}.cancelled", "transferId": record["id"],
                        "downloadedBytes": 0, "uploadedBytes": 0,
                    })
                    upcoming = None
                    break
                upcoming = following
            if upcoming is not None:
                self.store.update(record["id"], scheduled_at=upcoming.isoformat())
                self.emit({
                    "type": "transfer.scheduled", "transferId": record["id"],
                    "scheduledAt": upcoming.isoformat(), "repeatRule": record["repeat_rule"],
                })

    def create_next_occurrence(self, record: dict[str, Any], upcoming: datetime) -> None:
        new_id = str(uuid.uuid4())
        if record["direction"] == "upload":
            self.store.create_upload({
                "id": new_id, "source_path": record["source_path"], "remote_path": record["remote_path"],
                "provider": record["provider"], "profile_id": record["profile_id"],
                "conflict_policy": record["conflict_policy"], "total_bytes": record["total_bytes"] or 0,
                "priority": record["priority"], "speed_limit": record["speed_limit"],
                "scheduled_at": upcoming.isoformat(), "repeat_rule": record["repeat_rule"],
            })
            connection = self.upload_connections.get(record["id"])
            if connection is not None:
                self.upload_connections[new_id] = connection
        else:
            self.store.create({
                "id": new_id, "url": record["url"], "destination": record["destination"],
                "partial_path": record["partial_path"], "conflict_policy": record["conflict_policy"],
                "priority": record["priority"], "speed_limit": record["speed_limit"],
                "scheduled_at": upcoming.isoformat(), "repeat_rule": record["repeat_rule"],
            })
        fresh = self.store.get(new_id)
        self.emit({"type": f"{record['direction']}.created", **public_transfer(fresh)})

    def start_scheduled(self, record: dict[str, Any], moment: datetime, now: datetime) -> None:
        transfer_id = record["id"]
        rule = record["repeat_rule"]
        upcoming = None
        if rule != "none":
            upcoming = self.next_occurrence(moment, rule)
            while upcoming is not None and upcoming <= now:
                upcoming = self.next_occurrence(upcoming, rule)

        if record["direction"] == "upload" and transfer_id not in self.upload_connections:
            message = "Zamanlanmış yükleme için bağlantı profili yeniden seçilmeli."
            self.store.update(transfer_id, status="failed", scheduled_at=None, error=message)
            self.emit({"type": "upload.failed", "transferId": transfer_id, "message": message})
            if upcoming is not None:
                self.create_next_occurrence(record, upcoming)
            return

        if record["direction"] == "download":
            destination = Path(record["destination"])
            if destination.exists():
                if record["conflict_policy"] == "skip":
                    self.store.update(transfer_id, status="skipped", scheduled_at=None)
                    self.emit({
                        "type": "download.skipped", "transferId": transfer_id,
                        "message": "Aynı adlı dosya zaten bulunduğu için zamanlanmış indirme atlandı.",
                    })
                    if upcoming is not None:
                        self.create_next_occurrence(record, upcoming)
                    return
                if record["conflict_policy"] == "rename":
                    destination = available_name(destination)
                    self.store.update(
                        transfer_id, destination=str(destination),
                        partial_path=str(destination.with_name(f"{destination.name}.part")),
                    )

        self.store.update(transfer_id, scheduled_at=None, repeat_rule="none")
        self.queue(transfer_id)
        if upcoming is not None:
            self.create_next_occurrence(record, upcoming)

    async def scheduler_tick(self) -> None:
        self.apply_speed_window()
        now = datetime.now(UTC)
        for record in self.store.list_all():
            if record["status"] != "scheduled":
                continue
            moment = self.parse_moment(record["scheduled_at"])
            if moment is None or moment > now:
                continue
            self.start_scheduled(record, moment, now)

    async def scheduler_loop(self) -> None:
        while True:
            await asyncio.sleep(15)
            try:
                await self.scheduler_tick()
            except Exception:
                self.emit({"type": "engine.error", "message": "Zamanlanmış görev denetimi tamamlanamadı."})

    async def handle_network_change(self, online: bool) -> None:
        if online == self.online:
            return
        self.online = online
        if not online:
            for transfer_id, control in list(self.controls.items()):
                record = self.store.get(transfer_id)
                if record and record["status"] in {"downloading", "uploading", "retrying", "waiting"}:
                    self.auto_paused.add(transfer_id)
                    control.stop("pause")
            self.emit({"type": "network.offline", "pausedTransfers": len(self.auto_paused)})
            return

        await asyncio.sleep(2)
        resumed = 0
        for transfer_id in list(self.auto_paused):
            self.auto_paused.discard(transfer_id)
            for _ in range(20):
                record = self.store.get(transfer_id)
                if record is None or record["status"] not in {"downloading", "uploading", "retrying"}:
                    break
                await asyncio.sleep(0.5)
            record = self.store.get(transfer_id)
            if record and record["status"] == "paused":
                await self.act_on_transfer(transfer_id, "resume")
                resumed += 1
        self.emit({"type": "network.online", "resumedTransfers": resumed})

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
            scheduled_at = self.normalize_schedule(payload.scheduled_at)
            prepared = self.prepare_destination(payload)
            if prepared is None:
                self.emit({"type": "download.skipped", "transferId": payload.transfer_id, "message": "Aynı adlı dosya zaten bulunduğu için indirme atlandı."})
                return {"skipped": True}
            destination, partial = prepared
            self.store.create({"id": payload.transfer_id, "url": str(payload.url), "destination": str(destination), "partial_path": str(partial), "conflict_policy": payload.conflict_policy, "priority": payload.priority, "speed_limit": payload.speed_limit, "scheduled_at": scheduled_at, "repeat_rule": payload.repeat_rule})
            record = self.store.get(payload.transfer_id)
            self.emit({"type": "download.created", **public_transfer(record)})
            if scheduled_at is None:
                self.queue(payload.transfer_id)
            return {"transferId": payload.transfer_id, "destination": str(destination), "scheduledAt": scheduled_at}
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
            self.base_speed_limit = payload.global_speed_limit
            self.store.set_setting("max_concurrent", str(payload.max_concurrent))
            self.store.set_setting("global_speed_limit", str(payload.global_speed_limit))
            window_limit = self.current_window_limit()
            self.active_window_limit = window_limit
            self.global_limiter.set_rate(self.base_speed_limit if window_limit is None else window_limit)
            self.emit({"type": "settings.updated", "maxConcurrent": self.max_concurrent, "globalSpeedLimit": self.global_limiter.rate, "activeWindowLimit": window_limit})
            self.schedule()
        elif command.type == "upload.start":
            payload = UploadPayload.model_validate(command.payload)
            source = Path(payload.source_path)
            if not source.is_file():
                raise ValueError("Yüklenecek dosya bulunamadı.")
            scheduled_at = self.normalize_schedule(payload.scheduled_at)
            self.store.create_upload({
                "id": payload.transfer_id, "source_path": str(source),
                "remote_path": payload.remote_path, "provider": payload.provider,
                "profile_id": payload.profile_id, "conflict_policy": payload.conflict_policy,
                "total_bytes": source.stat().st_size, "priority": payload.priority,
                "speed_limit": payload.speed_limit, "scheduled_at": scheduled_at,
                "repeat_rule": payload.repeat_rule,
            })
            self.upload_connections[payload.transfer_id] = payload.connection
            record = self.store.get(payload.transfer_id)
            self.emit({"type": "upload.created", **public_transfer(record)})
            if scheduled_at is None:
                self.queue(payload.transfer_id)
            return {"transferId": payload.transfer_id, "scheduledAt": scheduled_at}
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
        elif command.type == "download.probe":
            payload = ProbePayload.model_validate(command.payload)
            items = await probe_urls([str(url) for url in payload.urls])
            return {"items": items}
        elif command.type == "transfer.schedule":
            payload = SchedulePayload.model_validate(command.payload)
            record = self.store.get(payload.transfer_id)
            if record is None:
                raise ValueError("Transfer bulunamadı.")
            if record["status"] not in {"scheduled", "waiting", "paused", "cancelled", "failed", "completed", "skipped"}:
                raise ValueError("Çalışan bir transfer zamanlanamaz.")
            scheduled_at = self.normalize_schedule(payload.scheduled_at)
            if scheduled_at is None:
                self.store.update(payload.transfer_id, scheduled_at=None, repeat_rule="none")
                if record["status"] == "scheduled":
                    self.store.update(payload.transfer_id, status="paused")
            else:
                self.store.update(
                    payload.transfer_id, scheduled_at=scheduled_at,
                    repeat_rule=payload.repeat_rule, status="scheduled", error=None,
                )
            self.emit({
                "type": "transfer.scheduled", "transferId": payload.transfer_id,
                "scheduledAt": scheduled_at, "repeatRule": payload.repeat_rule if scheduled_at else "none",
            })
            return {"scheduledAt": scheduled_at}
        elif command.type == "automation.get":
            return self.automation_settings()
        elif command.type == "automation.update":
            payload = AutomationPayload.model_validate(command.payload)
            self.speed_windows = [window.model_dump() for window in payload.speed_windows]
            self.missed_policy = payload.missed_policy
            self.store.set_setting("speed_windows", json.dumps(self.speed_windows))
            self.store.set_setting("missed_schedule_policy", self.missed_policy)
            self.active_window_limit = None
            self.apply_speed_window()
            return self.automation_settings()
        elif command.type == "network.changed":
            payload = NetworkPayload.model_validate(command.payload)
            await self.handle_network_change(payload.online)
            return {"online": self.online}
        return None

    @staticmethod
    def normalize_schedule(value: str | None) -> str | None:
        moment = TransferEngine.parse_moment(value)
        return moment.isoformat() if moment else None

    async def run(self) -> None:
        self.emit({"type": "engine.ready", "version": "0.8.0"})
        self.apply_missed_schedules()
        self.apply_speed_window()
        self.snapshot()
        scheduler = asyncio.create_task(self.scheduler_loop())
        while True:
            command = await self.commands.get()
            if command is None or not await self.handle_command(command):
                break
        scheduler.cancel()
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
