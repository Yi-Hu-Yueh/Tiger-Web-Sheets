from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "test_tiger_web_sheets.db"


@pytest.fixture
def client(database_path: Path):
    with TestClient(create_app(database_path)) as test_client:
        yield test_client


@pytest.fixture
def workbook_snapshot() -> dict:
    fixture_path = Path(__file__).parent / "fixtures" / "phase1a_workbook.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))
