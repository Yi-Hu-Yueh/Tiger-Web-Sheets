from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.database import connect, initialize_database
from app.models import WorkbookRecord
from app.services.native_workbook_storage import (
    NativeWorkbookError,
    NativeWorkbookStatus,
    NativeWorkbookStorage,
)


class WorkbookConflictError(Exception):
    """Raised when a client tries to save against a stale revision."""


class WorkbookStore:
    def __init__(self, database_path: Path, workbook_root: Path) -> None:
        self.database_path = database_path
        self.native_storage = NativeWorkbookStorage(workbook_root)

    def initialize(self) -> None:
        initialize_database(self.database_path)
        self.native_storage.root.mkdir(parents=True, exist_ok=True)
        # SQLite is authoritative for legacy records. A missing native file is
        # the one condition that can be repaired automatically and idempotently.
        for record in self._list_unverified():
            if self.native_storage.read_bytes(record.id) is None:
                self.native_storage.write_record(record)
            self.native_storage.verify(record)

    def get(self, workbook_id: str) -> WorkbookRecord | None:
        connection = connect(self.database_path)
        try:
            row = connection.execute(
                """
                SELECT id, name, snapshot_json, revision, created_at, updated_at
                FROM workbooks WHERE id = ?
                """,
                (workbook_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            return None
        record = self._to_record(row)
        self.native_storage.verify(record)
        return record

    def list(self) -> list[WorkbookRecord]:
        records = self._list_unverified()
        for record in records:
            self.native_storage.verify(record)
        return records

    def storage_status(self, workbook_id: str) -> NativeWorkbookStatus | None:
        record = self.get(workbook_id)
        return self.native_storage.verify(record) if record is not None else None

    def create(self, name: str, snapshot: dict[str, Any]) -> WorkbookRecord:
        return self.put(str(uuid.uuid4()), name, snapshot, expected_revision=0)

    def put(
        self,
        workbook_id: str,
        name: str,
        snapshot: dict[str, Any],
        expected_revision: int,
    ) -> WorkbookRecord:
        snapshot_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        timestamp = datetime.now(timezone.utc).isoformat()
        connection = connect(self.database_path)
        previous_native: bytes | None = None
        native_changed = False
        committed = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                """
                SELECT id, name, snapshot_json, revision, created_at, updated_at
                FROM workbooks WHERE id = ?
                """,
                (workbook_id,),
            ).fetchone()
            if current is None:
                if expected_revision != 0:
                    raise WorkbookConflictError(
                        f"workbook does not exist; expected revision must be 0, got {expected_revision}"
                    )
                revision = 1
                created_at = timestamp
            else:
                current_revision = int(current["revision"])
                if current_revision != expected_revision:
                    raise WorkbookConflictError(
                        f"stale revision {expected_revision}; current revision is {current_revision}"
                    )
                revision = current_revision + 1
                created_at = str(current["created_at"])

            record = WorkbookRecord(
                id=workbook_id,
                name=name,
                snapshot=json.loads(snapshot_json),
                revision=revision,
                created_at=datetime.fromisoformat(created_at),
                updated_at=datetime.fromisoformat(timestamp),
            )
            previous_native = self.native_storage.read_bytes(workbook_id)
            self.native_storage.write_record(record)
            native_changed = True
            self.native_storage.verify(record)
            if current is None:
                connection.execute(
                    """
                    INSERT INTO workbooks (
                        id, name, snapshot_json, revision, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (workbook_id, name, snapshot_json, revision, created_at, timestamp),
                )
            else:
                connection.execute(
                    """
                    UPDATE workbooks
                    SET name = ?, snapshot_json = ?, revision = ?, updated_at = ?
                    WHERE id = ? AND revision = ?
                    """,
                    (name, snapshot_json, revision, timestamp, workbook_id, expected_revision),
                )
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed and native_changed:
                self._restore_native(workbook_id, previous_native)
            raise
        finally:
            connection.close()

        self._verify_or_recover(record)
        return record

    def rename(
        self, workbook_id: str, name: str, expected_revision: int
    ) -> WorkbookRecord | None:
        timestamp = datetime.now(timezone.utc).isoformat()
        connection = connect(self.database_path)
        previous_native: bytes | None = None
        native_changed = False
        committed = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                """
                SELECT id, name, snapshot_json, revision, created_at, updated_at
                FROM workbooks WHERE id = ?
                """,
                (workbook_id,),
            ).fetchone()
            if current is None:
                connection.rollback()
                return None
            current_revision = int(current["revision"])
            if current_revision != expected_revision:
                raise WorkbookConflictError(
                    f"stale revision {expected_revision}; current revision is {current_revision}"
                )
            record = WorkbookRecord(
                id=str(current["id"]),
                name=name,
                snapshot=json.loads(str(current["snapshot_json"])),
                revision=current_revision + 1,
                created_at=datetime.fromisoformat(str(current["created_at"])),
                updated_at=datetime.fromisoformat(timestamp),
            )
            previous_native = self.native_storage.read_bytes(workbook_id)
            self.native_storage.write_record(record)
            native_changed = True
            self.native_storage.verify(record)
            connection.execute(
                """
                UPDATE workbooks
                SET name = ?, revision = ?, updated_at = ?
                WHERE id = ? AND revision = ?
                """,
                (name, record.revision, timestamp, workbook_id, current_revision),
            )
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed and native_changed:
                self._restore_native(workbook_id, previous_native)
            raise
        finally:
            connection.close()

        self._verify_or_recover(record)
        return record

    def delete(self, workbook_id: str) -> bool:
        connection = connect(self.database_path)
        quarantine: Path | None = None
        committed = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                """
                SELECT id, name, snapshot_json, revision, created_at, updated_at
                FROM workbooks WHERE id = ?
                """,
                (workbook_id,),
            ).fetchone()
            if current is None:
                connection.rollback()
                return False
            self.native_storage.verify(self._to_record(current))
            quarantine = self.native_storage.quarantine(workbook_id)
            cursor = connection.execute("DELETE FROM workbooks WHERE id = ?", (workbook_id,))
            if cursor.rowcount != 1:
                raise sqlite3.DatabaseError("target workbook was not deleted")
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed:
                self.native_storage.restore_quarantine(workbook_id, quarantine)
            raise
        finally:
            connection.close()
        self.native_storage.remove_quarantine(quarantine)
        return True

    def _list_unverified(self) -> list[WorkbookRecord]:
        connection = connect(self.database_path)
        try:
            rows = connection.execute(
                """
                SELECT id, name, snapshot_json, revision, created_at, updated_at
                FROM workbooks ORDER BY updated_at DESC, id ASC
                """
            ).fetchall()
        finally:
            connection.close()
        return [self._to_record(row) for row in rows]

    def _verify_or_recover(self, record: WorkbookRecord) -> None:
        try:
            self.native_storage.verify(record)
        except NativeWorkbookError:
            self.native_storage.write_record(record)
            self.native_storage.verify(record)

    def _restore_native(self, workbook_id: str, previous: bytes | None) -> None:
        try:
            self.native_storage.restore_bytes(workbook_id, previous)
        except NativeWorkbookError as error:
            raise NativeWorkbookError(
                "database write failed and native workbook rollback also failed"
            ) from error

    def _commit(self, connection: sqlite3.Connection) -> None:
        connection.commit()

    @staticmethod
    def _to_record(row: Any) -> WorkbookRecord:
        return WorkbookRecord(
            id=str(row["id"]),
            name=str(row["name"]),
            snapshot=json.loads(str(row["snapshot_json"])),
            revision=int(row["revision"]),
            created_at=datetime.fromisoformat(str(row["created_at"])),
            updated_at=datetime.fromisoformat(str(row["updated_at"])),
        )
