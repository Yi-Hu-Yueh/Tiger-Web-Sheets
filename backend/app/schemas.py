from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class HealthResponse(BaseModel):
    status: str
    product_version: str
    database: str
    runtime_mode: str
    database_path: str
    workbook_root: str
    history_root: str
    instance_nonce: str | None = None


class WorkbookStorageStatusResponse(BaseModel):
    disk_backed: bool
    revision: int
    snapshot_sha256: str
    integrity: str


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


class WorkbookCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    snapshot: dict[str, Any]

    _validate_snapshot = field_validator("snapshot")(WorkbookWriteRequest.validate_snapshot.__func__)


class NativeWorkbookDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["tiger-web-sheets"]
    format_version: Literal[1]
    workbook_id: str = Field(min_length=1, max_length=128)
    revision: int = Field(ge=1)
    saved_at: datetime
    snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    snapshot: dict[str, Any]

    _validate_snapshot = field_validator("snapshot")(WorkbookWriteRequest.validate_snapshot.__func__)


class NativeWorkbookImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    document: NativeWorkbookDocument


class WorkbookRenameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    expected_revision: int = Field(ge=1)


class WorkbookSummary(BaseModel):
    id: str
    name: str
    revision: int
    created_at: datetime
    updated_at: datetime


class WorkbookResponse(BaseModel):
    id: str
    name: str
    snapshot: dict[str, Any]
    revision: int
    created_at: datetime
    updated_at: datetime


VersionSource = Literal["manual", "autosave", "pre_restore", "restore"]


class WorkbookVersionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1)
    label: str | None = Field(default=None, max_length=200)

    @field_validator("label")
    @classmethod
    def normalize_label(cls, label: str | None) -> str | None:
        if label is None:
            return None
        normalized = label.strip()
        return normalized or None


class WorkbookVersionRestoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1)


class WorkbookVersionResponse(BaseModel):
    version_id: str
    workbook_id: str
    source_revision: int
    created_at: datetime
    source_type: VersionSource
    label: str | None
    snapshot_sha256: str
    worksheet_count: int
    worksheet_names: list[str]
    populated_cell_count: int
    integrity: Literal["ok", "corrupt"]


class WorkbookRestoreResponse(BaseModel):
    workbook: WorkbookResponse
    safety_version: WorkbookVersionResponse
