from __future__ import annotations

from copy import deepcopy
import sqlite3
from pathlib import Path

import pytest
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
    assert response.json() == {
        "status": "ok",
        "database": "sqlite",
        "runtime_mode": "manual",
        "database_path": str(client.app.state.database_path),
        "instance_nonce": None,
    }


def test_isolated_runtime_health_exposes_verified_identity(
    monkeypatch, database_path: Path
) -> None:
    monkeypatch.setenv("TIGER_WEB_SHEETS_RUNTIME", "isolated-test")
    monkeypatch.setenv("TIGER_WEB_SHEETS_INSTANCE_NONCE", "test-nonce")
    with TestClient(create_app(database_path)) as isolated_client:
        assert isolated_client.get("/api/health").json() == {
            "status": "ok",
            "database": "sqlite",
            "runtime_mode": "isolated-test",
            "database_path": str(database_path.resolve()),
            "instance_nonce": "test-nonce",
        }


def test_isolated_runtime_refuses_default_database(monkeypatch) -> None:
    monkeypatch.setenv("TIGER_WEB_SHEETS_RUNTIME", "isolated-test")
    monkeypatch.setenv("TIGER_WEB_SHEETS_INSTANCE_NONCE", "test-nonce")
    monkeypatch.delenv("TIGER_WEB_SHEETS_DB", raising=False)
    with pytest.raises(RuntimeError, match="explicit TIGER_WEB_SHEETS_DB"):
        create_app()


def test_isolated_runtime_refuses_production_database(monkeypatch) -> None:
    from app.database import DEFAULT_DATABASE_PATH

    monkeypatch.setenv("TIGER_WEB_SHEETS_RUNTIME", "isolated-test")
    monkeypatch.setenv("TIGER_WEB_SHEETS_INSTANCE_NONCE", "test-nonce")
    with pytest.raises(RuntimeError, match="refuses the production/manual database"):
        create_app(DEFAULT_DATABASE_PATH)


def test_isolated_runtime_requires_nonce(monkeypatch, database_path: Path) -> None:
    monkeypatch.setenv("TIGER_WEB_SHEETS_RUNTIME", "isolated-test")
    monkeypatch.delenv("TIGER_WEB_SHEETS_INSTANCE_NONCE", raising=False)
    with pytest.raises(RuntimeError, match="requires TIGER_WEB_SHEETS_INSTANCE_NONCE"):
        create_app(database_path)


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


def test_phase1b_snapshot_properties_round_trip(
    client: TestClient, phase1b_workbook_snapshot: dict
) -> None:
    saved = client.put(
        "/api/workbooks/default",
        json=save_payload(phase1b_workbook_snapshot),
    )
    assert saved.status_code == 200

    loaded = client.get("/api/workbooks/default")
    assert loaded.status_code == 200
    snapshot = loaded.json()["snapshot"]
    assert snapshot == phase1b_workbook_snapshot

    sheet = snapshot["sheets"]["sheet-01"]
    assert sheet["rowData"]["10"] == {"h": 40, "hd": 1}
    assert sheet["columnData"]["10"] == {"w": 161, "hd": 1}
    assert sheet["mergeData"][0] == {
        "startRow": 4,
        "endRow": 4,
        "startColumn": 6,
        "endColumn": 7,
    }
    assert sheet["freeze"] == {
        "xSplit": 1,
        "ySplit": 0,
        "startRow": -1,
        "startColumn": 1,
    }
    assert sheet["zoomRatio"] == 0.9
    assert [sheet["cellData"]["13"][str(column)]["v"] for column in range(4, 7)] == [
        "00123",
        "0912345678",
        "01234567",
    ]


