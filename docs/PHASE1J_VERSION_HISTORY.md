# Phase 1J — Version History and Restore

Status: **TECHNICAL_PASS. HUMAN_RUNTIME_TEST_REQUIRED.**

Starting gate: `main`, HEAD `94bec800119db92fc0ab2b7eb0ca9e1d87a59798`, clean working tree.

## Version history versus crash recovery

Crash recovery is a temporary browser-local IndexedDB checkpoint for uncommitted edits. Version history is permanent server-managed history of committed complete Univer snapshots. A successful restore clears the restored workbook's obsolete recovery checkpoint; another workbook's checkpoint is untouched.

## Durable architecture

SQLite table `workbook_versions` stores version ID, stable workbook ID, source revision, UTC creation time, source type, optional label, SHA-256, and relative filename. The matching immutable file is `history\<workbook-id>\<version-id>.tws.json` and identifies itself as `tiger-web-sheets-history` format version 1. It includes the complete snapshot, never a selection or partial cell set.

History creation writes a same-directory temporary file, flushes/fsyncs it, atomically replaces the final randomly generated identity, fsyncs the directory, verifies identity/hash/content, and only then inserts metadata in the active SQLite transaction. A failed metadata commit removes the new file. Files are never reused or rewritten. Paths accept only bounded safe IDs and must remain under the configured root.

The manual runtime root is `history\`. Automated destructive runs must explicitly configure a history root under `.cache`, in addition to an isolated database, workbook root, ports, and nonce. The launcher and frontend/backend identity checks refuse the manual history root, paths outside `.cache`, incomplete identity, and occupied ports before writes.

## Manual and automatic versions

- **建立版本** accepts an optional label. A dirty workbook first follows normal user-initiated Save, including external-file permission; no version is claimed if that save fails.
- Every changed normal commit is eligible for automatic history, but at most once per ten minutes per workbook. The check uses only metadata/hash until a version is due, avoiding history snapshot/file work every three-second autosave.
- The latest 20 automatic versions per workbook are retained, oldest-first. Manual and `pre_restore` versions are never automatically pruned.
- A history snapshot is limited to 16 MiB. Manual creation reports an oversized snapshot. An oversized automatic candidate creates neither a file nor false metadata and does not invalidate the current workbook commit.
- A representative 10,000 × 20 numeric-cell snapshot serialized to about 3.48 MiB in the deterministic check. This is a bounded representative result, not an enterprise-scale claim or browser latency benchmark.

## Listing and preview

**版本紀錄** is a compact modal, not a timeline application. It shows timestamp, source type, source revision, and label. Selecting a version previews worksheet count, worksheet names, and populated-cell count without loading that snapshot into the current Univer workbook. Missing, malformed, mismatched, or hash-invalid files are visibly marked **版本資料損毀** and cannot be restored.

## Restore semantics

Restore is an explicit user action with the warning: **確定要還原到此版本嗎？目前版本會先建立安全備份。**

The sequence is:

1. Validate the selected history metadata/file/format/version/workbook ID/version ID/source revision/SHA-256/complete snapshot.
2. Finish the current dirty Save or cancel restore on failure.
3. Acquire the backend write transaction and revalidate current optimistic revision and selected version.
4. Create an immutable `pre_restore` version labeled **還原前備份** from the current committed state.
5. Write and verify the selected snapshot as the current managed `.tws.json` at `current revision + 1`.
6. Commit SQLite current state and safety-version metadata together. Revision never rewinds to the historical source revision.
7. For a bound external `.tws.json`, use the existing direct-user-action permission and verified write pipeline. Internal success plus external failure is reported as synchronization failure, never as fully saved; the committed current state and pre-restore safety version remain recoverable for retry.
8. Clear the obsolete recovery checkpoint, reconstruct the Univer workbook from the committed restored snapshot, and resume autosave at the new revision.

A synchronous restore flag excludes automatic saves before UI state effects run, and a blocking overlay prevents grid input while restore is active. The normal serialized Save coordinator drains any active/dirty save before restore. Optimistic revision checks prevent an older save or concurrent restore from overwriting the new revision.

## Workbook lifecycle

- History is strictly scoped by stable workbook ID. Lists and restore routes require both workbook ID and version ID.
- Save As creates a new ID and does not copy the source history. The normal creation policy may create an initial automatic version for the new committed state.
- Rename advances the current revision but keeps the same ID/directory and does not rewrite timestamps or labels.
- Delete quarantines both the managed current file and only the target workbook's history directory, deletes the workbook in SQLite (foreign-key cascade removes metadata), then removes quarantines. A failed transaction restores both quarantines.
- Backend restart reloads the same SQLite metadata and verifies version files on list/restore.
- CSV and XLSX import/export do not contain or inherit Tiger history.

## Validation evidence

- Backend: manual labels, optional labels, list/preview, immutable file bytes, ten-minute coalescing, 20-auto retention, manual retention, restore, monotonic revision, pre-restore safety, restart persistence, workbook isolation, Save As isolation, rename preservation, delete cleanup, corrupt/wrong-workbook rejection, disk failure, DB failure cleanup, and restore-failure safety.
- Frontend: Traditional Chinese controls/routes/safety warning, synchronous autosave exclusion, serialized active-save drain, recovery cleanup scoped by workbook ID, explicit retention/identity policy, and representative 10k × 20 size boundary.
- Full retained Phase 0–1I suites are rerun during final validation.

## Known limitations

- No cell-by-cell visual diff, history branching/merge, comments, multi-user/cloud history, remote backup, AI summaries, or individual history deletion.
- Automatic retention bounds only automatic versions. Named/manual and pre-restore versions are intentionally permanent and consume disk until the workbook is deleted.
- History is Tiger-native and not embedded into CSV, XLSX, or a Save As copy.
- External file permission depends on supported desktop Chrome/Edge behavior. A restore can be internally committed yet remain visibly unsynchronized until external write retry succeeds.
- No enterprise-scale capacity claim; the hard per-version snapshot limit is 16 MiB.
- Existing Phase 1C structural formula-reference rewriting remains **PARTIAL**.

## Owner checkpoint

**HUMAN_RUNTIME_TEST_REQUIRED.** Follow the 48-step Phase 1J owner flow from the task specification: create 第一版/第二版, preview and restore both, confirm a new revision and 還原前備份, reload and restart, verify bounded automatic history, workbook isolation, Save As isolation, rename preservation, delete cleanup, recovery cleanup, and one bound external-file restore. The owner must personally decide PASS/FAIL.

Do not begin another phase automatically.
