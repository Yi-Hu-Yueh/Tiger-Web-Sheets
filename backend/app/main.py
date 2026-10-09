from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response, status

from app.database import connect, resolve_runtime_identity
from app.models import WorkbookRecord, WorkbookVersionRecord
from app.schemas import (
    HealthResponse,
    NativeWorkbookDocument,
    NativeWorkbookImportRequest,
    WorkbookCreateRequest,
    WorkbookRenameRequest,
    WorkbookResponse,
    WorkbookSummary,
    WorkbookStorageStatusResponse,
    WorkbookWriteRequest,
    WorkbookRestoreResponse,
    WorkbookVersionCreateRequest,
    WorkbookVersionRestoreRequest,
    WorkbookVersionResponse,
)
from app.services.history_storage import HistoryIntegrityError, HistorySnapshotTooLargeError, HistoryStorageError
from app.services.native_workbook_storage import NativeWorkbookError
from app.services.workbook_store import (
    NativeWorkbookCollisionError,
    WorkbookConflictError,
    WorkbookStore,
    VersionNotFoundError,
)
from app.version import PRODUCT_VERSION

CANONICAL_WORKBOOK_ID = "default"


def _response(record: WorkbookRecord) -> WorkbookResponse:
    return WorkbookResponse(
        id=record.id,
        name=record.name,
        snapshot=record.snapshot,
        revision=record.revision,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _summary(record: WorkbookRecord) -> WorkbookSummary:
    return WorkbookSummary(
        id=record.id,
        name=record.name,
        revision=record.revision,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _version_response(record: WorkbookVersionRecord) -> WorkbookVersionResponse:
    snapshot = record.snapshot or {}
    sheets = snapshot.get("sheets") if isinstance(snapshot, dict) else None
    order = snapshot.get("sheetOrder") if isinstance(snapshot, dict) else None
    worksheet_names: list[str] = []
    populated = 0
    if isinstance(sheets, dict) and isinstance(order, list):
        for sheet_id in order:
            sheet = sheets.get(sheet_id)
            if not isinstance(sheet, dict):
                continue
            worksheet_names.append(str(sheet.get("name", sheet_id)))
            cell_data = sheet.get("cellData", {})
            if isinstance(cell_data, dict):
                populated += sum(len(row) for row in cell_data.values() if isinstance(row, dict))
    return WorkbookVersionResponse(
        version_id=record.version_id,
        workbook_id=record.workbook_id,
        source_revision=record.source_revision,
        created_at=record.created_at,
        source_type=record.source_type,  # type: ignore[arg-type]
        label=record.label,
        snapshot_sha256=record.snapshot_sha256,
        worksheet_count=len(worksheet_names),
        worksheet_names=worksheet_names,
        populated_cell_count=populated,
        integrity="corrupt" if record.integrity == "corrupt" else "ok",
    )


def create_app(
    database_path: str | Path | None = None,
    workbook_root: str | Path | None = None,
    history_root: str | Path | None = None,
) -> FastAPI:
    runtime_identity = resolve_runtime_identity(database_path, workbook_root, history_root)
    resolved_database_path = runtime_identity.database_path
    resolved_workbook_root = runtime_identity.workbook_root
    resolved_history_root = runtime_identity.history_root
    store = WorkbookStore(resolved_database_path, resolved_workbook_root, resolved_history_root)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        app.state.workbook_store = store
        app.state.database_path = resolved_database_path
        app.state.workbook_root = resolved_workbook_root
        app.state.history_root = resolved_history_root
        yield

    application = FastAPI(title="Tiger Web Sheets API", version=PRODUCT_VERSION, lifespan=lifespan)

    @application.get("/api/health", response_model=HealthResponse)
    def health(request: Request) -> HealthResponse:
        try:
            connection = connect(request.app.state.database_path)
            try:
                connection.execute("SELECT 1").fetchone()
            finally:
                connection.close()
        except sqlite3.Error as error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="database unavailable",
            ) from error
        return HealthResponse(
            status="ok",
            product_version=PRODUCT_VERSION,
            database="sqlite",
            runtime_mode=runtime_identity.mode,
            database_path=str(runtime_identity.database_path),
            workbook_root=str(runtime_identity.workbook_root),
            history_root=str(runtime_identity.history_root),
            instance_nonce=runtime_identity.instance_nonce,
        )

    @application.get("/api/workbooks", response_model=list[WorkbookSummary])
    def list_workbooks(request: Request) -> list[WorkbookSummary]:
        try:
            return [_summary(record) for record in request.app.state.workbook_store.list()]
        except (sqlite3.Error, NativeWorkbookError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="database unavailable") from error

    @application.post(
        "/api/workbooks", response_model=WorkbookResponse, status_code=status.HTTP_201_CREATED
    )
    def create_workbook(
        payload: WorkbookCreateRequest, request: Request
    ) -> WorkbookResponse:
        try:
            record = request.app.state.workbook_store.create(payload.name, payload.snapshot)
        except (sqlite3.Error, OSError, NativeWorkbookError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="create failed") from error
        return _response(record)

    @application.post(
        "/api/native-files/import",
        response_model=WorkbookResponse,
        status_code=status.HTTP_201_CREATED,
    )
    def import_native_workbook(
        payload: NativeWorkbookImportRequest, request: Request
    ) -> WorkbookResponse:
        try:
            record = request.app.state.workbook_store.import_native(
                payload.name,
                payload.document.model_dump(mode="json"),
            )
        except NativeWorkbookCollisionError as error:
            raise HTTPException(status_code=409, detail="native workbook identity collision") from error
        except NativeWorkbookError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except (sqlite3.Error, OSError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="native workbook import failed") from error
        return _response(record)

    @application.get("/api/workbooks/{workbook_id}", response_model=WorkbookResponse)
    def get_workbook(workbook_id: str, request: Request) -> WorkbookResponse:
        try:
            record = request.app.state.workbook_store.get(workbook_id)
        except (sqlite3.Error, NativeWorkbookError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="database unavailable") from error
        if record is None:
            raise HTTPException(status_code=404, detail="workbook not found")
        return _response(record)

    @application.put("/api/workbooks/{workbook_id}", response_model=WorkbookResponse)
    def put_workbook(
        workbook_id: str,
        payload: WorkbookWriteRequest,
        request: Request,
    ) -> WorkbookResponse:
        try:
            if workbook_id != CANONICAL_WORKBOOK_ID and request.app.state.workbook_store.get(workbook_id) is None:
                raise HTTPException(status_code=404, detail="workbook not found")
            record = request.app.state.workbook_store.put(
                workbook_id=workbook_id,
                name=payload.name,
                snapshot=payload.snapshot,
                expected_revision=payload.expected_revision,
            )
        except WorkbookConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (sqlite3.Error, OSError, NativeWorkbookError, HistoryStorageError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="save failed") from error
        return _response(record)

    @application.get(
        "/api/workbooks/{workbook_id}/storage",
        response_model=WorkbookStorageStatusResponse,
    )
    def workbook_storage_status(
        workbook_id: str, request: Request
    ) -> WorkbookStorageStatusResponse:
        try:
            storage = request.app.state.workbook_store.storage_status(workbook_id)
        except (sqlite3.Error, OSError, NativeWorkbookError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="native workbook integrity failure") from error
        if storage is None or storage.revision is None or storage.snapshot_sha256 is None:
            raise HTTPException(status_code=404, detail="workbook not found")
        return WorkbookStorageStatusResponse(
            disk_backed=storage.exists,
            revision=storage.revision,
            snapshot_sha256=storage.snapshot_sha256,
            integrity=storage.integrity,
        )

    @application.get(
        "/api/workbooks/{workbook_id}/native",
        response_model=NativeWorkbookDocument,
    )
    def workbook_native_document(
        workbook_id: str, request: Request
    ) -> NativeWorkbookDocument:
        try:
            document = request.app.state.workbook_store.native_document(workbook_id)
        except (sqlite3.Error, OSError, NativeWorkbookError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="native workbook unavailable") from error
        if document is None:
            raise HTTPException(status_code=404, detail="workbook not found")
        return NativeWorkbookDocument.model_validate(document)

    @application.patch("/api/workbooks/{workbook_id}", response_model=WorkbookResponse)
    def rename_workbook(
        workbook_id: str, payload: WorkbookRenameRequest, request: Request
    ) -> WorkbookResponse:
        try:
            record = request.app.state.workbook_store.rename(
                workbook_id, payload.name, payload.expected_revision
            )
        except WorkbookConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (sqlite3.Error, OSError, NativeWorkbookError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="rename failed") from error
        if record is None:
            raise HTTPException(status_code=404, detail="workbook not found")
        return _response(record)

    @application.get(
        "/api/workbooks/{workbook_id}/versions",
        response_model=list[WorkbookVersionResponse],
    )
    def list_workbook_versions(
        workbook_id: str, request: Request
    ) -> list[WorkbookVersionResponse]:
        try:
            return [_version_response(item) for item in request.app.state.workbook_store.list_versions(workbook_id)]
        except VersionNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (sqlite3.Error, OSError, HistoryStorageError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="version history unavailable") from error

    @application.post(
        "/api/workbooks/{workbook_id}/versions",
        response_model=WorkbookVersionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    def create_workbook_version(
        workbook_id: str, payload: WorkbookVersionCreateRequest, request: Request
    ) -> WorkbookVersionResponse:
        try:
            version = request.app.state.workbook_store.create_version(
                workbook_id, payload.expected_revision, payload.label
            )
        except VersionNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except WorkbookConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except HistorySnapshotTooLargeError as error:
            raise HTTPException(status_code=413, detail=str(error)) from error
        except (sqlite3.Error, OSError, NativeWorkbookError, HistoryStorageError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="version creation failed") from error
        return _version_response(version)

    @application.post(
        "/api/workbooks/{workbook_id}/versions/{version_id}/restore",
        response_model=WorkbookRestoreResponse,
    )
    def restore_workbook_version(
        workbook_id: str,
        version_id: str,
        payload: WorkbookVersionRestoreRequest,
        request: Request,
    ) -> WorkbookRestoreResponse:
        try:
            record, safety = request.app.state.workbook_store.restore_version(
                workbook_id, version_id, payload.expected_revision
            )
        except VersionNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except WorkbookConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except HistoryIntegrityError as error:
            raise HTTPException(status_code=422, detail="版本資料損毀") from error
        except (sqlite3.Error, OSError, NativeWorkbookError, HistoryStorageError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="version restore failed") from error
        return WorkbookRestoreResponse(
            workbook=_response(record), safety_version=_version_response(safety)
        )

    @application.delete(
        "/api/workbooks/{workbook_id}", status_code=status.HTTP_204_NO_CONTENT
    )
    def delete_workbook(workbook_id: str, request: Request) -> Response:
        try:
            deleted = request.app.state.workbook_store.delete(workbook_id)
        except (sqlite3.Error, OSError, NativeWorkbookError) as error:
            raise HTTPException(status_code=503, detail="delete failed") from error
        if not deleted:
            raise HTTPException(status_code=404, detail="workbook not found")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return application


app = create_app()