def test_phase1c_formula_snapshot_round_trip(
    client: TestClient, phase1c_formula_snapshot: dict
) -> None:
    saved = client.put(
        "/api/workbooks/default",
        json=save_payload(phase1c_formula_snapshot),
    )
    assert saved.status_code == 200

    loaded = client.get("/api/workbooks/default")
    assert loaded.status_code == 200
    snapshot = loaded.json()["snapshot"]
    assert snapshot == phase1c_formula_snapshot
    assert snapshot["sheetOrder"] == [
        "formula-main",
        "data-sheet",
        "structural-sheet",
    ]

    main = snapshot["sheets"]["formula-main"]["cellData"]
    arithmetic_cases = [
        (main[str(row)]["3"]["f"], main[str(row)]["3"]["v"])
        for row in range(10)
    ]
    assert arithmetic_cases == [
        ("=1+2", 3),
        ("=10-3", 7),
        ("=4*5", 20),
        ("=20/4", 5),
        ("=2+3*4", 14),
        ("=(2+3)*4", 20),
        ("=A1+B1", 12),
        ("=A1-B1", 8),
        ("=A1*B1", 20),
        ("=A1/B1", 5),
    ]
    function_cases = [
        (main[str(row)]["4"]["f"], main[str(row)]["4"]["v"])
        for row in range(7)
    ]
    assert function_cases == [
        ("=SUM(A1:A5)", 60),
        ("=AVERAGE(A1:A5)", 20),
        ("=MIN(A1:A5)", 10),
        ("=MAX(A1:A5)", 30),
        ("=COUNT(A1:A5)", 3),
        ('=IF(A1>=10,"PASS","FAIL")', "PASS"),
        ('=IF(B1>=10,"PASS","FAIL")', "FAIL"),
    ]
    assert [main["1"][str(column)]["f"] for column in range(9, 13)] == [
        "=A2",
        "=$A$1",
        "=$A2",
        "=A$1",
    ]
    assert [main[str(row)]["10"]["f"] for row in range(3, 7)] == [
        "=B1",
        "=B$1",
        "=$A1",
        "=$A$1",
    ]
    assert (main["0"]["6"]["f"], main["0"]["6"]["v"]) == (
        "=資料表!A1",
        100,
    )
    assert (main["1"]["6"]["f"], main["1"]["6"]["v"]) == (
        "=SUM(資料表!A1:A3)",
        600,
    )
    assert (main["0"]["7"]["v"], main["1"]["7"]["v"]) == (
        "#DIV/0!",
        "#NAME?",
    )
    assert snapshot["sheets"]["structural-sheet"]["cellData"]["2"]["0"] == {
        "f": "=SUM(A1:A2)",
        "v": 30,
        "t": 2,
    }


def test_phase1d_data_operations_snapshot_round_trip(
    client: TestClient, phase1d_data_operations_snapshot: dict
) -> None:
    saved = client.put(
        "/api/workbooks/default",
        json=save_payload(phase1d_data_operations_snapshot),
    )
    assert saved.status_code == 200

    loaded = client.get("/api/workbooks/default")
    assert loaded.status_code == 200
    snapshot = loaded.json()["snapshot"]
    assert snapshot == phase1d_data_operations_snapshot

    rows = snapshot["sheets"]["data-operations"]["cellData"]
    expected_records = {
        "R001": ("李小華", "0922222222", 100, "台北", "=D3*0.95", 95),
        "R002": ("林小美", "0944444444", 200, "高雄", "=D5*0.95", 190),
        "R003": ("王小明", "0911111111", 300, "台中", "=D2*0.95", 285),
        "R004": ("陳大同", "0933333333", 400, "台中", "=D4*0.95", 380),
    }
    observed_records = {
        row["0"]["v"]: (
            row["1"]["v"],
            row["2"]["v"],
            row["3"]["v"],
            row["4"]["v"],
            row["5"]["f"],
            row["5"]["v"],
        )
        for row_index, row in rows.items()
        if row_index != "0"
    }
    assert observed_records == expected_records
    assert all(record[1].startswith("0") for record in observed_records.values())
    assert [rows[str(row)]["6"]["v"] for row in range(5)] == [
        "OLD_VALUE",
        "OLD_VALUE",
        "KEEP_VALUE",
        "UNRELATED",
        "CONTROL",
    ]
    assert snapshot["sheets"]["regression-sheet"]["cellData"]["0"]["0"] == {
        "v": "00123",
        "t": 1,
    }


def test_phase1d_safe_sort_survives_backend_restart(
    database_path: Path, phase1d_data_operations_snapshot: dict
) -> None:
    sorted_snapshot = deepcopy(phase1d_data_operations_snapshot)
    rows = sorted_snapshot["sheets"]["data-operations"]["cellData"]
    source_rows = {
        row["0"]["v"]: deepcopy(row)
        for row_index, row in rows.items()
        if row_index != "0"
    }
    expected_tuples = [
        ["R001", "李小華", "0922222222", 100, "台北"],
        ["R002", "林小美", "0944444444", 200, "高雄"],
        ["R003", "王小明", "0911111111", 300, "台中"],
        ["R004", "陳大同", "0933333333", 400, "台中"],
    ]

    for destination_row, expected in enumerate(expected_tuples, start=1):
        source = source_rows[expected[0]]
        for column in range(5):
            rows[str(destination_row)][str(column)] = source[str(column)]

    with TestClient(create_app(database_path)) as first_runtime:
        saved = first_runtime.put(
            "/api/workbooks/default",
            json=save_payload(sorted_snapshot),
        )
        assert saved.status_code == 200
        assert saved.json()["revision"] == 1

    with TestClient(create_app(database_path)) as restarted_runtime:
        loaded = restarted_runtime.get("/api/workbooks/default")
        assert loaded.status_code == 200
        persisted_rows = loaded.json()["snapshot"]["sheets"]["data-operations"][
            "cellData"
        ]
        assert [
            [persisted_rows[str(row)][str(column)]["v"] for column in range(5)]
            for row in range(1, 5)
        ] == expected_tuples
        assert [persisted_rows["0"][str(column)]["v"] for column in range(5)] == [
            "ID",
            "姓名",
            "電話",
            "金額",
            "城市",
        ]

    connection = sqlite3.connect(database_path)
    try:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    finally:
        connection.close()
