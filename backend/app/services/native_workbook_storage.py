from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from app.models import WorkbookRecord

FORMAT = "tiger-web-sheets"
FORMAT_VERSION = 1
SAFE_WORKBOOK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class NativeWorkbookError(Exception):
    """Raised when a native workbook mirror cannot be written or verified."""


class NativeWorkbookPathError(NativeWorkbookError):
    """Raised when a workbook identity is unsafe for native storage."""


class NativeWorkbookIntegrityError(NativeWorkbookError):
    """Raised when a native workbook mirror disagrees with SQLite."""


@dataclass(frozen=True)
class NativeWorkbookStatus:
    exists: bool
    revision: int | None
    snapshot_sha256: str | None
    integrity: str


class NativeWorkbookStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    @staticmethod
    def snapshot_sha256(snapshot: dict[str, Any]) -> str:
        canonical = json.dumps(
            snapshot,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()

    def file_path(self, workbook_id: str) -> Path:
        if not SAFE_WORKBOOK_ID.fullmatch(workbook_id) or ".." in workbook_id:
            raise NativeWorkbookPathError("unsafe workbook ID for native storage")
        candidate = (self.root / f"{workbook_id}.tws.json").resolve()
        if candidate.parent != self.root:
            raise NativeWorkbookPathError("native workbook path escaped its storage root")
        return candidate

    def encode(self, record: WorkbookRecord) -> bytes:
        document = self.document(record)
        return (
            json.dumps(
                document,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")

    def document(self, record: WorkbookRecord) -> dict[str, Any]:
        return {
            "format": FORMAT,
            "format_version": FORMAT_VERSION,
            "workbook_id": record.id,
            "revision": record.revision,
            "saved_at": record.updated_at.isoformat(),
            "snapshot_sha256": self.snapshot_sha256(record.snapshot),
            "snapshot": record.snapshot,
        }

    def record_from_document(
        self, document: dict[str, Any], name: str
    ) -> WorkbookRecord:
        if document.get("format") != FORMAT or document.get("format_version") != FORMAT_VERSION:
            raise NativeWorkbookIntegrityError("native workbook format is unsupported")
        workbook_id = document.get("workbook_id")
        revision = document.get("revision")
        saved_at = document.get("saved_at")
        snapshot = document.get("snapshot")
        if not isinstance(workbook_id, str):
            raise NativeWorkbookIntegrityError("native workbook ID is invalid")
        self.file_path(workbook_id)
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise NativeWorkbookIntegrityError("native workbook revision is invalid")
        if not isinstance(saved_at, str):
            raise NativeWorkbookIntegrityError("native workbook saved time is invalid")
        try:
            timestamp = datetime.fromisoformat(saved_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise NativeWorkbookIntegrityError("native workbook saved time is invalid") from error
        if timestamp.tzinfo is None:
            raise NativeWorkbookIntegrityError("native workbook saved time must include a timezone")
        if not isinstance(snapshot, dict):
            raise NativeWorkbookIntegrityError("native workbook snapshot is invalid")
        expected_hash = self.snapshot_sha256(snapshot)
        if document.get("snapshot_sha256") != expected_hash:
            raise NativeWorkbookIntegrityError("native workbook snapshot hash is invalid")
        return WorkbookRecord(
            id=workbook_id,
            name=name,
            snapshot=snapshot,
            revision=revision,
            created_at=timestamp,
            updated_at=timestamp,
        )

    def write_record(self, record: WorkbookRecord) -> None:
        self._atomic_write(self.file_path(record.id), self.encode(record))

    def restore_bytes(self, workbook_id: str, previous: bytes | None) -> None:
        path = self.file_path(workbook_id)
        if previous is None:
            path.unlink(missing_ok=True)
            return
        self._atomic_write(path, previous)

    def read_bytes(self, workbook_id: str) -> bytes | None:
        path = self.file_path(workbook_id)
        return path.read_bytes() if path.exists() else None

    def verify(self, record: WorkbookRecord) -> NativeWorkbookStatus:
        path = self.file_path(record.id)
        if not path.exists():
            raise NativeWorkbookIntegrityError("native workbook file is missing")
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise NativeWorkbookIntegrityError("native workbook file is malformed") from error
        if not isinstance(document, dict):
            raise NativeWorkbookIntegrityError("native workbook file must contain an object")
        decoded = self.record_from_document(document, record.name)
        if decoded.id != record.id:
            raise NativeWorkbookIntegrityError("native workbook ID does not match SQLite")
        if decoded.revision != record.revision:
            raise NativeWorkbookIntegrityError("native workbook revision does not match SQLite")
        expected_hash = self.snapshot_sha256(record.snapshot)
        if decoded.snapshot != record.snapshot:
            raise NativeWorkbookIntegrityError("native workbook snapshot does not match SQLite")
        return NativeWorkbookStatus(True, record.revision, expected_hash, "ok")

    def verified_document(self, record: WorkbookRecord) -> dict[str, Any]:
        self.verify(record)
        document = json.loads(self.file_path(record.id).read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            raise NativeWorkbookIntegrityError("native workbook file must contain an object")
        return document

    def quarantine(self, workbook_id: str) -> Path | None:
        path = self.file_path(workbook_id)
        if not path.exists():
            return None
        self.root.mkdir(parents=True, exist_ok=True)
        quarantine = self.root / f".{workbook_id}.{os.getpid()}.delete.bak"
        os.replace(path, quarantine)
        self._fsync_directory()
        return quarantine

    def restore_quarantine(self, workbook_id: str, quarantine: Path | None) -> None:
        if quarantine is None or not quarantine.exists():
            return
        os.replace(quarantine, self.file_path(workbook_id))
        self._fsync_directory()

    @staticmethod
    def remove_quarantine(quarantine: Path | None) -> None:
        if quarantine is not None:
            try:
                quarantine.unlink(missing_ok=True)
            except OSError:
                # The active managed .tws.json is already gone and SQLite is
                # committed. A locked quarantine is an inert cleanup orphan.
                pass

    def _atomic_write(self, destination: Path, content: bytes) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{destination.stem}.",
                suffix=".tmp",
                dir=self.root,
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(content)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, destination)
            temporary_path = None
            self._fsync_directory()
        except OSError as error:
            raise NativeWorkbookError("native workbook file write failed") from error
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def _fsync_directory(self) -> None:
        try:
            descriptor = os.open(self.root, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        except OSError:
            pass
        finally:
            os.close(descriptor)
