# Tiger Web Sheets

Tiger Web Sheets Phase 1A is a persistent browser spreadsheet vertical slice. It connects an editable open-source Univer workbook to a FastAPI API and a project-local SQLite database with explicit manual-save and optimistic-revision semantics.

## Architecture

- Frontend: React 19.3.0, TypeScript 6.0.3, Vite 8.3.3
- Spreadsheet: `@univerjs/presets` and `@univerjs/preset-sheets-core` 1.0.3
- Backend: FastAPI 0.128.2 on Python 3.11.3
- Storage: Python `sqlite3`, one canonical workbook with ID `default`
- Stored format: complete Tiger-Web-Sheets/Univer workbook snapshot JSON, not an XLSX file
- Frontend URL: <http://127.0.0.1:5173/>
- Backend health URL: <http://127.0.0.1:18085/api/health>
- SQLite file: `data\tiger_web_sheets.db`

Port 18083 was already occupied during implementation, so this project uses backend port 18085. Vite proxies `/api` to that port.

## Runtime prerequisites

- Portable Node: `.tools\node-v24.19.0-win-x64\node.exe` (v24.19.0)
- Portable npm: `.tools\node-v24.19.0-win-x64\npm.cmd` (11.17.0)
- Python: `D:\0TIGER\6months\PythonAPIDevelopment\venv_multi_query\Scripts\python.exe` (3.11.3)
- Project npm cache: `.cache\npm`

The required FastAPI, Uvicorn, Pydantic, HTTPX, and pytest versions were already present in the shared Python environment. No Python packages were installed or upgraded. Startup scripts alter `PATH` only inside their own process.

## Start both services

From a fresh Command Prompt or PowerShell at the project root:

```bat
scripts\start_dev.cmd
```

This starts separate backend and frontend command windows. Close those project windows or press `Ctrl+C` in each to stop the services.

To start services individually:

```bat
scripts\start_backend.cmd
scripts\start_frontend.cmd
```

The existing PowerShell frontend helper also remains available:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_frontend.ps1
```

No permanent `PATH` or PowerShell execution-policy change is required.

## Install frontend dependencies

Dependencies are locked. To restore them:

```powershell
.\.tools\node-v24.19.0-win-x64\npm.cmd --prefix frontend install
```

## Manual Save behavior

- `未儲存`: the fallback workbook has never been saved, or the workbook changed after its last committed save
- `儲存中`: a snapshot is being sent to FastAPI
- `已儲存`: SQLite committed the snapshot and returned the new revision
- `儲存失敗`: the API/database did not confirm a committed save; local edits remain available for retry
- `儲存衝突`: the browser revision is stale; the application does not overwrite the newer stored snapshot

On startup, a stored workbook is authoritative. The Phase 0 sample is used only when the API explicitly returns 404. If the backend is unavailable, the app shows a backend error instead of claiming that data is saved.

## API

- `GET /api/health`
- `GET /api/workbooks/default`
- `PUT /api/workbooks/default`

The PUT body contains the complete Univer snapshot and `expected_revision`. A new workbook starts at revision 1; committed updates increment it. A stale expected revision returns HTTP 409.

## Validation

Backend tests:

```powershell
cd backend
D:\0TIGER\6months\PythonAPIDevelopment\venv_multi_query\Scripts\python.exe -m pytest
```

Frontend checks:

```powershell
cd frontend
$env:Path = "$(Resolve-Path ..\.tools\node-v24.19.0-win-x64);$env:Path"
..\.tools\node-v24.19.0-win-x64\npm.cmd run lint
..\.tools\node-v24.19.0-win-x64\npm.cmd run build
```

## Phase 1A limitations

- Autosave is not implemented.
- A workbook/document manager is not implemented.
- Save As and document rename workflows are not implemented.
- CSV import/export is not implemented.
- XLSX import/export is not implemented.
- The stored file is Univer snapshot JSON in SQLite, not an XLSX workbook.
- Authentication, collaboration, charts, pivot tables, AI, and cloud deployment are not implemented.

