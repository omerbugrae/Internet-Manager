import sqlite3

from backend.storage import TransferStore


def test_new_database_reaches_latest_schema(tmp_path):
    store = TransferStore(tmp_path)
    try:
        diagnostics = store.diagnostics()
        assert diagnostics["schemaVersion"] == 2
        assert diagnostics["integrity"] == "ok"
        assert diagnostics["journalMode"] == "wal"
    finally:
        store.close()


def test_v08_database_is_migrated_without_losing_rows(tmp_path):
    database = tmp_path / "transfers.db"
    connection = sqlite3.connect(database)
    connection.executescript("""
        CREATE TABLE transfers (
            id TEXT PRIMARY KEY, url TEXT NOT NULL, destination TEXT NOT NULL,
            partial_path TEXT NOT NULL, conflict_policy TEXT NOT NULL DEFAULT 'overwrite',
            status TEXT NOT NULL, total_bytes INTEGER, downloaded_bytes INTEGER NOT NULL DEFAULT 0,
            etag TEXT, last_modified TEXT, supports_ranges INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 3, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO transfers (
            id, url, destination, partial_path, status, created_at, updated_at
        ) VALUES ('legacy', 'https://example.test/a', 'a', 'a.part', 'paused', 'now', 'now');
    """)
    connection.close()

    store = TransferStore(tmp_path)
    try:
        record = store.get("legacy")
        assert record is not None
        assert record["direction"] == "download"
        assert record["repeat_rule"] == "none"
        assert store.diagnostics()["schemaVersion"] == 2
    finally:
        store.close()


def test_running_transfer_is_recovered_as_paused(tmp_path):
    store = TransferStore(tmp_path)
    store.create({
        "id": "crashed", "url": "https://example.test/file",
        "destination": "file", "partial_path": "file.part",
        "conflict_policy": "overwrite",
    })
    store.update("crashed", status="downloading", error="temporary")
    store.close()

    reopened = TransferStore(tmp_path)
    try:
        reopened.mark_interrupted_as_paused()
        record = reopened.get("crashed")
        assert record["status"] == "paused"
        assert record["error"] is None
    finally:
        reopened.close()
