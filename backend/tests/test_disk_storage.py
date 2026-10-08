from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.database import connect, initialize_database
from app.main import create_app
from app.services.native_workbook_storage import (
    FORMAT,
    FORMAT_VERSION,
    NativeWorkbookError,
    NativeWorkbookPathError,
    NativeWorkbookStorage,
)


def create_payload(name: str, snapshot: dict) -> dict:
    return {"name": name, "snapshot": snapshot}


def save_payload(name: str, snapshot: dict, revision: int) -> dict:
    return {"name": name, "snapshot": snapshot, "expected_revision": revision}


def native_path(client: TestClient, workbook_id: str) -> Path:
    return client.app.state.workbook_store.native_storage.file_path(workbook_id)


def set_a1(snapshot: dict, value: str) -> dict:
    updated = deepcopy(snapshot)
    updated["sheets"][updated["sheetOrder"][0]]["cellData"]["0"]["0"] = {
        "v": value
    }
    return updated


def test_create_writes_complete_self_identifying_native_file(
    client: TestClient, workbook_snapshot: dict
) -> None:
    created = client.post(
        "/api/workbooks", json=create_payload("Native", workbook_snapshot)
    ).json()
    path = native_path(client, created["id"])
    document = json.loads(path.read_text(encoding="utf-8"))
    assert path.name == f"{created['id']}.tws.json"
    assert document["format"] == FORMAT
    assert document["format_version"] == FORMAT_VERSION
    assert document["workbook_id"] == created["id"]
    assert document["revision"] == 1
    assert document["snapshot"] == workbook_snapshot
    assert document["snapshot_sha256"] == NativeWorkbookStorage.snapshot_sha256(
        workbook_snapshot
    )
    assert not list(path.parent.glob("*.tmp"))
    storage = client.get(f"/api/workbooks/{created['id']}/storage")
    assert storage.status_code == 200
    assert storage.json() == {
        "disk_backed": True,
        "revision": 1,
        "snapshot_sha256": document["snapshot_sha256"],
        "integrity": "ok",
    }


def test_save_updates_native_revision_and_complete_snapshot(
    client: TestClient, workbook_snapshot: dict
) -> None:
    created = client.post(
        "/api/workbooks", json=create_payload("Save", workbook_snapshot)
    ).json()
    updated = set_a1(workbook_snapshot, "UPDATED")
    saved = client.put(
        f"/api/workbooks/{created['id']}",
        json=save_payload("Save", updated, 1),
    )
    assert saved.status_code == 200
    document = json.loads(native_path(client, created["id"]).read_text(encoding="utf-8"))
    assert document["revision"] == 2
    assert document["snapshot"] == updated
    assert document["snapshot_sha256"] == NativeWorkbookStorage.snapshot_sha256(updated)


