# Phase 1E workbook and document management

Tiger Web Sheets manages multiple local documents stored as complete Univer snapshot JSON records in SQLite and mirrored into verified `.tws.json` files. A workbook is a Tiger-Web-Sheets document, not an Excel file.

## Workflow

The home screen lists committed workbooks in `updated_at` descending order. Each card shows the display name, modified time, and a short form of its stable ID, with **開啟**, **重新命名**, and **刪除** actions.

**新增活頁簿** uses an immediate-create model: after the user supplies a name, the backend commits a new UUID record at revision 1 with one blank worksheet. This avoids an ambiguous unsaved document identity. Duplicate display names are permitted because identity is ID-based.

Opening a card fetches that exact ID, destroys any prior Univer instance, deep-clones the committed snapshot, and creates a new Univer workbook. The clone matters because Univer owns and mutates its input; the API response must remain an immutable discard baseline.

Manual **儲存** sends the current ID, current complete snapshot, display name, and expected revision. The UI reports **已儲存** only after SQLite and the native mirror represent the same verified committed revision. HTTP 409 produces **儲存衝突** without overwriting the newer record.

**另存新檔** captures the current complete Univer snapshot and POSTs a separate document. The backend generates a new UUID, the original is not modified, and the new record becomes current. Subsequent saves address only the new ID.

**重新命名** PATCHes name metadata with revision protection. It does not rewrite the document ID, snapshot contents, or worksheet names. Rename is a committed metadata change and increments that record's revision.

**刪除** requires an explicit confirmation dialog stating that the action cannot be undone. Cancel sends no request. Confirm deletes only the selected ID; Phase 1E has no Trash.

## Dirty navigation

Persisted Univer mutations set **未儲存**. Returning to the list or selecting **新增活頁簿** then requires one choice:

- **儲存並繼續** waits for a successful committed save before navigation.
- **放棄變更** reconstructs the current document from its immutable committed snapshot when the New dialog remains in the editor, or disposes it when returning home.
- **取消** leaves the current workbook and its local changes untouched.

While dirty, a `beforeunload` handler protects refresh/close wherever the browser permits the native warning. No autosave was added.

## API and persistence

| Method | Route | Semantics |
| --- | --- | --- |
| GET | `/api/workbooks` | summaries ordered by updated time |
| POST | `/api/workbooks` | commit a new UUID record at revision 1 |
| GET | `/api/workbooks/{id}` | exact snapshot and revision |
| PUT | `/api/workbooks/{id}` | complete snapshot save with expected revision |
| PATCH | `/api/workbooks/{id}` | metadata-only rename with expected revision |
| DELETE | `/api/workbooks/{id}` | delete only the exact selected record |

The existing `workbooks` table remains unchanged. A legitimate legacy record with ID `default` is listed normally and is never migrated or removed automatically. Legacy PUT creation for `default` remains supported for Phase 1A–1D compatibility; other new records use POST-generated UUIDs.

## Isolation and validation

Backend tests cover empty/list/create/open/save/revision conflict/rename/delete, A/B/C snapshots, Save As identity, restart persistence, malformed requests, SQLite integrity, and the retained runtime-identity refusals.

The isolated browser runtime used explicit test-only ports, a database under `.cache`, runtime mode `isolated-test`, and nonce `phase1e-20261008-a1`. It verified:

- `客戶名單`, `商品庫存`, and `測試` restored distinct A1 values across repeated opens.
- `客戶名單-備份` had a different database ID; saving `COPY_CHANGED` did not change the original.
- metadata rename preserved `INVENTORY_B`.
- dirty Cancel retained local edits, Save-and-continue committed before returning home, and Discard reconstructed `TEST_C`.
- browser reload and an isolated backend process restart retained the list and exact contents.
- delete confirmation appeared, Cancel preserved the disposable record, and API deletion removed only that record.

The production/manual database was not used by any automated write.

## Boundaries

Phase 1E does not implement autosave, CSV, XLSX, OS file pickers, drag/drop, cloud sync, authentication, collaboration, version history, or Trash. SQLite snapshots and `.tws.json` mirrors are internal Tiger-Web-Sheets formats; no Excel compatibility is claimed.
