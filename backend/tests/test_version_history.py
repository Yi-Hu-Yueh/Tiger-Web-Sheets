from __future__ import annotations

import json
import sqlite3
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.history_storage import HistoryStorageError


def value(snapshot: dict, marker: str) -> dict:
    result = deepcopy(snapshot)
    result["sheets"]["sheet-01"].setdefault("cellData", {}).setdefault("0", {})["0"] = {"v": marker}
    return result


def create(client: TestClient, snapshot: dict, name: str = "History") -> dict:
    response = client.post("/api/workbooks", json={"name": name, "snapshot": snapshot})
    assert response.status_code == 201
    return response.json()


def manual(client: TestClient, record: dict, label: str | None = None) -> dict:
    response = client.post(
        f"/api/workbooks/{record['id']}/versions",
        json={"expected_revision": record["revision"], "label": label},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_manual_version_optional_label_listing_preview_and_immutable_file(client, workbook_snapshot):
    record = create(client, value(workbook_snapshot, "VERSION_1"))
    named = manual(client, record, "  第一版  ")
    unlabeled = manual(client, record)
    assert named["label"] == "第一版"
    assert unlabeled["label"] is None
    assert named["source_revision"] == 1
    assert named["worksheet_count"] == len(workbook_snapshot["sheetOrder"])
    assert named["worksheet_names"]
    assert named["integrity"] == "ok"
    listed = client.get(f"/api/workbooks/{record['id']}/versions").json()
    assert {item["version_id"] for item in listed} >= {named["version_id"], unlabeled["version_id"]}
    path = client.app.state.workbook_store.history_storage.file_path(record["id"], named["version_id"])
    before = path.read_bytes()
    assert manual(client, record, "第二份")["version_id"] != named["version_id"]
    assert path.read_bytes() == before


def test_automatic_coalescing_retention_and_manual_never_pruned(client, workbook_snapshot):
    store = client.app.state.workbook_store
    now = datetime(2026, 10, 9, tzinfo=timezone.utc)
    store._now = lambda: now
    record = create(client, value(workbook_snapshot, "AUTO-0"))
    keeper = manual(client, record, "保留")
    # Nine-minute save is committed but does not create a permanent auto version.
    now += timedelta(minutes=9)
    record = client.put(f"/api/workbooks/{record['id']}", json={"name": record["name"], "snapshot": value(workbook_snapshot, "AUTO-COALESCED"), "expected_revision": record["revision"]}).json()
    assert len([v for v in client.get(f"/api/workbooks/{record['id']}/versions").json() if v["source_type"] == "autosave"]) == 1
    for index in range(1, 24):
        now += timedelta(minutes=11)
        record = client.put(f"/api/workbooks/{record['id']}", json={"name": record["name"], "snapshot": value(workbook_snapshot, f"AUTO-{index}"), "expected_revision": record["revision"]}).json()
    listed = client.get(f"/api/workbooks/{record['id']}/versions").json()
    automatic = [item for item in listed if item["source_type"] == "autosave"]
    assert len(automatic) == 20
    assert any(item["version_id"] == keeper["version_id"] for item in listed)
    directory = store.history_storage.workbook_directory(record["id"])
    assert len(list(directory.glob("*.tws.json"))) == 21


def test_restore_advances_revision_creates_safety_and_survives_restart(database_path, workbook_root, workbook_snapshot):
    history_root = workbook_root.parent / "history"
    with TestClient(create_app(database_path, workbook_root, history_root)) as first:
        record = create(first, value(workbook_snapshot, "VERSION_1"))
        old = manual(first, record, "第一版")
        record = first.put(f"/api/workbooks/{record['id']}", json={"name": record["name"], "snapshot": value(workbook_snapshot, "CURRENT"), "expected_revision": 1}).json()
        response = first.post(f"/api/workbooks/{record['id']}/versions/{old['version_id']}/restore", json={"expected_revision": record["revision"]})
        assert response.status_code == 200, response.text
        restored = response.json()
        assert restored["workbook"]["revision"] == record["revision"] + 1
        assert restored["workbook"]["snapshot"]["sheets"]["sheet-01"]["cellData"]["0"]["0"]["v"] == "VERSION_1"
        assert restored["safety_version"]["source_type"] == "pre_restore"
        assert restored["safety_version"]["source_revision"] == record["revision"]
    with TestClient(create_app(database_path, workbook_root, history_root)) as restarted:
        loaded = restarted.get(f"/api/workbooks/{record['id']}").json()
        assert loaded["revision"] == record["revision"] + 1
        assert loaded["snapshot"]["sheets"]["sheet-01"]["cellData"]["0"]["0"]["v"] == "VERSION_1"
        assert any(v["source_type"] == "pre_restore" for v in restarted.get(f"/api/workbooks/{record['id']}/versions").json())


def test_workbook_isolation_save_as_rename_and_delete_cleanup(client, workbook_snapshot):
    first = create(client, value(workbook_snapshot, "VERSION_A"), "A")
    second = create(client, value(workbook_snapshot, "VERSION_B"), "B")
    a_version = manual(client, first, "A-only")
    b_version = manual(client, second, "B-only")
    assert a_version["version_id"] not in {v["version_id"] for v in client.get(f"/api/workbooks/{second['id']}/versions").json()}
    assert b_version["version_id"] not in {v["version_id"] for v in client.get(f"/api/workbooks/{first['id']}/versions").json()}
    copy = create(client, first["snapshot"], "A-copy")
    copy_versions = client.get(f"/api/workbooks/{copy['id']}/versions").json()
    assert all(v["version_id"] != a_version["version_id"] for v in copy_versions)
    renamed = client.patch(f"/api/workbooks/{first['id']}", json={"name": "A-renamed", "expected_revision": first["revision"]}).json()
    assert any(v["version_id"] == a_version["version_id"] for v in client.get(f"/api/workbooks/{renamed['id']}/versions").json())
    first_dir = client.app.state.workbook_store.history_storage.workbook_directory(first["id"])
    second_dir = client.app.state.workbook_store.history_storage.workbook_directory(second["id"])
    assert client.delete(f"/api/workbooks/{first['id']}").status_code == 204
    assert not first_dir.exists()
    assert second_dir.exists()
    assert client.get(f"/api/workbooks/{second['id']}/versions").status_code == 200


def test_corrupt_and_wrong_workbook_history_are_diagnostic_and_restore_refuses(client, workbook_snapshot):
    record = create(client, value(workbook_snapshot, "SAFE"))
    version = manual(client, record, "corrupt-me")
    storage = client.app.state.workbook_store.history_storage
    path = storage.file_path(record["id"], version["version_id"])
    document = json.loads(path.read_text(encoding="utf-8"))
    document["workbook_id"] = "wrong-workbook"
    path.write_text(json.dumps(document), encoding="utf-8")
    listed = client.get(f"/api/workbooks/{record['id']}/versions").json()
    assert next(v for v in listed if v["version_id"] == version["version_id"])["integrity"] == "corrupt"
    rejected = client.post(f"/api/workbooks/{record['id']}/versions/{version['version_id']}/restore", json={"expected_revision": record["revision"]})
    assert rejected.status_code == 422
    assert client.get(f"/api/workbooks/{record['id']}").json()["snapshot"] == record["snapshot"]


def test_history_disk_and_database_failures_leave_no_false_version(client, workbook_snapshot, monkeypatch):
    record = create(client, workbook_snapshot)
    store = client.app.state.workbook_store
    history_directory = store.history_storage.workbook_directory(record["id"])
    original_files = {path.name for path in history_directory.glob("*")}
    original_create = store.history_storage.create
    monkeypatch.setattr(store.history_storage, "create", lambda *_: (_ for _ in ()).throw(HistoryStorageError("disk full")))
    assert client.post(f"/api/workbooks/{record['id']}/versions", json={"expected_revision": 1, "label": "disk"}).status_code == 503
    monkeypatch.setattr(store.history_storage, "create", original_create)
    original_commit = store._commit
    monkeypatch.setattr(store, "_commit", lambda *_: (_ for _ in ()).throw(sqlite3.OperationalError("db fail")))
    assert client.post(f"/api/workbooks/{record['id']}/versions", json={"expected_revision": 1, "label": "db"}).status_code == 503
    monkeypatch.setattr(store, "_commit", original_commit)
    listed = client.get(f"/api/workbooks/{record['id']}/versions").json()
    assert all(v["label"] not in {"disk", "db"} for v in listed)
    assert {path.name for path in history_directory.glob("*")} == original_files


def test_restore_failure_preserves_current_and_does_not_claim_safety(client, workbook_snapshot, monkeypatch):
    record = create(client, value(workbook_snapshot, "OLD"))
    old = manual(client, record, "old")
    record = client.put(f"/api/workbooks/{record['id']}", json={"name": record["name"], "snapshot": value(workbook_snapshot, "CURRENT"), "expected_revision": 1}).json()
    store = client.app.state.workbook_store
    original_write = store.native_storage.write_record
    monkeypatch.setattr(store.native_storage, "write_record", lambda *_: (_ for _ in ()).throw(OSError("controlled restore failure")))
    response = client.post(f"/api/workbooks/{record['id']}/versions/{old['version_id']}/restore", json={"expected_revision": record["revision"]})
    monkeypatch.setattr(store.native_storage, "write_record", original_write)
    assert response.status_code == 503
    loaded = client.get(f"/api/workbooks/{record['id']}").json()
    assert loaded["revision"] == record["revision"]
    assert loaded["snapshot"]["sheets"]["sheet-01"]["cellData"]["0"]["0"]["v"] == "CURRENT"
    versions = client.get(f"/api/workbooks/{record['id']}/versions").json()
    assert not any(v["source_type"] == "pre_restore" for v in versions)
