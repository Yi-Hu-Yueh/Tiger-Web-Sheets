# Phase 1E-R1 native disk storage

Tiger Web Sheets stores every committed workbook in two coordinated forms:

- SQLite remains the transactional source of truth for workbook identity, display name, revision, timestamps, optimistic concurrency, and the complete snapshot.
- `workbooks\<workbook-id>.tws.json` is the verified durable native-file mirror of that committed snapshot.

The native format belongs to Tiger Web Sheets. It is not XLSX and does not imply Microsoft Excel compatibility.

## Storage roots and identity

Normal runtime uses the absolute project directory `D:\0TIGER\6months\PythonAPIDevelopment\Tiger-Web-Sheets\workbooks`. `TIGER_WEB_SHEETS_WORKBOOK_ROOT` can configure another root. The fail-closed isolated launcher requires an explicit root under `.cache`, exports it to both backend and frontend identity checks, and refuses the normal workbook directory.

Physical identity is the validated workbook ID: `<workbook-id>.tws.json`. Names are never used in paths, so duplicates, Windows-invalid filename characters, and rename do not affect physical identity. IDs containing traversal, separators, absolute paths, or unsafe characters are rejected.

Actual `.tws.json`, temporary, and backup files are ignored by Git. `workbooks/.gitkeep` preserves the empty durable directory.

## Native document format

Each UTF-8 JSON object contains:

```json
{
  "format": "tiger-web-sheets",
  "format_version": 1,
  "workbook_id": "stable-id",
  "revision": 1,
  "saved_at": "ISO-8601 timestamp",
  "snapshot_sha256": "canonical snapshot SHA-256",
  "snapshot": {}
}
```

`snapshot` is the complete persisted Univer snapshot. Formulas, styles, worksheets, row/column metadata, merges, freeze state, resources, and every other snapshot-supported property remain together. Hashing uses deterministic UTF-8 JSON with sorted keys and compact separators.

## Commit protocol

Create, Save, and Rename hold SQLite's immediate write transaction while preparing the next revision:

1. Validate the expected revision and construct the next committed record.
2. Retain the previous native bytes for rollback.
3. Serialize the complete native document into a unique temporary file in the same directory.
4. Flush and `fsync` the temporary file.
5. Atomically install it with `os.replace` and request a directory flush where supported.
6. Verify format, version, ID, revision, hash, and exact snapshot.
7. Write the matching SQLite record and commit.
8. Verify again. If post-commit verification unexpectedly fails, rewrite from authoritative committed SQLite and verify before reporting success.

If disk writing fails, SQLite is rolled back and its revision does not advance. If SQLite update/commit fails after the file changed, the database transaction is rolled back and the previous native bytes are atomically restored. The API never reports a successful save before the paired committed state is verified.

## Load, migration, and corruption

List/Open verifies the matching native file against SQLite. Missing, malformed, wrong-format, wrong-ID, wrong-revision, wrong-hash, or different snapshot content is not treated as valid.

The only automatic repair is an explicitly safe legacy migration: when a legitimate SQLite record has no native file, startup writes and verifies a mirror from that exact committed database record. It is idempotent and never uses fixtures. An existing unknown or corrupt file is not silently replaced; startup detects it and refuses to load the inconsistent runtime.

Files without matching SQLite records do not become workbooks merely because they exist.

## Save As, rename, and delete

- Save As creates a new UUID, SQLite row, and independent native file. Saving the copy cannot change the original file.
- Rename increments the record revision but keeps the same ID and filename. Snapshot content and snapshot hash remain unchanged.
- Delete verifies the target, atomically renames only that file to an inert `.bak` quarantine, commits deletion of only that SQLite row, and removes the quarantine. A pre-commit database failure restores the quarantine. If Windows keeps a post-commit quarantine locked, it can remain as an ignored inert cleanup orphan; it is not an active `.tws.json` workbook and is never listed.

## Diagnostics and testing

`GET /api/workbooks/{workbook_id}/storage` reports only safe metadata: whether the mirror is present, its revision, SHA-256, and integrity result. No absolute writable path is exposed.

Automated tests use temporary roots or the isolated runtime root under `.cache`; they never use `data\tiger_web_sheets.db` or the manual `workbooks` directory. Failure injection covers disk-write failure, SQLite-commit failure and rollback, malformed JSON, wrong ID, wrong revision, legacy migration, unrelated files, multi-workbook hashes, Save As, rename, delete, and restart detection.
