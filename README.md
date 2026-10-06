# Tiger Web Sheets

Tiger Web Sheets is a browser spreadsheet feasibility project. Phase 0 proves that React, TypeScript, Vite, and the open-source Univer Sheets core can run together on this Windows machine with a Traditional Chinese interface.

## Phase 0 status

The frontend contains one editable workbook and one worksheet. Its initial cells are `A1 = 10`, `A2 = 20`, `A3 = =SUM(A1:A2)`, and `B1 = 台中公司`.

## Detected prerequisites and pinned versions

- Windows: Microsoft Windows NT 10.0.26100.9550 (24H2)
- Git: 2.55.0.windows.2
- Portable Node executable: `.tools\node-v24.19.0-win-x64\node.exe`
- Portable npm executable: `.tools\node-v24.19.0-win-x64\npm.cmd`
- Node: 24.19.0
- npm: 11.17.0
- React / React DOM: 19.3.0
- Vite: 8.3.3
- TypeScript: 6.0.3
- `@univerjs/presets`: 1.0.3
- `@univerjs/preset-sheets-core`: 1.0.3
- Locale: `zh-TW` (`LocaleType.ZH_TW`)
- Project npm cache: `.cache\npm`

The portable Node distribution is project-local and ignored by Git. No permanent system `PATH` change is required.

## Install

From the project root in Command Prompt or PowerShell:

```powershell
.\.tools\node-v24.19.0-win-x64\npm.cmd --prefix frontend install
```

## Start

The Windows helper temporarily prepends portable Node to `PATH` for its process only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_frontend.ps1
```

The direct npm workflow, which requires no PowerShell execution-policy change, is:

```powershell
cd frontend
$env:Path = "$(Resolve-Path ..\.tools\node-v24.19.0-win-x64);$env:Path"
..\.tools\node-v24.19.0-win-x64\npm.cmd run dev -- --host 127.0.0.1 --port 5173
```

Open <http://127.0.0.1:5173/> in desktop Chrome or Edge.

## Validation commands

Run from `frontend` after applying the same process-local `PATH` adjustment shown above:

```powershell
..\.tools\node-v24.19.0-win-x64\npm.cmd run lint
..\.tools\node-v24.19.0-win-x64\npm.cmd run build
```

## Phase 0 limitations

- Persistence is not implemented.
- CSV import/export is not implemented.
- XLSX import/export is not implemented.
- Autosave is not implemented.
- Collaboration, charts, authentication, backend APIs, and databases are not implemented.
- The workbook resets to the sample content whenever the page reloads.

