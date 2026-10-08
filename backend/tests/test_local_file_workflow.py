from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.services.native_workbook_storage import NativeWorkbookStorage


def native_document(workbook_id: str, revision: int, snapshot: dict) -> dict:
    return {
        "format": "tiger-web-sheets",
        "format_version": 1,
        "workbook_id": workbook_id,
        "revision": revision,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "snapshot_sha256": NativeWorkbookStorage.snapshot_sha256(snapshot),
        "snapshot": snapshot,
    }


def test_native_document_endpoint_returns_r1_compatible_schema(
    client: TestClient, workbook_snapshot: dict
) -> None:
    created = client.post(
        "/api/workbooks", json={"name": "Local", "snapshot": workbook_snapshot}
    ).json()
    response = client.get(f"/api/workbooks/{created['id']}/native")
    assert response.status_code == 200
    document = response.json()
    assert document["format"] == "tiger-web-sheets"
    assert document["format_version"] == 1
    assert document["workbook_id"] == created["id"]
    assert document["revision"] == created["revision"]
    assert document["snapshot"] == workbook_snapshot
    assert document["snapshot_sha256"] == NativeWorkbookStorage.snapshot_sha256(
        workbook_snapshot
    )


def test_open_valid_native_file_registers_exact_identity_and_revision(
    client: TestClient, workbook_snapshot: dict
) -> None:
    document = native_document("local-file-id", 7, workbook_snapshot)
    response = client.post(
        "/api/native-files/import",
        json={"name": "客戶名單", "document": document},
    )
    assert response.status_code == 201
    imported = response.json()
    assert imported["id"] == "local-file-id"
    assert imported["revision"] == 7
    assert imported["snapshot"] == workbook_snapshot
    assert client.get("/api/workbooks/local-file-id/native").json()["snapshot_sha256"] == document["snapshot_sha256"]


def test_open_malformed_wrong_format_version_and_hash_are_rejected(
    client: TestClient, workbook_snapshot: dict
) -> None:
    valid = native_document("bad-file", 1, workbook_snapshot)
    wrong_format = deepcopy(valid)
    wrong_format["format"] = "not-tiger"
    wrong_version = deepcopy(valid)
    wrong_version["format_version"] = 99
    wrong_hash = deepcopy(valid)
    wrong_hash["snapshot_sha256"] = "0" * 64

    assert client.post(
        "/api/native-files/import", json={"name": "Bad", "document": wrong_format}
    ).status_code == 422
    assert client.post(
        "/api/native-files/import", json={"name": "Bad", "document": wrong_version}
    ).status_code == 422
    response = client.post(
        "/api/native-files/import", json={"name": "Bad", "document": wrong_hash}
    )
    assert response.status_code == 400
    assert "hash" in response.json()["detail"]


def test_matching_identity_opens_normally_but_different_content_collides(
    client: TestClient, workbook_snapshot: dict
) -> None:
    created = client.post(
        "/api/workbooks", json={"name": "Original", "snapshot": workbook_snapshot}
    ).json()
    document = client.get(f"/api/workbooks/{created['id']}/native").json()

    matching = client.post(
        "/api/native-files/import",
        json={"name": "Different display name", "document": document},
    )
    assert matching.status_code == 201
    assert matching.json()["name"] == "Original"
    assert matching.json()["revision"] == 1

    changed_snapshot = deepcopy(workbook_snapshot)
    changed_snapshot["sheets"]["sheet-01"]["cellData"] = {
        "0": {"0": {"v": "COLLISION"}}
    }
    conflicting = native_document(created["id"], created["revision"], changed_snapshot)
    collision = client.post(
        "/api/native-files/import",
        json={"name": "Collision", "document": conflicting},
    )
    assert collision.status_code == 409
    loaded = client.get(f"/api/workbooks/{created['id']}").json()
    assert loaded["name"] == "Original"
    assert loaded["snapshot"] == workbook_snapshot


def test_internal_delete_never_removes_external_user_file(
    client: TestClient, workbook_snapshot: dict, tmp_path: Path
) -> None:
    created = client.post(
        "/api/workbooks", json={"name": "Delete", "snapshot": workbook_snapshot}
    ).json()
    document = client.get(f"/api/workbooks/{created['id']}/native").json()
    external = tmp_path / "owner-selected.tws.json"
    external.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")

    assert client.delete(f"/api/workbooks/{created['id']}").status_code == 204
    assert external.exists()
    assert json.loads(external.read_text(encoding="utf-8"))["workbook_id"] == created["id"]
