from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATABASE_PATH = PROJECT_ROOT / "data" / "tiger_web_sheets.db"
ISOLATED_TEST_RUNTIME = "isolated-test"


@dataclass(frozen=True)
class RuntimeIdentity:
    mode: str
    database_path: Path
    instance_nonce: str | None


def resolve_database_path(database_path: str | Path | None = None) -> Path:
    if database_path is not None:
        return Path(database_path).resolve()

    configured = os.environ.get("TIGER_WEB_SHEETS_DB")
    return Path(configured).resolve() if configured else DEFAULT_DATABASE_PATH


def resolve_runtime_identity(database_path: str | Path | None = None) -> RuntimeIdentity:
    resolved_database_path = resolve_database_path(database_path)
    mode = os.environ.get("TIGER_WEB_SHEETS_RUNTIME", "manual").strip() or "manual"
    instance_nonce = os.environ.get("TIGER_WEB_SHEETS_INSTANCE_NONCE")

    if mode == ISOLATED_TEST_RUNTIME:
        if database_path is None and not os.environ.get("TIGER_WEB_SHEETS_DB"):
            raise RuntimeError("isolated-test runtime requires explicit TIGER_WEB_SHEETS_DB")
        if resolved_database_path == DEFAULT_DATABASE_PATH.resolve():
            raise RuntimeError("isolated-test runtime refuses the production/manual database")
        if not instance_nonce or not instance_nonce.strip():
            raise RuntimeError("isolated-test runtime requires TIGER_WEB_SHEETS_INSTANCE_NONCE")

    return RuntimeIdentity(
        mode=mode,
        database_path=resolved_database_path,
        instance_nonce=instance_nonce,
    )


def connect(database_path: Path) -> sqlite3.Connection:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def initialize_database(database_path: Path) -> None:
    connection = connect(database_path)
    try:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS workbooks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
                revision INTEGER NOT NULL CHECK (revision >= 1),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.commit()
    finally:
        connection.close()
