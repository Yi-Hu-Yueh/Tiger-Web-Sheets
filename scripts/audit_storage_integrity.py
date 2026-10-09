from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.models import WorkbookRecord, WorkbookVersionRecord  # noqa: E402
from app.services.history_storage import HistoryStorage  # noqa: E402
from app.services.native_workbook_storage import NativeWorkbookStorage  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only Tiger Web Sheets storage integrity audit")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--workbooks", type=Path, required=True)
    parser.add_argument("--history", type=Path, required=True)
    arguments = parser.parse_args()

    database = arguments.database.resolve()
    workbooks = arguments.workbooks.resolve()
    history = arguments.history.resolve()
    native_storage = NativeWorkbookStorage(workbooks)
    history_storage = HistoryStorage(history)

    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if [row[0] for row in integrity] != ["ok"]:
            raise RuntimeError(f"SQLite integrity_check failed: {[row[0] for row in integrity]}")
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_keys:
            raise RuntimeError(f"SQLite foreign_key_check failed: {len(foreign_keys)} row(s)")
        orphan_versions = connection.execute(
            """
            SELECT COUNT(*) FROM workbook_versions v
            LEFT JOIN workbooks w ON w.id = v.workbook_id WHERE w.id IS NULL
            """
        ).fetchone()[0]
        if orphan_versions:
            raise RuntimeError(f"orphan version metadata: {orphan_versions}")

        workbook_rows = connection.execute(
            "SELECT id, name, snapshot_json, revision, created_at, updated_at FROM workbooks"
        ).fetchall()
        version_rows = connection.execute(
            """
            SELECT version_id, workbook_id, source_revision, created_at, source_type,
                   label, snapshot_sha256, native_file_name FROM workbook_versions
            """
        ).fetchall()
    finally:
        connection.close()

    for row in workbook_rows:
        record = WorkbookRecord(
            id=row["id"], name=row["name"], snapshot=json.loads(row["snapshot_json"]),
            revision=row["revision"], created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )
        native_storage.verify(record)

    expected_managed = {native_storage.file_path(row["id"]).resolve() for row in workbook_rows}
    actual_managed = {path.resolve() for path in workbooks.glob("*.tws.json")}
    if actual_managed != expected_managed:
        raise RuntimeError("managed workbook files do not exactly match SQLite records")

    workbook_ids = {row["id"] for row in workbook_rows}
    expected_history: set[Path] = set()
    for row in version_rows:
        if row["workbook_id"] not in workbook_ids:
            raise RuntimeError("cross-workbook/orphan version reference")
        record = WorkbookVersionRecord(
            version_id=row["version_id"], workbook_id=row["workbook_id"],
            source_revision=row["source_revision"], created_at=datetime.fromisoformat(row["created_at"]),
            source_type=row["source_type"], label=row["label"], snapshot_sha256=row["snapshot_sha256"],
            native_file_name=row["native_file_name"],
        )
        history_storage.verify(record)
        expected_history.add(history_storage.file_path(record.workbook_id, record.version_id).resolve())

    actual_history = {path.resolve() for path in history.glob("*/*.tws.json")}
    if actual_history != expected_history:
        raise RuntimeError("history files do not exactly match version metadata")

    print(json.dumps({
        "result": "PASS", "integrity_check": "ok", "foreign_key_check": "ok",
        "workbooks": len(workbook_rows), "versions": len(version_rows),
        "managed_files_verified": len(workbook_rows), "history_files_verified": len(version_rows),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
