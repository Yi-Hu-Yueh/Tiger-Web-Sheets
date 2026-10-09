from __future__ import annotations

import json
import sqlite3
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.database import connect
from app.main import create_app
from app.services.history_storage import HistoryStorage, HistoryStorageError


def _create(client: TestClient, name: str, snapshot: dict) -> dict:
    response = client.post("/api/workbooks", json={"name": name, "snapshot": snapshot})
    assert response.status_code == 201, response.text
    return response.json()


def test_phase1a_sqlite_only_upgrade_is_idempotent(
    database_path: Path, workbook_root: Path, workbook_snapshot: dict
) -> None:
    timestamp = "2026-01-01T00:00:00+00:00"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE workbooks (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, snapshot_json TEXT NOT NULL,
                revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)",
            ("legacy-phase1a", "Legacy", json.dumps(workbook_snapshot), 1, timestamp, timestamp),
        )

    history_root = workbook_root.parent / "history"
    with TestClient(create_app(database_path, workbook_root, history_root)) as client:
        loaded = client.get("/api/workbooks/legacy-phase1a")
        assert loaded.status_code == 200
        assert loaded.json()["snapshot"] == workbook_snapshot
        mirror = workbook_root / "legacy-phase1a.tws.json"
        first_bytes = mirror.read_bytes()
        assert client.get("/api/workbooks/legacy-phase1a/versions").json() == []

    with TestClient(create_app(database_path, workbook_root, history_root)) as client:
        assert client.get("/api/workbooks/legacy-phase1a").status_code == 200
        assert mirror.read_bytes() == first_bytes

    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbook_versions'"
        ).fetchone()


def test_cross_feature_save_version_restore_copy_and_integrity(
    client: TestClient, phase1c_formula_snapshot: dict
) -> None:
    snapshot = deepcopy(phase1c_formula_snapshot)
    sheet_id = snapshot["sheetOrder"][0]
    sheet = snapshot["sheets"][sheet_id]
    sheet["mergeData"] = [{"startRow": 8, "endRow": 8, "startColumn": 0, "endColumn": 1}]
    sheet["freeze"] = {"startRow": 1, "startColumn": 1, "xSplit": 1, "ySplit": 1}
    sheet["dataValidations"] = {
        "release-dropdown": {"type": "list", "formula1": '"台北,台中,高雄"'},
        "release-number": {"type": "whole", "operator": "between", "formula1": "1", "formula2": "10"},
    }
    sheet["conditionalFormatting"] = {
        "release-positive": {"type": "highlightCell", "operator": "greaterThan", "value": 0}
    }
    sheet.setdefault("cellData", {}).setdefault("9", {})["0"] = {"v": "00123", "t": 1}
    original = _create(client, "Release Matrix A", snapshot)
    named_response = client.post(
        f"/api/workbooks/{original['id']}/versions",
        json={"expected_revision": original["revision"], "label": "release-baseline"},
    )
    assert named_response.status_code == 201
    named = named_response.json()

    edited_snapshot = deepcopy(snapshot)
    edited_snapshot["sheets"][sheet_id]["cellData"]["9"]["0"] = {"v": "00999", "t": 1}
    saved = client.put(
        f"/api/workbooks/{original['id']}",
        json={"name": original["name"], "snapshot": edited_snapshot, "expected_revision": original["revision"]},
    ).json()
    restored_response = client.post(
        f"/api/workbooks/{original['id']}/versions/{named['version_id']}/restore",
        json={"expected_revision": saved["revision"]},
    )
    assert restored_response.status_code == 200, restored_response.text
    restored = restored_response.json()
    assert restored["workbook"]["revision"] == saved["revision"] + 1
    assert restored["workbook"]["snapshot"] == snapshot
    assert restored["safety_version"]["source_type"] == "pre_restore"

    copy = _create(client, "Release Matrix Copy", restored["workbook"]["snapshot"])
    assert copy["id"] != original["id"]
    assert copy["snapshot"] == snapshot
    source_ids = {item["version_id"] for item in client.get(f"/api/workbooks/{original['id']}/versions").json()}
    copy_ids = {item["version_id"] for item in client.get(f"/api/workbooks/{copy['id']}/versions").json()}
    assert named["version_id"] in source_ids
    assert source_ids.isdisjoint(copy_ids)

    database = client.app.state.database_path
    connection = connect(database)
    try:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute(
            """
            SELECT COUNT(*) FROM workbook_versions v
            LEFT JOIN workbooks w ON w.id = v.workbook_id WHERE w.id IS NULL
            """
        ).fetchone()[0] == 0
    finally:
        connection.close()


def test_automatic_history_write_failure_cannot_claim_a_new_save(
    client: TestClient, workbook_snapshot: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = client.app.state.workbook_store
    now = datetime(2026, 10, 9, tzinfo=timezone.utc)
    store._now = lambda: now
    original = _create(client, "Atomic failure", workbook_snapshot)
    native_before = store.native_storage.read_bytes(original["id"])
    now += timedelta(minutes=11)

    monkeypatch.setattr(
        store.history_storage,
        "create",
        lambda *_: (_ for _ in ()).throw(HistoryStorageError("controlled history failure")),
    )
    changed = deepcopy(workbook_snapshot)
    changed["name"] = "must-not-commit"
    response = client.put(
        f"/api/workbooks/{original['id']}",
        json={"name": original["name"], "snapshot": changed, "expected_revision": original["revision"]},
    )
    assert response.status_code == 503
    current = client.get(f"/api/workbooks/{original['id']}").json()
    assert current["revision"] == original["revision"]
    assert current["snapshot"] == original["snapshot"]
    assert store.native_storage.read_bytes(original["id"]) == native_before


def test_history_storage_refuses_path_traversal(tmp_path: Path) -> None:
    storage = HistoryStorage(tmp_path / "history")
    for workbook_id, version_id in [
        ("../owner", "safe"),
        ("safe", "../owner"),
        ("safe/child", "version"),
        ("safe", "version\\child"),
    ]:
        with pytest.raises(HistoryStorageError):
            storage.file_path(workbook_id, version_id)
