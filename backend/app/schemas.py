from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class HealthResponse(BaseModel):
    status: str
    database: str


class WorkbookWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    snapshot: dict[str, Any]
    expected_revision: int = Field(ge=0)

    @field_validator("snapshot")
    @classmethod
    def validate_snapshot(cls, snapshot: dict[str, Any]) -> dict[str, Any]:
        required = {"id", "name", "appVersion", "locale", "styles", "sheetOrder", "sheets"}
        missing = sorted(required.difference(snapshot))
        if missing:
            raise ValueError(f"snapshot is missing required fields: {', '.join(missing)}")

        if not isinstance(snapshot["styles"], dict):
            raise ValueError("snapshot.styles must be an object")
        if not isinstance(snapshot["sheets"], dict) or not snapshot["sheets"]:
            raise ValueError("snapshot.sheets must be a non-empty object")
        if not isinstance(snapshot["sheetOrder"], list) or not snapshot["sheetOrder"]:
            raise ValueError("snapshot.sheetOrder must be a non-empty array")
        if not all(isinstance(sheet_id, str) for sheet_id in snapshot["sheetOrder"]):
            raise ValueError("snapshot.sheetOrder must contain string IDs")

        unknown_sheet_ids = [
            sheet_id for sheet_id in snapshot["sheetOrder"] if sheet_id not in snapshot["sheets"]
        ]
        if unknown_sheet_ids:
            raise ValueError("snapshot.sheetOrder references missing worksheets")

        for sheet_id, sheet in snapshot["sheets"].items():
            if not isinstance(sheet, dict):
                raise ValueError(f"snapshot worksheet {sheet_id!r} must be an object")
            if sheet.get("id") != sheet_id or not isinstance(sheet.get("name"), str):
                raise ValueError(f"snapshot worksheet {sheet_id!r} has invalid identity")

        return snapshot


class WorkbookResponse(BaseModel):
    id: str
    name: str
    snapshot: dict[str, Any]
    revision: int
    updated_at: datetime
