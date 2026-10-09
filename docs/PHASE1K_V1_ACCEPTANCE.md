# Phase 1K — V1 Release Hardening and Acceptance

Release candidate: **1.0.0-rc1**

Technical status: **TECHNICAL_PASS.**

Owner status: **HUMAN_RUNTIME_TEST_REQUIRED.**

Starting gate: `main`, `8eb2a1ec6207872c19a98a8f1da5e770936d6050`, clean.

## Formal acceptance matrix

`Runtime` means direct isolated runtime evidence or previously recorded owner desktop evidence. `Owner` is never inferred from headless/source checks.

| Capability | Automated | Runtime | Owner | Known limitation | Release blocker |
|---|---|---|---|---|---|
| Startup, health, explicit manual identity, occupied-port refusal | PASS | PARTIAL | NOT_TESTED | Successful isolated start passed; existing unrelated/unhealthy listeners prevented a fresh normal-port start, and the launcher correctly refused them | No; owner gate pending |
| Fresh database / workbook / history roots | PASS | PASS | NOT_TESTED | Browser rendering helper unavailable in this run | No; owner gate pending |
| Workbook CRUD, revisions, conflict refusal, persistence | PASS | PASS | NOT_TESTED | Local single-user design | No |
| Managed `.tws.json` atomic mirror and legacy reconstruction | PASS | PASS | NOT_TESTED | SQLite remains identity/current-state authority | No |
| User-selected `.tws.json` synchronization | PASS | PASS (retained simulation) | NOT_TESTED | Desktop Chrome/Edge permission model | No; owner gate pending |
| Core grid edits, formatting, merge/freeze, row/column/sheet operations | PASS | PASS (retained evidence) | PARTIAL | Owner-only Ctrl+X checkpoint remains | No; owner gate pending |
| Formula baseline | PASS | PASS (retained evidence) | PARTIAL | Structural reference rewriting remains PARTIAL | No, documented boundary |
| Safe Sort, Filter, Find, Replace | PASS | PASS | PASS | Safe Sort rejects formula-containing ranges | No |
| CSV import/export | PASS | PASS (deterministic round trip) | NOT_TESTED | Values-only, one worksheet | No; owner gate pending |
| XLSX bounded baseline | PASS | PASS | PASS | Not full Excel parity; rules not certified | No |
| Autosave and browser-local recovery | PASS | PASS (coordinator/API) | NOT_TESTED | No shutdown-completion promise | No; owner gate pending |
| Validation and conditional formatting baseline | PASS | PASS | PASS | Advanced rules/STOP behavior not certified | No |
| Persistent version history and safe restore | PASS | PASS | NOT_TESTED | Full snapshots; no diff/branch/delete-version UI | No; owner gate pending |
| Save As and three-workbook isolation | PASS | PASS | NOT_TESTED | External handles remain browser-owned | No |
| Failure containment / no false saved state | PASS | PASS (controlled paths) | NOT_TESTED | OS permission prompts require owner browser | No; owner gate pending |
| Storage integrity / missing-corrupt detection | PASS | PASS | NOT_TESTED | Corrupt files are refused, not auto-reconstructed | No |
| 1,000×20 persistence smoke | PASS | PASS | NOT_TESTED | Not a browser benchmark | No |
| 10,000×20 persistence smoke | PASS | PASS | NOT_TESTED | Browser open/render unavailable in this run | No; owner gate pending |
| 30-minute repeated-operation soak | PASS | PASS | NOT_TESTED | API save/list/reopen/version sequence, not interactive grid automation or memory-leak proof | No; owner gate pending |

## Automated evidence