def test_disk_write_failure_does_not_advance_sqlite(
    client: TestClient, workbook_snapshot: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = client.post(
        "/api/workbooks", json=create_payload("Failure", workbook_snapshot)
    ).json()
    path = native_path(client, created["id"])
    before_file = path.read_bytes()
    storage = client.app.state.workbook_store.native_storage
    original_write = storage.write_record

    def fail_write(*args, **kwargs):
        raise NativeWorkbookError("controlled disk failure")

    monkeypatch.setattr(storage, "write_record", fail_write)
    failed = client.put(
        f"/api/workbooks/{created['id']}",
        json=save_payload("Failure", set_a1(workbook_snapshot, "NO_COMMIT"), 1),
    )
    assert failed.status_code == 503
    monkeypatch.setattr(storage, "write_record", original_write)
    loaded = client.get(f"/api/workbooks/{created['id']}").json()
    assert loaded["revision"] == 1
    assert loaded["snapshot"] == workbook_snapshot
    assert path.read_bytes() == before_file


def test_database_commit_failure_restores_previous_native_file(
    client: TestClient, workbook_snapshot: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = client.post(
        "/api/workbooks", json=create_payload("Rollback", workbook_snapshot)
    ).json()
    store = client.app.state.workbook_store
    path = native_path(client, created["id"])
    before_file = path.read_bytes()
    original_commit = store._commit

    def fail_commit(*args, **kwargs):
        raise sqlite3.OperationalError("controlled commit failure")

    monkeypatch.setattr(store, "_commit", fail_commit)
    failed = client.put(
        f"/api/workbooks/{created['id']}",
        json=save_payload("Rollback", set_a1(workbook_snapshot, "ROLLBACK"), 1),
    )
    assert failed.status_code == 503
    monkeypatch.setattr(store, "_commit", original_commit)
    assert path.read_bytes() == before_file
    loaded = client.get(f"/api/workbooks/{created['id']}").json()
    assert loaded["revision"] == 1
    assert loaded["snapshot"] == workbook_snapshot


@pytest.mark.parametrize(
    ("mutation", "expected_detail"),
    [
        (lambda document: "{not valid json", "integrity"),
        (
            lambda document: {**document, "workbook_id": "wrong-id"},
            "integrity",
        ),
        (
            lambda document: {**document, "revision": document["revision"] + 1},
            "integrity",
        ),
    ],
)
def test_malformed_or_mismatched_native_file_is_rejected(
    client: TestClient,
    workbook_snapshot: dict,
    mutation,
    expected_detail: str,
) -> None:
    created = client.post(
        "/api/workbooks", json=create_payload("Corrupt", workbook_snapshot)
    ).json()
    path = native_path(client, created["id"])
    document = json.loads(path.read_text(encoding="utf-8"))
    mutated = mutation(document)
    if isinstance(mutated, str):
        path.write_text(mutated, encoding="utf-8")
    else:
        path.write_text(json.dumps(mutated), encoding="utf-8")
    response = client.get(f"/api/workbooks/{created['id']}/storage")
    assert response.status_code == 503
    assert expected_detail in response.json()["detail"]


def test_legacy_sqlite_only_record_is_migrated_idempotently(
    database_path: Path, workbook_root: Path, workbook_snapshot: dict
) -> None:
    initialize_database(database_path)
    timestamp = datetime.now(timezone.utc).isoformat()
    connection = connect(database_path)
    try:
        connection.execute(
            """
            INSERT INTO workbooks (
                id, name, snapshot_json, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "default",
                "Legacy",
                json.dumps(workbook_snapshot, ensure_ascii=False),
                4,
                timestamp,
                timestamp,
            ),
        )
        connection.commit()
    finally:
        connection.close()

    path = workbook_root / "default.tws.json"
    assert not path.exists()
    with TestClient(create_app(database_path, workbook_root)) as first:
        assert first.get("/api/workbooks/default").json()["revision"] == 4
        first_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    with TestClient(create_app(database_path, workbook_root)) as restarted:
        assert restarted.get("/api/workbooks/default/storage").json()["integrity"] == "ok"
        assert hashlib.sha256(path.read_bytes()).hexdigest() == first_hash


def test_unrelated_native_file_does_not_create_workbook(
    database_path: Path, workbook_root: Path
) -> None:
    workbook_root.mkdir(parents=True)
    (workbook_root / "unrelated.tws.json").write_text(
        json.dumps({"format": FORMAT, "format_version": FORMAT_VERSION}),
        encoding="utf-8",
    )
    with TestClient(create_app(database_path, workbook_root)) as test_client:
        assert test_client.get("/api/workbooks").json() == []


def test_corrupt_native_file_is_detected_during_backend_restart(
    database_path: Path, workbook_root: Path, workbook_snapshot: dict
) -> None:
    with TestClient(create_app(database_path, workbook_root)) as first:
        created = first.post(
            "/api/workbooks", json=create_payload("Restart corruption", workbook_snapshot)
        ).json()
    (workbook_root / f"{created['id']}.tws.json").write_text(
        "not-json", encoding="utf-8"
    )
    with pytest.raises(NativeWorkbookError):
        with TestClient(create_app(database_path, workbook_root)):
            pass


def test_multi_workbook_and_save_as_native_files_are_isolated(
    client: TestClient, workbook_snapshot: dict
) -> None:
    created = []
    for name, value in [
        ("客戶名單", "ORIGINAL"),
        ("庫存", "INVENTORY_B"),
        ("測試", "TEST_C"),
    ]:
        created.append(
            client.post(
                "/api/workbooks",
                json=create_payload(name, set_a1(workbook_snapshot, value)),
            ).json()
        )
    paths = {item["id"]: native_path(client, item["id"]) for item in created}
    hashes_before = {
        workbook_id: hashlib.sha256(path.read_bytes()).hexdigest()
        for workbook_id, path in paths.items()
    }

    original = created[0]
    copy = client.post(
        "/api/workbooks",
        json=create_payload("客戶名單-備份", original["snapshot"]),
    ).json()
    copy_path = native_path(client, copy["id"])
    assert copy["id"] != original["id"] and copy_path.exists()
    client.put(
        f"/api/workbooks/{copy['id']}",
        json=save_payload(
            copy["name"], set_a1(copy["snapshot"], "COPY_CHANGED"), 1
        ),
    )
    assert hashlib.sha256(paths[original["id"]].read_bytes()).hexdigest() == hashes_before[original["id"]]
    assert all(
        hashlib.sha256(paths[item["id"]].read_bytes()).hexdigest()
        == hashes_before[item["id"]]
        for item in created[1:]
    )
    assert client.get(f"/api/workbooks/{original['id']}").json()["snapshot"] == original["snapshot"]


def test_rename_keeps_file_identity_and_snapshot_hash(
    client: TestClient, workbook_snapshot: dict
) -> None:
    created = client.post(
        "/api/workbooks", json=create_payload("庫存", workbook_snapshot)
    ).json()
    path = native_path(client, created["id"])
    before = json.loads(path.read_text(encoding="utf-8"))
    renamed = client.patch(
        f"/api/workbooks/{created['id']}",
        json={"name": "商品庫存", "expected_revision": 1},
    )
    assert renamed.status_code == 200
    after = json.loads(path.read_text(encoding="utf-8"))
    assert path.name == f"{created['id']}.tws.json"
    assert after["workbook_id"] == before["workbook_id"]
    assert after["snapshot_sha256"] == before["snapshot_sha256"]
    assert after["snapshot"] == before["snapshot"]
    assert after["revision"] == 2


def test_delete_removes_only_target_native_file(
    client: TestClient, workbook_snapshot: dict
) -> None:
    records = [
        client.post(
            "/api/workbooks", json=create_payload(name, set_a1(workbook_snapshot, name))
        ).json()
        for name in ["A", "B", "C"]
    ]
    paths = [native_path(client, record["id"]) for record in records]
    hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    assert client.delete(f"/api/workbooks/{records[1]['id']}").status_code == 204
    assert not paths[1].exists()
    assert paths[0].exists() and paths[2].exists()
    assert hashlib.sha256(paths[0].read_bytes()).hexdigest() == hashes[0]
    assert hashlib.sha256(paths[2].read_bytes()).hexdigest() == hashes[2]


def test_workbook_id_cannot_escape_native_root(tmp_path: Path) -> None:
    storage = NativeWorkbookStorage(tmp_path / "workbooks")
    for workbook_id in ["../escape", "..", "C:/escape", "a/b", "\\server"]:
        with pytest.raises(NativeWorkbookPathError):
            storage.file_path(workbook_id)
