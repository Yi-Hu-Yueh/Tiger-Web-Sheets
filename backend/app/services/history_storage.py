from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from app.models import WorkbookVersionRecord
from app.services.native_workbook_storage import NativeWorkbookStorage

FORMAT = "tiger-web-sheets-history"
FORMAT_VERSION = 1
MAX_HISTORY_SNAPSHOT_BYTES = 16 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class HistoryStorageError(Exception):
    """History could not be stored or verified."""


class HistoryIntegrityError(HistoryStorageError):
    """History metadata and its immutable file disagree."""


class HistorySnapshotTooLargeError(HistoryStorageError):
    """A history snapshot exceeds the bounded storage limit."""


class HistoryStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    @staticmethod
    def _safe(value: str, kind: str) -> None:
        if not SAFE_ID.fullmatch(value) or ".." in value:
            raise HistoryStorageError(f"unsafe {kind} for history storage")

    def workbook_directory(self, workbook_id: str) -> Path:
        self._safe(workbook_id, "workbook ID")
        candidate = (self.root / workbook_id).resolve()
        if candidate.parent != self.root:
            raise HistoryStorageError("history path escaped its storage root")
        return candidate

    def file_path(self, workbook_id: str, version_id: str) -> Path:
        self._safe(version_id, "version ID")
        directory = self.workbook_directory(workbook_id)
        candidate = (directory / f"{version_id}.tws.json").resolve()
        if candidate.parent != directory:
            raise HistoryStorageError("history file escaped its workbook directory")
        return candidate

    def document(self, record: WorkbookVersionRecord) -> dict[str, Any]:
        if record.snapshot is None:
            raise HistoryStorageError("history snapshot is unavailable")
        return {
            "format": FORMAT,
            "format_version": FORMAT_VERSION,
            "version_id": record.version_id,
            "workbook_id": record.workbook_id,
            "source_revision": record.source_revision,
            "created_at": record.created_at.isoformat(),
            "source_type": record.source_type,
            "label": record.label,
            "snapshot_sha256": record.snapshot_sha256,
            "snapshot": record.snapshot,
        }

    def encode(self, record: WorkbookVersionRecord) -> bytes:
        content = (json.dumps(self.document(record), ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        snapshot_bytes = len(json.dumps(record.snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        if snapshot_bytes > MAX_HISTORY_SNAPSHOT_BYTES:
            raise HistorySnapshotTooLargeError("history snapshot exceeds 16 MiB")
        return content

    def create(self, record: WorkbookVersionRecord) -> Path:
        destination = self.file_path(record.workbook_id, record.version_id)
        if destination.exists():
            raise HistoryStorageError("history version already exists")
        directory = destination.parent
        directory.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{record.version_id}.", suffix=".tmp", dir=directory, delete=False) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(self.encode(record))
                temporary.flush()
                os.fsync(temporary.fileno())
            if destination.exists():
                raise HistoryStorageError("history version already exists")
            os.replace(temporary_path, destination)
            temporary_path = None
            self._fsync(directory)
            self.verify(record)
            return destination
        except HistoryStorageError:
            raise
        except OSError as error:
            raise HistoryStorageError("history file write failed") from error
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def verify(self, record: WorkbookVersionRecord) -> dict[str, Any]:
        path = self.file_path(record.workbook_id, record.version_id)
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise HistoryIntegrityError("history file is missing or malformed") from error
        if not isinstance(document, dict) or document.get("format") != FORMAT or document.get("format_version") != FORMAT_VERSION:
            raise HistoryIntegrityError("history format is unsupported")
        expected = {
            "version_id": record.version_id,
            "workbook_id": record.workbook_id,
            "source_revision": record.source_revision,
            "source_type": record.source_type,
            "label": record.label,
            "snapshot_sha256": record.snapshot_sha256,
            "created_at": record.created_at.isoformat(),
        }
        if any(document.get(key) != value for key, value in expected.items()):
            raise HistoryIntegrityError("history identity or metadata mismatch")
        snapshot = document.get("snapshot")
        if not isinstance(document.get("created_at"), str):
            raise HistoryIntegrityError("history creation time is invalid")
        try:
            if datetime.fromisoformat(document["created_at"].replace("Z", "+00:00")).tzinfo is None:
                raise ValueError
        except ValueError as error:
            raise HistoryIntegrityError("history creation time is invalid") from error
        if record.native_file_name != f"{record.version_id}.tws.json":
            raise HistoryIntegrityError("history filename metadata is invalid")
        if not self._valid_snapshot(snapshot) or NativeWorkbookStorage.snapshot_sha256(snapshot) != record.snapshot_sha256:
            raise HistoryIntegrityError("history snapshot hash is invalid")
        if record.snapshot is not None and snapshot != record.snapshot:
            raise HistoryIntegrityError("history snapshot does not match expected content")
        return document

    @staticmethod
    def _valid_snapshot(snapshot: object) -> bool:
        if not isinstance(snapshot, dict):
            return False
        required = {"id", "name", "appVersion", "locale", "styles", "sheetOrder", "sheets"}
        if not required.issubset(snapshot) or not isinstance(snapshot["styles"], dict) or not isinstance(snapshot["sheets"], dict) or not snapshot["sheets"]:
            return False
        order = snapshot["sheetOrder"]
        return isinstance(order, list) and bool(order) and all(isinstance(sheet_id, str) and sheet_id in snapshot["sheets"] and isinstance(snapshot["sheets"][sheet_id], dict) and snapshot["sheets"][sheet_id].get("id") == sheet_id and isinstance(snapshot["sheets"][sheet_id].get("name"), str) for sheet_id in order)

    def remove(self, workbook_id: str, version_id: str) -> None:
        self.file_path(workbook_id, version_id).unlink(missing_ok=True)

    def quarantine_version(self, workbook_id: str, version_id: str) -> Path | None:
        path = self.file_path(workbook_id, version_id)
        if not path.exists():
            return None
        quarantine = path.parent / f".{version_id}.{os.getpid()}.prune.bak"
        os.replace(path, quarantine)
        self._fsync(path.parent)
        return quarantine

    def restore_version_quarantine(self, workbook_id: str, version_id: str, quarantine: Path | None) -> None:
        if quarantine is not None and quarantine.exists():
            os.replace(quarantine, self.file_path(workbook_id, version_id))
            self._fsync(quarantine.parent)

    @staticmethod
    def remove_version_quarantine(quarantine: Path | None) -> None:
        if quarantine is not None:
            try:
                quarantine.unlink(missing_ok=True)
            except OSError:
                pass

    def quarantine_workbook(self, workbook_id: str) -> Path | None:
        directory = self.workbook_directory(workbook_id)
        if not directory.exists():
            return None
        quarantine = self.root / f".{workbook_id}.{os.getpid()}.delete.bak"
        os.replace(directory, quarantine)
        self._fsync(self.root)
        return quarantine

    def restore_quarantine(self, workbook_id: str, quarantine: Path | None) -> None:
        if quarantine is not None and quarantine.exists():
            os.replace(quarantine, self.workbook_directory(workbook_id))
            self._fsync(self.root)

    @staticmethod
    def remove_quarantine(quarantine: Path | None) -> None:
        if quarantine is None or not quarantine.exists():
            return
        try:
            for path in quarantine.iterdir():
                if path.is_file():
                    path.unlink()
            quarantine.rmdir()
        except OSError:
            # Active metadata/current workbook are already deleted. A locked
            # quarantine is inert and cannot be listed or restored.
            pass

    @staticmethod
    def _fsync(directory: Path) -> None:
        try:
            descriptor = os.open(directory, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        except OSError:
            pass
        finally:
            os.close(descriptor)
