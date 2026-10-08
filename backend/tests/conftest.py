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
def workbook_root(tmp_path: Path) -> Path:
    return tmp_path / "workbooks"


@pytest.fixture
def client(database_path: Path, workbook_root: Path):
    with TestClient(create_app(database_path, workbook_root)) as test_client:
        yield test_client


@pytest.fixture
def workbook_snapshot() -> dict:
    fixture_path = Path(__file__).parent / "fixtures" / "phase1a_workbook.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))


@pytest.fixture
def phase1b_workbook_snapshot() -> dict:
    fixture_path = Path(__file__).parent / "fixtures" / "phase1b_workbook.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))


@pytest.fixture
def phase1c_formula_snapshot() -> dict:
    fixture_path = Path(__file__).parent / "fixtures" / "phase1c_formula_cases.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))


@pytest.fixture
def phase1d_data_operations_snapshot() -> dict:
    fixture_path = Path(__file__).parent / "fixtures" / "phase1d_data_operations.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))
