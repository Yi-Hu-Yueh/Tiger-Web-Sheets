from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.workbook_store import WorkbookStore


def save_payload(snapshot: dict, expected_revision: int = 0) -> dict:
    return {
        "name": "Tiger Web Sheets",
        "snapshot": snapshot,
        "expected_revision": expected_revision,
    }


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "sqlite"}


def test_first_save_creates_and_loads_workbook(client: TestClient, workbook_snapshot: dict) -> None:
    assert client.get("/api/workbooks/default").status_code == 404
    created = client.put("/api/workbooks/default", json=save_payload(workbook_snapshot))
    assert created.status_code == 200
    assert created.json()["revision"] == 1
    loaded = client.get("/api/workbooks/default")
    assert loaded.status_code == 200
    assert loaded.json()["snapshot"] == workbook_snapshot


def test_revision_increments_and_stale_revision_conflicts(
    client: TestClient, workbook_snapshot: dict
) -> None:
    first = client.put("/api/workbooks/default", json=save_payload(workbook_snapshot))
    assert first.json()["revision"] == 1
    updated_snapshot = dict(workbook_snapshot)
    updated_snapshot["name"] = "Updated workbook"
    second = client.put(
        "/api/workbooks/default", json=save_payload(updated_snapshot, expected_revision=1)
    )
    assert second.status_code == 200
    assert second.json()["revision"] == 2
    stale = client.put(
        "/api/workbooks/default", json=save_payload(workbook_snapshot, expected_revision=1)
    )
    assert stale.status_code == 409
    assert client.get("/api/workbooks/default").json()["revision"] == 2


def test_persistence_survives_new_connection_and_application_instance(
    database_path: Path, workbook_snapshot: dict
) -> None:
    with TestClient(create_app(database_path)) as first_client:
        created = first_client.put(
            "/api/workbooks/default", json=save_payload(workbook_snapshot)
        )
        assert created.status_code == 200
    with TestClient(create_app(database_path)) as restarted_client:
        loaded = restarted_client.get("/api/workbooks/default")
        assert loaded.status_code == 200
        assert loaded.json()["revision"] == 1
        assert loaded.json()["snapshot"] == workbook_snapshot


def test_initialization_does_not_destroy_existing_data(
    database_path: Path, workbook_snapshot: dict
) -> None:
    store = WorkbookStore(database_path)
    store.initialize()
    store.put("default", "Tiger Web Sheets", workbook_snapshot, expected_revision=0)
    store.initialize()
    store.initialize()
    loaded = store.get("default")
    assert loaded is not None
    assert loaded.revision == 1
    assert loaded.snapshot == workbook_snapshot


def test_malformed_request_is_rejected(client: TestClient) -> None:
    response = client.put(
        "/api/workbooks/default",
        json={"name": "Broken", "snapshot": {"id": "incomplete"}, "expected_revision": 0},
    )
    assert response.status_code == 422


def test_unknown_workbook_id_is_rejected(client: TestClient, workbook_snapshot: dict) -> None:
    response = client.put("/api/workbooks/other", json=save_payload(workbook_snapshot))
    assert response.status_code == 404


def test_database_failure_returns_503_without_claiming_success(
    client: TestClient, workbook_snapshot: dict
) -> None:
    class FailingStore:
        def put(self, *args, **kwargs):
            raise sqlite3.OperationalError("controlled test failure")

    original_store = client.app.state.workbook_store
    client.app.state.workbook_store = FailingStore()
    try:
        response = client.put("/api/workbooks/default", json=save_payload(workbook_snapshot))
    finally:
        client.app.state.workbook_store = original_store
    assert response.status_code == 503


def test_sqlite_integrity_check(
    client: TestClient, database_path: Path, workbook_snapshot: dict
) -> None:
    assert client.put(
        "/api/workbooks/default", json=save_payload(workbook_snapshot)
    ).status_code == 200
    connection = sqlite3.connect(database_path)
    try:
        result = connection.execute("PRAGMA integrity_check").fetchone()
    finally:
        connection.close()
    assert result == ("ok",)
