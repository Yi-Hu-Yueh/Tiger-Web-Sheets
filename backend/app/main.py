from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response, status

from app.database import connect, resolve_runtime_identity
from app.models import WorkbookRecord
from app.schemas import (
    HealthResponse,
    WorkbookCreateRequest,
    WorkbookRenameRequest,
    WorkbookResponse,
    WorkbookSummary,
    WorkbookStorageStatusResponse,
    WorkbookWriteRequest,
)
from app.services.native_workbook_storage import NativeWorkbookError
from app.services.workbook_store import WorkbookConflictError, WorkbookStore

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


def create_app(
    database_path: str | Path | None = None,
    workbook_root: str | Path | None = None,
) -> FastAPI:
    runtime_identity = resolve_runtime_identity(database_path, workbook_root)
    resolved_database_path = runtime_identity.database_path
    resolved_workbook_root = runtime_identity.workbook_root
    store = WorkbookStore(resolved_database_path, resolved_workbook_root)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        app.state.workbook_store = store
        app.state.database_path = resolved_database_path
        app.state.workbook_root = resolved_workbook_root
        yield

    application = FastAPI(title="Tiger Web Sheets API", version="1.0.0", lifespan=lifespan)

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
            database="sqlite",
            runtime_mode=runtime_identity.mode,
            database_path=str(runtime_identity.database_path),
            workbook_root=str(runtime_identity.workbook_root),
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
        except (sqlite3.Error, OSError, NativeWorkbookError, ValueError, TypeError) as error:
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
