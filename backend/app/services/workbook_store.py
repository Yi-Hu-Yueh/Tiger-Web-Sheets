from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.database import connect, initialize_database
from app.models import WorkbookRecord, WorkbookVersionRecord
from app.services.history_storage import (
    HistoryIntegrityError,
    HistorySnapshotTooLargeError,
    HistoryStorage,
    HistoryStorageError,
)
from app.services.native_workbook_storage import (
    NativeWorkbookError,
    NativeWorkbookStatus,
    NativeWorkbookStorage,
)


class WorkbookConflictError(Exception):
    """Raised when a client tries to save against a stale revision."""


class NativeWorkbookCollisionError(Exception):
    """Raised when an imported native identity disagrees with SQLite."""


class VersionNotFoundError(Exception):
    """Raised when a workbook history version does not exist."""


AUTOMATIC_VERSION_INTERVAL = timedelta(minutes=10)
AUTOMATIC_VERSION_RETENTION = 20


class WorkbookStore:
    def __init__(self, database_path: Path, workbook_root: Path, history_root: Path | None = None) -> None:
        self.database_path = database_path
        self.native_storage = NativeWorkbookStorage(workbook_root)
        self.history_storage = HistoryStorage(history_root or workbook_root.resolve().parent / "history")
        self._now = lambda: datetime.now(timezone.utc)

    def initialize(self) -> None:
        initialize_database(self.database_path)
        self.native_storage.root.mkdir(parents=True, exist_ok=True)
        self.history_storage.root.mkdir(parents=True, exist_ok=True)
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

    def native_document(self, workbook_id: str) -> dict[str, Any] | None:
        record = self.get(workbook_id)
        return self.native_storage.verified_document(record) if record is not None else None

    def import_native(
        self,
        name: str,
        document: dict[str, Any],
    ) -> WorkbookRecord:
        imported = self.native_storage.record_from_document(document, name)
        snapshot_json = json.dumps(
            imported.snapshot, ensure_ascii=False, separators=(",", ":")
        )
        timestamp = imported.updated_at.isoformat()
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
                (imported.id,),
            ).fetchone()
            if current is not None:
                existing = self._to_record(current)
                if (
                    existing.revision != imported.revision
                    or existing.snapshot != imported.snapshot
                ):
                    raise NativeWorkbookCollisionError(
                        "native workbook identity collides with different committed content"
                    )
                self.native_storage.verify(existing)
                connection.rollback()
                return existing

            previous_native = self.native_storage.read_bytes(imported.id)
            if previous_native is not None:
                raise NativeWorkbookCollisionError(
                    "native workbook identity collides with an unmanaged mirror file"
                )
            self.native_storage.write_record(imported)
            native_changed = True
            self.native_storage.verify(imported)
            connection.execute(
                """
                INSERT INTO workbooks (
                    id, name, snapshot_json, revision, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    imported.id,
                    imported.name,
                    snapshot_json,
                    imported.revision,
                    timestamp,
                    timestamp,
                ),
            )
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed and native_changed:
                self._restore_native(imported.id, previous_native)
            raise
        finally:
            connection.close()

        self._verify_or_recover(imported)
        return imported

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
        timestamp = self._now().isoformat()
        connection = connect(self.database_path)
        previous_native: bytes | None = None
        native_changed = False
        committed = False
        automatic: WorkbookVersionRecord | None = None
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
            if current is None or json.loads(str(current["snapshot_json"])) != record.snapshot:
                automatic = self._create_automatic_if_due(connection, record)
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed and native_changed:
                self._restore_native(workbook_id, previous_native)
            if not committed and automatic is not None:
                self.history_storage.remove(automatic.workbook_id, automatic.version_id)
            raise
        finally:
            connection.close()

        self._verify_or_recover(record)
        if automatic is not None:
            self._prune_automatic(record.id)
        return record

    def rename(
        self, workbook_id: str, name: str, expected_revision: int
    ) -> WorkbookRecord | None:
        timestamp = self._now().isoformat()
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
        history_quarantine: Path | None = None
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
            history_quarantine = self.history_storage.quarantine_workbook(workbook_id)
            cursor = connection.execute("DELETE FROM workbooks WHERE id = ?", (workbook_id,))
            if cursor.rowcount != 1:
                raise sqlite3.DatabaseError("target workbook was not deleted")
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed:
                self.native_storage.restore_quarantine(workbook_id, quarantine)
                self.history_storage.restore_quarantine(workbook_id, history_quarantine)
            raise
        finally:
            connection.close()
        self.native_storage.remove_quarantine(quarantine)
        self.history_storage.remove_quarantine(history_quarantine)
        return True

    def create_version(
        self, workbook_id: str, expected_revision: int, label: str | None = None
    ) -> WorkbookVersionRecord:
        connection = connect(self.database_path)
        version: WorkbookVersionRecord | None = None
        committed = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT id, name, snapshot_json, revision, created_at, updated_at FROM workbooks WHERE id = ?",
                (workbook_id,),
            ).fetchone()
            if current is None:
                raise VersionNotFoundError("workbook not found")
            record = self._to_record(current)
            if record.revision != expected_revision:
                raise WorkbookConflictError(
                    f"stale revision {expected_revision}; current revision is {record.revision}"
                )
            self.native_storage.verify(record)
            version = self._insert_version(connection, record, "manual", label)
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed and version is not None:
                self.history_storage.remove(version.workbook_id, version.version_id)
            raise
        finally:
            connection.close()
        return version

    def list_versions(self, workbook_id: str) -> list[WorkbookVersionRecord]:
        connection = connect(self.database_path)
        try:
            exists = connection.execute("SELECT 1 FROM workbooks WHERE id = ?", (workbook_id,)).fetchone()
            if exists is None:
                raise VersionNotFoundError("workbook not found")
            rows = connection.execute(
                """
                SELECT version_id, workbook_id, source_revision, created_at, source_type,
                       label, snapshot_sha256, native_file_name
                FROM workbook_versions WHERE workbook_id = ?
                ORDER BY created_at DESC, version_id DESC
                """,
                (workbook_id,),
            ).fetchall()
        finally:
            connection.close()
        versions = []
        for row in rows:
            record = self._to_version(row)
            try:
                document = self.history_storage.verify(record)
                record = WorkbookVersionRecord(**{**record.__dict__, "snapshot": document["snapshot"]})
            except HistoryStorageError:
                record = WorkbookVersionRecord(**{**record.__dict__, "integrity": "corrupt"})
            versions.append(record)
        return versions

    def get_version(self, workbook_id: str, version_id: str) -> WorkbookVersionRecord:
        connection = connect(self.database_path)
        try:
            row = connection.execute(
                """
                SELECT version_id, workbook_id, source_revision, created_at, source_type,
                       label, snapshot_sha256, native_file_name
                FROM workbook_versions WHERE workbook_id = ? AND version_id = ?
                """,
                (workbook_id, version_id),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise VersionNotFoundError("version not found")
        record = self._to_version(row)
        document = self.history_storage.verify(record)
        return WorkbookVersionRecord(**{**record.__dict__, "snapshot": document["snapshot"]})

    def restore_version(
        self, workbook_id: str, version_id: str, expected_revision: int
    ) -> tuple[WorkbookRecord, WorkbookVersionRecord]:
        selected = self.get_version(workbook_id, version_id)
        if selected.snapshot is None:
            raise HistoryIntegrityError("history snapshot is unavailable")
        connection = connect(self.database_path)
        safety: WorkbookVersionRecord | None = None
        previous_native: bytes | None = None
        native_changed = False
        committed = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            current_row = connection.execute(
                "SELECT id, name, snapshot_json, revision, created_at, updated_at FROM workbooks WHERE id = ?",
                (workbook_id,),
            ).fetchone()
            if current_row is None:
                raise VersionNotFoundError("workbook not found")
            current = self._to_record(current_row)
            if current.revision != expected_revision:
                raise WorkbookConflictError(
                    f"stale revision {expected_revision}; current revision is {current.revision}"
                )
            self.native_storage.verify(current)
            # Re-verify after obtaining the SQLite write lock so a corrupt or
            # substituted file can never pass a stale preflight check.
            selected = self.get_version(workbook_id, version_id)
            safety = self._insert_version(connection, current, "pre_restore", "還原前備份")
            timestamp = self._now().isoformat()
            restored = WorkbookRecord(
                id=current.id,
                name=current.name,
                snapshot=selected.snapshot,
                revision=current.revision + 1,
                created_at=current.created_at,
                updated_at=datetime.fromisoformat(timestamp),
            )
            previous_native = self.native_storage.read_bytes(workbook_id)
            self.native_storage.write_record(restored)
            native_changed = True
            self.native_storage.verify(restored)
            snapshot_json = json.dumps(restored.snapshot, ensure_ascii=False, separators=(",", ":"))
            cursor = connection.execute(
                """
                UPDATE workbooks SET snapshot_json = ?, revision = ?, updated_at = ?
                WHERE id = ? AND revision = ?
                """,
                (snapshot_json, restored.revision, timestamp, workbook_id, current.revision),
            )
            if cursor.rowcount != 1:
                raise WorkbookConflictError("workbook changed during restore")
            self._commit(connection)
            committed = True
        except Exception:
            connection.rollback()
            if not committed and native_changed:
                self._restore_native(workbook_id, previous_native)
            if not committed and safety is not None:
                self.history_storage.remove(safety.workbook_id, safety.version_id)
            raise
        finally:
            connection.close()
        self.native_storage.verify(restored)
        return restored, safety

    def _create_automatic_if_due(
        self, connection: sqlite3.Connection, record: WorkbookRecord
    ) -> WorkbookVersionRecord | None:
        latest = connection.execute(
            """
            SELECT created_at, snapshot_sha256 FROM workbook_versions
            WHERE workbook_id = ? AND source_type = 'autosave'
            ORDER BY created_at DESC, version_id DESC LIMIT 1
            """,
            (record.id,),
        ).fetchone()
        if latest is not None:
            created = datetime.fromisoformat(str(latest["created_at"]))
            if self._now() - created < AUTOMATIC_VERSION_INTERVAL:
                return None
            digest = NativeWorkbookStorage.snapshot_sha256(record.snapshot)
            if str(latest["snapshot_sha256"]) == digest:
                return None
        try:
            return self._insert_version(connection, record, "autosave", None)
        except HistorySnapshotTooLargeError:
            # The current save remains valid; oversized history creates neither
            # a file nor false metadata. Manual creation reports the limit.
            return None

    def _insert_version(
        self,
        connection: sqlite3.Connection,
        workbook: WorkbookRecord,
        source_type: str,
        label: str | None,
    ) -> WorkbookVersionRecord:
        version_id = str(uuid.uuid4())
        created_at = self._now()
        record = WorkbookVersionRecord(
            version_id=version_id,
            workbook_id=workbook.id,
            source_revision=workbook.revision,
            created_at=created_at,
            source_type=source_type,
            label=label,
            snapshot_sha256=NativeWorkbookStorage.snapshot_sha256(workbook.snapshot),
            native_file_name=f"{version_id}.tws.json",
            snapshot=workbook.snapshot,
        )
        self.history_storage.create(record)
        try:
            connection.execute(
                """
                INSERT INTO workbook_versions (
                    version_id, workbook_id, source_revision, created_at, source_type,
                    label, snapshot_sha256, native_file_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (record.version_id, record.workbook_id, record.source_revision,
                 record.created_at.isoformat(), record.source_type, record.label,
                 record.snapshot_sha256, record.native_file_name),
            )
        except Exception:
            self.history_storage.remove(record.workbook_id, record.version_id)
            raise
        return record

    def _prune_automatic(self, workbook_id: str) -> None:
        connection = connect(self.database_path)
        try:
            rows = connection.execute(
                """
                SELECT version_id FROM workbook_versions
                WHERE workbook_id = ? AND source_type = 'autosave'
                ORDER BY created_at DESC, version_id DESC
                """,
                (workbook_id,),
            ).fetchall()
            for row in rows[AUTOMATIC_VERSION_RETENTION:]:
                version_id = str(row["version_id"])
                quarantine: Path | None = None
                committed = False
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    quarantine = self.history_storage.quarantine_version(workbook_id, version_id)
                    cursor = connection.execute(
                        "DELETE FROM workbook_versions WHERE version_id = ? AND workbook_id = ? AND source_type = 'autosave'",
                        (version_id, workbook_id),
                    )
                    if cursor.rowcount != 1:
                        raise sqlite3.DatabaseError("automatic history metadata was not pruned")
                    connection.commit()
                    committed = True
                except Exception:
                    connection.rollback()
                    if not committed:
                        self.history_storage.restore_version_quarantine(workbook_id, version_id, quarantine)
                    raise
                finally:
                    if committed:
                        self.history_storage.remove_version_quarantine(quarantine)
        finally:
            connection.close()

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

    @staticmethod
    def _to_version(row: Any) -> WorkbookVersionRecord:
        return WorkbookVersionRecord(
            version_id=str(row["version_id"]),
            workbook_id=str(row["workbook_id"]),
            source_revision=int(row["source_revision"]),
            created_at=datetime.fromisoformat(str(row["created_at"])),
            source_type=str(row["source_type"]),
            label=str(row["label"]) if row["label"] is not None else None,
            snapshot_sha256=str(row["snapshot_sha256"]),
            native_file_name=str(row["native_file_name"]),
        )
