from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.database import connect, initialize_database
from app.models import WorkbookRecord


class WorkbookConflictError(Exception):
    """Raised when a client tries to save against a stale revision."""


class WorkbookStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def initialize(self) -> None:
        initialize_database(self.database_path)

    def get(self, workbook_id: str) -> WorkbookRecord | None:
        connection = connect(self.database_path)
        try:
            row = connection.execute(
                """
                SELECT id, name, snapshot_json, revision, created_at, updated_at
                FROM workbooks
                WHERE id = ?
                """,
                (workbook_id,),
            ).fetchone()
        finally:
            connection.close()

        return self._to_record(row) if row is not None else None

    def list(self) -> list[WorkbookRecord]:
        connection = connect(self.database_path)
        try:
            rows = connection.execute(
                """
                SELECT id, name, snapshot_json, revision, created_at, updated_at
                FROM workbooks
                ORDER BY updated_at DESC, id ASC
                """
            ).fetchall()
        finally:
            connection.close()
        return [self._to_record(row) for row in rows]

    def create(self, name: str, snapshot: dict[str, Any]) -> WorkbookRecord:
        workbook_id = str(uuid.uuid4())
        return self.put(workbook_id, name, snapshot, expected_revision=0)

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

        try:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT revision, created_at FROM workbooks WHERE id = ?",
                (workbook_id,),
            ).fetchone()

            if current is None:
                if expected_revision != 0:
                    raise WorkbookConflictError(
                        f"workbook does not exist; expected revision must be 0, got {expected_revision}"
                    )
                revision = 1
                created_at = timestamp
                connection.execute(
                    """
                    INSERT INTO workbooks (
                        id, name, snapshot_json, revision, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (workbook_id, name, snapshot_json, revision, created_at, timestamp),
                )
            else:
                current_revision = int(current["revision"])
                if current_revision != expected_revision:
                    raise WorkbookConflictError(
                        f"stale revision {expected_revision}; current revision is {current_revision}"
                    )
                revision = current_revision + 1
                created_at = str(current["created_at"])
                connection.execute(
                    """
                    UPDATE workbooks
                    SET name = ?, snapshot_json = ?, revision = ?, updated_at = ?
                    WHERE id = ? AND revision = ?
                    """,
                    (name, snapshot_json, revision, timestamp, workbook_id, current_revision),
                )

            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

        return WorkbookRecord(
            id=workbook_id,
            name=name,
            snapshot=json.loads(snapshot_json),
            revision=revision,
            created_at=datetime.fromisoformat(created_at),
            updated_at=datetime.fromisoformat(timestamp),
        )

    def rename(
        self, workbook_id: str, name: str, expected_revision: int
    ) -> WorkbookRecord | None:
        timestamp = datetime.now(timezone.utc).isoformat()
        connection = connect(self.database_path)
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
            revision = current_revision + 1
            connection.execute(
                """
                UPDATE workbooks
                SET name = ?, revision = ?, updated_at = ?
                WHERE id = ? AND revision = ?
                """,
                (name, revision, timestamp, workbook_id, current_revision),
            )
            connection.commit()
            return WorkbookRecord(
                id=str(current["id"]),
                name=name,
                snapshot=json.loads(str(current["snapshot_json"])),
                revision=revision,
                created_at=datetime.fromisoformat(str(current["created_at"])),
                updated_at=datetime.fromisoformat(timestamp),
            )
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def delete(self, workbook_id: str) -> bool:
        connection = connect(self.database_path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute("DELETE FROM workbooks WHERE id = ?", (workbook_id,))
            connection.commit()
            return cursor.rowcount == 1
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

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
