from __future__ import annotations

import os
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATABASE_PATH = PROJECT_ROOT / "data" / "tiger_web_sheets.db"


def resolve_database_path(database_path: str | Path | None = None) -> Path:
    if database_path is not None:
        return Path(database_path).resolve()

    configured = os.environ.get("TIGER_WEB_SHEETS_DB")
    return Path(configured).resolve() if configured else DEFAULT_DATABASE_PATH


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
