from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, status

from app.database import connect, resolve_database_path
from app.models import WorkbookRecord
from app.schemas import HealthResponse, WorkbookResponse, WorkbookWriteRequest
from app.services.workbook_store import WorkbookConflictError, WorkbookStore

CANONICAL_WORKBOOK_ID = "default"


def _response(record: WorkbookRecord) -> WorkbookResponse:
    return WorkbookResponse(
        id=record.id,
        name=record.name,
        snapshot=record.snapshot,
        revision=record.revision,
        updated_at=record.updated_at,
    )


def create_app(database_path: str | Path | None = None) -> FastAPI:
    resolved_database_path = resolve_database_path(database_path)
    store = WorkbookStore(resolved_database_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        app.state.workbook_store = store
        app.state.database_path = resolved_database_path
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
        return HealthResponse(status="ok", database="sqlite")

    @application.get("/api/workbooks/{workbook_id}", response_model=WorkbookResponse)
    def get_workbook(workbook_id: str, request: Request) -> WorkbookResponse:
        if workbook_id != CANONICAL_WORKBOOK_ID:
            raise HTTPException(status_code=404, detail="workbook not found")
        try:
            record = request.app.state.workbook_store.get(workbook_id)
        except (sqlite3.Error, ValueError, TypeError) as error:
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
        if workbook_id != CANONICAL_WORKBOOK_ID:
            raise HTTPException(status_code=404, detail="workbook not found")
        try:
            record = request.app.state.workbook_store.put(
                workbook_id=workbook_id,
                name=payload.name,
                snapshot=payload.snapshot,
                expected_revision=payload.expected_revision,
            )
        except WorkbookConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (sqlite3.Error, OSError, ValueError, TypeError) as error:
            raise HTTPException(status_code=503, detail="save failed") from error
        return _response(record)

    return application


app = create_app()