- Backend pytest baseline: 58/58 before changes; release suite currently 62/62 after four Phase 1K regressions.
- TypeScript production build and ESLint: PASS. Existing large-bundle advisory remains non-fatal and documented.
- Retained validators: Phase 1D, Safe Sort, Phase 1E local files, Phase 1F CSV, Phase 1G XLSX/security/cancellation, Phase 1H autosave/recovery, Phase 1I native rules, and Phase 1J history all PASS.
- Phase 1K deterministic checks: release version, launcher safety, localized main failure messages, and no commercial/Univer Pro dependency PASS.
- Fresh isolated runtime: nonce `phase1k-v1-20261009-a1`, backend `18410`, frontend `5310`, with explicit isolated DB/workbook/history paths. Fresh list was empty before first write.
- Cross-feature runtime: multiple sheets, formulas, leading-zero text, styles/number formats, merge/freeze, validation/conditional resources, rapid saves, named version, restore, pre-restore backup, Save As, rename, delete, and three-workbook isolation retained exact snapshots.
- Performance persistence (not browser rendering): 1,000×20 save about 1.32 s / reopen 0.15 s; 10,000×20 save about 7.53 s / reopen 1.14 s on this machine.
- Actual backend stop/restart reopened the restored workbook, history, independent copy, and 10,000×20 workbook.
- The 30-minute isolated soak completed 641 committed save cycles (revision 9 → 650), list/reopen switching, and 12 manual-version checkpoints. History remained bounded at four automatic versions plus one pre-restore version. No crashes or error-log findings occurred.
- Resource samples were stable enough for this bounded smoke: backend private memory 114.2 MiB initially, 146.8 MiB midpoint, 143.3 MiB final; frontend private memory 1571.0 → 1576.7 MiB. This is not proof of absence of leaks.
- Final read-only storage audit: `PRAGMA integrity_check=ok`, `foreign_key_check=ok`, four workbooks/four managed mirrors and 21 history records/files verified exactly; no orphan metadata or files.
- No `.tmp`, `.bak`, delete/prune quarantine, unfinished export, or error-log finding remained. After stopping services, the isolated WAL was checkpointed and no WAL/SHM residue remained.
- Owner `data\`, `workbooks\`, and `history\` fingerprints remained unchanged.

## Controlled failure matrix

| Failure | Status | Evidence / safe result |
|---|---|---|
| Backend unavailable | PASS | Localized connection error; no saved claim |
| SQLite commit failure | PASS | Existing/current state and managed bytes roll back |
| Managed native write failure | PASS | Database commit does not proceed |
| User-file permission unavailable | PASS | Coordinator simulation reports permission/sync failure; no `已儲存` |
| Revision conflict | PASS | HTTP 409; newer revision remains unchanged |
| Malformed `.tws.json` | PASS | Schema/hash/identity rejection |
| Malformed CSV | PASS | Retained parser/limit suite refuses before workbook creation |
| Malformed XLSX | PASS | Signature/XML/archive security suite refuses |
| Oversized XLSX | PASS | Entry/total/cell/sheet limits refuse |
| Corrupt history | PASS | Listed as corrupt; restore disabled/rejected |
| Missing history file | PASS | Listed as corrupt; restore returns 422 |
| Worker/XLSX cancellation | PASS | Worker terminates without partial workbook/export |
| Automatic-history disk failure | PASS | Phase 1K regression found/fixed the route boundary; PUT returns controlled 503 and current DB/native bytes remain unchanged |

## Upgrade and lifecycle findings

- A Phase 1A SQLite-only record is opened, its missing managed mirror is reconstructed, the history table is added, and a second startup is byte-idempotent.
- Existing managed-file, Phase 1E multi-workbook, Phase 1I rule-resource, and Phase 1J history states remain covered by their retained tests plus the combined snapshot flow.
- Closing the frontend left the backend healthy; frontend restart returned HTTP 200. Backend shutdown left the static frontend reachable while its API proxy returned 502 rather than false health. Backend restart preserves committed work. Reload/reopen reads committed state and prompts for a differing recovery checkpoint where one exists.
- Tiger does not promise that browser/backend shutdown completes an asynchronous save. `beforeunload`, visible dirty state, and IndexedDB recovery are the honest boundaries.
- Browser-control initialization failed twice with `windows sandbox failed: helper_unknown_error: setup refresh had errors`; therefore fresh home-screen and large-grid browser rendering are `NOT_TESTED` in this run, not fabricated as PASS.

## Safeguards and security

Normal startup makes DB/workbook/history paths explicit, exposes and verifies health identity and `1.0.0-rc1`, uses process-local portable Node/Python configuration, refuses occupied ports, and never terminates another process. Isolated startup continues to require explicit `.cache` paths plus nonce and refuses the canonical manual paths. Retained tests cover traversal, native identity/hash mismatch, XLSX archive traversal/bombs/external links/macros, and malformed input.

No new dependency was added. Existing Univer packages remain the Apache-2.0 open-source 1.0.3 packages; Univer Pro is absent.

## Remaining owner checkpoint

The release candidate requires the focused V1 checklist in the final report and [V1 user guide](V1_USER_GUIDE.md). The owner decides **V1 ACCEPTED** or **V1 FAILED**. Do not create a final `v1.0.0` tag before that decision.

Release decision: **eligible for owner V1 acceptance**. This is not final owner acceptance and no `v1.0.0` tag is authorized.

Focused owner checklist:

1. Back up `data\`, `workbooks\`, and `history\` together.
2. From a fresh shell run `scripts\start_tiger_web_sheets.cmd` and confirm both service windows stay open.
3. Open `http://127.0.0.1:5173/`; confirm the workbook list and `1.0.0-rc1` are visible.
4. Create a disposable workbook and enter values plus one formula.
5. Apply representative font/fill/number formatting, merge, and freeze.
6. Create a dropdown, numeric validation, and conditional-format rule; confirm visible behavior.
7. Build a plain multi-column table and run Safe Sort on the complete rectangle.
8. Enable Filter, filter/clear it, Find a value, and Replace a disposable value.
9. Save to a newly selected `.tws.json`; confirm **已儲存** only after the picker/write completes.
10. Edit again and confirm **未儲存**, then wait for autosave to return to **已儲存**.
11. Reload the browser and confirm data/formula/format/rules remain.
12. Stop and restart only the Tiger backend; reopen and confirm persistence.
13. Make a dirty edit, wait for the recovery checkpoint, close/reopen, and choose **復原**.
14. Create a named version, edit/save, restore the named version, and confirm **還原前備份** plus a higher revision.
15. Reload after restore and confirm the restored content remains.
16. Use **另存新檔**; confirm a new workbook ID/file and independent history.
17. Modify the copy and confirm the original is unchanged.
18. Open a third workbook and verify rules/recovery/versions do not leak between documents.
19. Reopen the external `.tws.json`, edit/save it, and verify no extra picker is required while permission remains.
20. Export CSV containing Traditional Chinese, comma, quote, newline, empty cell, `00123`, and literal `=1+1`.
21. Import that CSV through preview; confirm leading zero and formula-like text remain literal.
22. Confirm CSV export did not alter Tiger's save indicator.
23. Export the certified XLSX baseline and open it in Excel or another independent XLSX reader.
24. Reimport the XLSX and confirm sheets, formulas/results, common formats/styles, merge, and dimensions within the documented boundary.
25. Confirm the XLSX validation/conditional-format compatibility warning is visible and truthful.
26. Trigger unsaved navigation and confirm Save/Discard/Cancel protection.
27. Cancel one native picker and confirm no workbook/revision/file association changed.
28. Delete only a disposable workbook through its confirmation and verify other workbooks remain.
29. Close both service windows only after **已儲存**, restart from a fresh shell, and reopen representative workbooks.
30. Decide **V1 ACCEPTED** or **V1 FAILED**, noting any failed step and visible message.
