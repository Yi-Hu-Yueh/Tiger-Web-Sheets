# Tiger Web Sheets V1 User Guide

Release: **1.0.0**. Owner V1 acceptance: **PASS**. This is the stable V1 release.

## Supported environment

Use desktop Google Chrome or Microsoft Edge on Windows. The File System Access API used by **開啟本機檔案**, **儲存**, CSV, and XLSX requires a supported desktop browser. Other browsers may still display the application but are not certified for native file workflows.

## Before first use

Keep these project directories together and back them up while Tiger is stopped:

- `data\` — SQLite metadata and authoritative current workbook state.
- `workbooks\` — verified managed `.tws.json` mirrors of current workbooks.
- `history\` — immutable version-history snapshots.

Restore the three directories as one consistent backup set. Do not use `.cache\` as a backup; it contains disposable tests, npm cache, and logs.

## Start

From a fresh Command Prompt or PowerShell in the project root:

```bat
scripts\start_tiger_web_sheets.cmd
```

The launcher uses the project portable Node.js and the configured Python environment only within its child processes. It does not permanently modify `PATH` or PowerShell policy. It verifies that ports `18085` and `5173` are free, starts the backend, confirms the manual database/workbook/history identity, then starts the frontend.

Open <http://127.0.0.1:5173/>. If a required port is occupied, Tiger reports the process ID and stops without terminating it. Close the other application or deliberately change the project configuration; never kill an unknown process merely to obtain the port.

Advanced troubleshooting can start the services separately, backend first:

```bat
scripts\start_backend.cmd
scripts\start_frontend.cmd
```

## Stop safely

Wait until the header says **已儲存**, then press `Ctrl+C` in both Tiger service windows or close those two windows. Closing the browser or backend cannot guarantee completion of an in-flight asynchronous save. If the workbook says **未儲存**, save first or leave the browser open long enough for the recovery checkpoint to complete.

After an unexpected browser/backend stop, restart Tiger normally and reopen the workbook. If Tiger detects a differing IndexedDB recovery checkpoint, it asks whether to restore it; recovery never silently replaces committed content.

## Normal workbook workflow

The home screen lists workbooks by name, modified time, and stable short ID. **新增活頁簿** creates a separate workbook. **重新命名** keeps identity/history. **另存新檔** creates a new workbook ID and independent current data; it does not copy full history or recovery state. **刪除** requires confirmation and removes only Tiger's managed record/mirror/history—an external user-selected file is not deleted.

The first **儲存** for an unbound workbook asks for a `.tws.json` destination. Later saves reuse that browser-held file handle when permission remains available. **已儲存** means SQLite, the managed mirror, and the bound external file have all verified. If external synchronization fails, Tiger reports the failure and keeps the internal committed recovery copy; it does not falsely show **已儲存**.

## Spreadsheet capabilities

V1 includes worksheets, values, formulas, basic formatting, number formats, merges, freeze panes, row/column operations, undo/redo, Safe Sort, Filter, Find/Replace, validation/dropdowns, and first-version conditional formatting. For identifiers such as `00123`, apply **代碼設為文字** before entry.

Safe Sort requires selection of the complete plain record rectangle including its header. Formula-containing sort rectangles are refused. Structural formula-reference rewriting after row/column insertion or deletion remains partial.

## Autosave and recovery

Autosave starts after the workbook has a bound external `.tws.json`, waits three seconds after the last real mutation, and uses the same verified save pipeline as manual Save. Permission failures pause automatic retries; click **儲存** to reauthorize. Browser-local recovery checkpoints are bounded temporary protection for dirty edits, not a substitute for Save or backups.

Do not assume a browser/process shutdown can finish an asynchronous save. The `beforeunload` warning is advisory and depends on browser behavior.

## Version history

**建立版本** creates an optional named permanent version. **版本紀錄** previews time, source revision, worksheet names/count, and populated cells. Restore validates the immutable history file, creates **還原前備份**, and commits the selected snapshot as a new higher revision.

Automatic history is limited to at most one version per ten minutes and retains the latest 20 automatic versions. Manual and pre-restore versions are not automatically pruned. Individual version deletion, visual diffs, branching, and cloud history are not included.

## CSV

CSV is a one-sheet value exchange. Import is UTF-8, previewed, limited to 5 MiB / 250,000 cells, and stores every field as text so `00123` and literal `=1+1` remain text. Export writes displayed values with UTF-8 BOM, CRLF records, and quoting. CSV does not preserve formulas, formatting, merges, rules, filters, or workbook metadata. CSV export does not alter Tiger save state.

## XLSX

XLSX import/export is a bounded compatibility baseline for multiple sheets, formulas with recalculation, leading-zero text, common number/date formats, basic styles, merges, dimensions, and warnings. It is not complete Excel fidelity. Validation and conditional-format rules are not certified for XLSX round-trip. Macros, unsafe external links/connections, oversized archives, and malformed packages are refused. `.tws.json` remains the authoritative native format.

## Failure guidance

- **無法連線至儲存服務**: confirm the backend window is running, then retry.
- **儲存衝突**: another/newer revision exists; Tiger refuses to overwrite it.
- **本機檔案需重新授權**: click **儲存** from a user gesture or use **另存新檔**.
- **同步失敗 / 本機檔案儲存失敗**: the internal recovery commit may exist, but the external file is not confirmed current; retry Save.
- **版本資料損毀**: restore is disabled; restore the complete `data\`, `workbooks\`, and `history\` backup set if needed.
- Corrupt CSV/XLSX/Tiger files are rejected without replacing the open workbook.

## V1 boundaries

No charts, pivot tables, printing, PDF export, authentication, collaboration, cloud deployment, AI features, visual version diffs, or complete Excel compatibility. Advanced validation/conditional-format options and formula structural rewrites are not certified. Tested large-workbook evidence is limited to representative 1,000×20 and 10,000×20 datasets; this is not an enterprise-scale performance claim.
