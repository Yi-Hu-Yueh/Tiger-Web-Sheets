from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class WorkbookRecord:
    id: str
    name: str
    snapshot: dict[str, Any]
    revision: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class WorkbookVersionRecord:
    version_id: str
    workbook_id: str
    source_revision: int
    created_at: datetime
    source_type: str
    label: str | None
    snapshot_sha256: str
    native_file_name: str
    snapshot: dict[str, Any] | None = None
    integrity: str = "ok"
