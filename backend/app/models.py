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
