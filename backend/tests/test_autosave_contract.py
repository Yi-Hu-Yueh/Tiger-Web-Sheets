"""Autosave deliberately uses the SAME optimistic native-save API as manual Save."""
from copy import deepcopy
import json
import sqlite3

import pytest

from app.services.native_workbook_storage import NativeWorkbookError


def edited(snapshot, marker):
    value = deepcopy(snapshot)
    value["sheets"][value["sheetOrder"][0]]["cellData"]["0"]["0"] = {"v": marker}
    return value


def payload(snapshot, revision):
    return {"name": "Autosave contract", "snapshot": snapshot, "expected_revision": revision}


def test_revision_eight_cannot_overwrite_nine_or_another_workbook(client, workbook_snapshot):
    first = client.post("/api/workbooks", json={"name": "Autosave A", "snapshot": workbook_snapshot}).json()
    second = client.post("/api/workbooks", json={"name": "Autosave B", "snapshot": workbook_snapshot}).json()
    url = f"/api/workbooks/{first['id']}"
    for revision in range(1, 9):
        latest = edited(workbook_snapshot, f"LATEST-{revision + 1}")
        response = client.put(url, json=payload(latest, revision))
        assert response.status_code == 200
        assert response.json()["revision"] == revision + 1
    storage = client.app.state.workbook_store.native_storage
    path = storage.file_path(first["id"])
    before = path.read_bytes()
    stale = client.put(url, json=payload(edited(workbook_snapshot, "STALE-8"), 8))
    assert stale.status_code == 409
    loaded = client.get(url).json()
    assert loaded["revision"] == 9
    assert loaded["snapshot"] == latest
    assert path.read_bytes() == before
    assert json.loads(before)["snapshot"] == latest
    assert client.get(f"/api/workbooks/{second['id']}").json() == second


@pytest.mark.parametrize("failure", ["sqlite", "managed-file"])
def test_autosave_failure_preserves_both_targets_and_retry_uses_same_revision(
    client, workbook_snapshot, monkeypatch, failure
):
    record = client.post("/api/workbooks", json={"name": "Autosave retry", "snapshot": workbook_snapshot}).json()
    store = client.app.state.workbook_store
    path = store.native_storage.file_path(record["id"])
    original = path.read_bytes()
    pending = edited(workbook_snapshot, "UNSAVED-BUT-RETAINED")
    url = f"/api/workbooks/{record['id']}"

    def refuse(*args, **kwargs):
        if failure == "sqlite":
            raise sqlite3.OperationalError("controlled autosave SQLite failure")
        raise NativeWorkbookError("controlled autosave managed-file failure")

    with monkeypatch.context() as patch:
        patch.setattr(store if failure == "sqlite" else store.native_storage,
                      "_commit" if failure == "sqlite" else "write_record", refuse)
        assert client.put(url, json=payload(pending, 1)).status_code == 503
    assert path.read_bytes() == original
    assert client.get(url).json()["snapshot"] == workbook_snapshot
    retried = client.put(url, json=payload(pending, 1))
    assert retried.status_code == 200
    assert retried.json()["revision"] == 2
    assert retried.json()["snapshot"] == pending
    assert json.loads(path.read_text(encoding="utf-8"))["snapshot"] == pending
