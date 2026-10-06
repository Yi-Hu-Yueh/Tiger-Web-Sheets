# Tiger Web Sheets

Tiger Web Sheets Phase 1C is a persistent browser spreadsheet vertical slice. It connects an editable open-source Univer workbook to a FastAPI API and a project-local SQLite database with explicit manual-save and optimistic-revision semantics, while using Univer's native open-source spreadsheet operations, formatting UI, and formula engine.

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

## Phase 1B spreadsheet operations

The installed Univer 1.0.3 open-source presets provide the grid, clipboard, native undo/redo stack, row and column context menus, worksheet tabs, freeze controls, zoom, cell formatting, merge/unmerge, and number formats. Tiger Web Sheets persists their workbook snapshot state without adding parallel spreadsheet implementations.

Verified native operations include:

- rectangular multi-cell copy/paste, native context-menu cut/paste, and external text paste; Ctrl+C and Ctrl+V were verified, while synthetic Ctrl+X could not be exercised by the in-app browser automation
- Delete clears cell contents while retaining cell formatting; cell editing and keyboard navigation were verified with Enter, Escape, arrow keys, Tab, and Shift+Tab
- Undo with Ctrl+Z and Redo with the toolbar; Ctrl+Y did not redo in the tested environment, so use the toolbar Redo command
- insert, delete, hide/unhide, and resize rows and columns
- add, switch, rename, and delete worksheets; worksheet deletion participates in Univer's native undo/redo stack
- freeze top row, freeze first column, and remove freeze
- zoom in, zoom out, and reset to 100%; zoom is stored per worksheet in the workbook snapshot
- font family, font size, bold, text color, fill, borders, horizontal/vertical alignment, and wrapping
- merge/unmerge
- number, percentage, date, Taiwan-dollar currency, and text formats

For identifiers that must retain a leading zero, select the cells and apply the native **Text / 文字** number format before entering or pasting the values. This was verified with `00123`, `0912345678`, and `01234567`; the saved cell values remain strings after reload and backend restart.

Phase 1B operations that mutate persisted workbook state change the header status to `未儲存`. A successful manual save returns it through `儲存中` to `已儲存`. Values, formulas, worksheets, dimensions, hidden state, formatting, merges, freeze state, zoom, number formats, and leading-zero text are stored inside the complete Univer snapshot.

## Phase 1C formula compatibility baseline

The installed Univer 1.0.3 open-source formula engine is verified for basic arithmetic, `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `IF`, relative/absolute/mixed/range references, same-sheet and cross-sheet references, native fill adjustment, direct and cross-sheet recalculation, formula error values, save/reload, and backend-restart persistence.

The detailed compatibility evidence, exact observed formula strings, limitations, isolated database location, and 45-step owner test are recorded in [docs/PHASE1C_FORMULA_MATRIX.md](docs/PHASE1C_FORMULA_MATRIX.md). The reusable workbook snapshot is [backend/tests/fixtures/phase1c_formula_cases.json](backend/tests/fixtures/phase1c_formula_cases.json).

Structural insert/delete reference rewriting remains a documented partial edge case, and ordinary desktop copy-reference adjustment remains an owner runtime checkpoint. These limitations do not replace the verified formula results with compatibility claims that were not observed.

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

## Phase 1B limitations

- Autosave is not implemented.
- A workbook/document manager is not implemented.
- Save As and document rename workflows are not implemented.
- Sort, filter, find, and replace are not implemented in this phase.
- CSV import/export is not implemented.
- XLSX import/export is not implemented.
- The stored file is Univer snapshot JSON in SQLite, not an XLSX workbook.
- Conditional formatting, data validation, charts, pivot tables, printing, PDF export, and version history are not implemented.
- Authentication, collaboration, AI, and cloud deployment are not implemented.
- Excel compatibility is not claimed beyond the behavior explicitly tested with Univer 1.0.3.

