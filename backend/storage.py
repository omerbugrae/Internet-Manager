from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class TransferStore:
    def __init__(self, data_directory: Path) -> None:
        data_directory.mkdir(parents=True, exist_ok=True)
        self.database_path = data_directory / "transfers.db"
        self.connection = sqlite3.connect(self.database_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA busy_timeout=5000")
        self.connection.execute("PRAGMA journal_mode=WAL")
        self._migrate()

    def _migrate(self) -> None:
        version = int(self.connection.execute("PRAGMA user_version").fetchone()[0])
        if version > 2:
            raise RuntimeError(f"Veritabanı sürümü desteklenmiyor: {version}")
        if version < 1:
            self.connection.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                destination TEXT NOT NULL,
                partial_path TEXT NOT NULL,
                conflict_policy TEXT NOT NULL DEFAULT 'overwrite',
                status TEXT NOT NULL,
                total_bytes INTEGER,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                etag TEXT,
                last_modified TEXT,
                supports_ranges INTEGER,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 3,
                error TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                speed_limit INTEGER NOT NULL DEFAULT 0,
                direction TEXT NOT NULL DEFAULT 'download',
                source_path TEXT,
                remote_path TEXT,
                provider TEXT,
                profile_id TEXT,
                scheduled_at TEXT,
                repeat_rule TEXT NOT NULL DEFAULT 'none',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS transfers_status_idx ON transfers(status);
            CREATE INDEX IF NOT EXISTS transfers_updated_idx ON transfers(updated_at DESC);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS upload_sessions (
                transfer_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                remote_path TEXT NOT NULL,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS migration_history (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            COMMIT;
        """)
            columns = {
                row["name"] for row in self.connection.execute("PRAGMA table_info(transfers)")
            }
            for name, definition in {
                "priority": "INTEGER NOT NULL DEFAULT 0",
                "speed_limit": "INTEGER NOT NULL DEFAULT 0",
                "direction": "TEXT NOT NULL DEFAULT 'download'",
                "source_path": "TEXT",
                "remote_path": "TEXT",
                "provider": "TEXT",
                "profile_id": "TEXT",
                "scheduled_at": "TEXT",
                "repeat_rule": "TEXT NOT NULL DEFAULT 'none'",
            }.items():
                if name not in columns:
                    self.connection.execute(f"ALTER TABLE transfers ADD COLUMN {name} {definition}")
            self._record_migration(1)
            version = 1
        if version < 2:
            with self.connection:
                self.connection.execute(
                    "CREATE INDEX IF NOT EXISTS transfers_schedule_idx ON transfers(status, scheduled_at)"
                )
                self._record_migration(2)
        self.connection.commit()

    def _record_migration(self, version: int) -> None:
        self.connection.execute(
            "INSERT OR IGNORE INTO migration_history(version, applied_at) VALUES (?, ?)",
            (version, now_iso()),
        )
        self.connection.execute(f"PRAGMA user_version={version}")

    def diagnostics(self) -> dict[str, Any]:
        integrity = self.connection.execute("PRAGMA integrity_check").fetchone()[0]
        return {
            "schemaVersion": int(self.connection.execute("PRAGMA user_version").fetchone()[0]),
            "integrity": integrity,
            "transferCount": int(self.connection.execute("SELECT COUNT(*) FROM transfers").fetchone()[0]),
            "journalMode": self.connection.execute("PRAGMA journal_mode").fetchone()[0],
        }

    def create(self, transfer: dict[str, Any]) -> None:
        timestamp = now_iso()
        scheduled_at = transfer.get("scheduled_at")
        self.connection.execute(
            """
            INSERT INTO transfers (
                id, url, destination, partial_path, conflict_policy, status,
                total_bytes, downloaded_bytes, retry_count, max_retries, priority, speed_limit,
                scheduled_at, repeat_rule, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, 3, ?, ?, ?, ?, ?, ?)
            """,
            (
                transfer["id"], transfer["url"], transfer["destination"],
                transfer["partial_path"], transfer["conflict_policy"],
                "scheduled" if scheduled_at else "waiting",
                transfer.get("priority", 0), transfer.get("speed_limit", 0),
                scheduled_at, transfer.get("repeat_rule", "none"), timestamp, timestamp,
            ),
        )
        self.connection.commit()

    def get(self, transfer_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM transfers WHERE id = ?", (transfer_id,)
        ).fetchone()
        return dict(row) if row else None

    def create_upload(self, transfer: dict[str, Any]) -> None:
        timestamp = now_iso()
        self.connection.execute(
            """
            INSERT INTO transfers (
                id, url, destination, partial_path, conflict_policy, status,
                total_bytes, downloaded_bytes, retry_count, max_retries,
                priority, speed_limit, direction, source_path, remote_path,
                provider, profile_id, scheduled_at, repeat_rule, created_at, updated_at
            ) VALUES (?, '', ?, '', ?, ?, ?, 0, 0, 3, ?, ?,
                      'upload', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                transfer["id"], transfer["remote_path"], transfer["conflict_policy"],
                "scheduled" if transfer.get("scheduled_at") else "waiting",
                transfer["total_bytes"], transfer.get("priority", 0),
                transfer.get("speed_limit", 0), transfer["source_path"],
                transfer["remote_path"], transfer["provider"], transfer["profile_id"],
                transfer.get("scheduled_at"), transfer.get("repeat_rule", "none"),
                timestamp, timestamp,
            ),
        )
        self.connection.commit()

    def list_all(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM transfers ORDER BY priority DESC, created_at ASC"
        ).fetchall()
        return [dict(row) for row in rows]

    def update(self, transfer_id: str, **fields: Any) -> None:
        allowed = {
            "destination", "partial_path", "status", "total_bytes",
            "downloaded_bytes", "etag", "last_modified", "supports_ranges",
            "retry_count", "error", "priority", "speed_limit",
            "scheduled_at", "repeat_rule",
        }
        values = {key: value for key, value in fields.items() if key in allowed}
        if not values:
            return
        values["updated_at"] = now_iso()
        assignments = ", ".join(f"{column} = ?" for column in values)
        self.connection.execute(
            f"UPDATE transfers SET {assignments} WHERE id = ?",
            (*values.values(), transfer_id),
        )
        self.connection.commit()

    def mark_interrupted_as_paused(self) -> None:
        self.connection.execute(
            """
            UPDATE transfers
            SET status = 'paused', error = NULL, updated_at = ?
            WHERE status IN ('waiting', 'downloading', 'uploading', 'retrying')
            """,
            (now_iso(),),
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def get_setting(self, key: str, default: str) -> str:
        row = self.connection.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        self.connection.execute(
            """
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        self.connection.commit()

    def get_upload_session(self, transfer_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT state_json FROM upload_sessions WHERE transfer_id = ?", (transfer_id,)
        ).fetchone()
        return json.loads(row["state_json"]) if row else None

    def save_upload_session(
        self, transfer_id: str, provider: str, remote_path: str, state: dict[str, Any]
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO upload_sessions (transfer_id, provider, remote_path, state_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(transfer_id) DO UPDATE SET
                provider = excluded.provider,
                remote_path = excluded.remote_path,
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
            """,
            (transfer_id, provider, remote_path, json.dumps(state), now_iso()),
        )
        self.connection.commit()

    def clear_upload_session(self, transfer_id: str) -> None:
        self.connection.execute(
            "DELETE FROM upload_sessions WHERE transfer_id = ?", (transfer_id,)
        )
        self.connection.commit()


def public_transfer(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "transferId": record["id"],
        "direction": record["direction"],
        "url": record["url"],
        "destination": record["destination"],
        "status": record["status"],
        "totalBytes": record["total_bytes"],
        "downloadedBytes": record["downloaded_bytes"],
        "supportsRanges": (
            None if record["supports_ranges"] is None else bool(record["supports_ranges"])
        ),
        "retryCount": record["retry_count"],
        "maxRetries": record["max_retries"],
        "priority": record["priority"],
        "speedLimit": record["speed_limit"],
        "error": record["error"],
        "createdAt": record["created_at"],
        "updatedAt": record["updated_at"],
        "sourcePath": record["source_path"],
        "remotePath": record["remote_path"],
        "provider": record["provider"],
        "profileId": record["profile_id"],
        "scheduledAt": record["scheduled_at"],
        "repeatRule": record["repeat_rule"],
    }
