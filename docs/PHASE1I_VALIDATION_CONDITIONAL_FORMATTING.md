# Phase 1I — Data Validation, Dropdown Lists, and Conditional Formatting

Status: **PASS — technical validation PASS; owner runtime acceptance PASS; Phase 1I final closure PASS.**

Implementation starting gate: `main`, HEAD `36193466f81f578e6aa5f213fd5f90b995a41258`, clean working tree. Final-closure starting gate: the same branch/HEAD, with exactly eight intended Phase 1I files dirty and no unrelated changes. Closure reruns deterministic gates, updates status, and commits that intended set only. No push, tag, or subsequent phase.

On 2026-10-09 the owner explicitly confirmed manual Phase 1I runtime acceptance PASS: dropdown, whole-number validation, decimal validation, text length, leading-zero text, conditional formatting, Traditional Chinese text contains, live reevaluation, persistence, autosave, backend restart, Save As isolation, and XLSX compatibility warning. This owner acceptance is authoritative; the prior Codex browser-helper failure does not block closure. Runtime claims below distinguish owner evidence from deterministic native-engine checks.

## Capability and licensing evidence

The starting stack had neither feature preset installed: both were OPEN_SOURCE_NEEDS_CONFIGURATION. The exact pinned 1.0.3 presets, their plugin registrations, TypeScript definitions, command implementations and Apache license headers were inspected. The scoped installation used `--save-exact --ignore-scripts`, adding seven packages, all 1.0.3 and Apache-2.0; no existing package versions changed and no commercial package was added.

| Requirement | Current classification | Evidence / boundary |
| --- | --- | --- |
| Explicit dropdown | PASS — native engine and owner runtime | `requireValueInList`, native LIST dropdown renderer/manager, arrow/chip display |
| Whole number | PASS — native engine and owner runtime | `requireNumberBetween(1,100,true)`, real validators tested on boundaries, fractions, text |
| Decimal | PASS — native engine and owner runtime | `requireNumberBetween(0,1)`, real validators tested on boundaries, out-of-range, text |
| Text length | PASS — native engine and owner runtime | native TEXT_LENGTH + LESS_THAN_OR_EQUAL; native editor and `FDataValidation.setCriteria` |
| Greater / less / equal | PASS — tested native computed styles; owner conditional-format acceptance | native conditional builder and `ConditionalFormattingService.composeStyle` |
| Traditional Chinese text contains | PASS — native engine and owner runtime | `whenTextContains('台中')` styles G2/G4, not G3/G5 |
| Duplicate values | PASS — deterministic native computed styles | `setDuplicateValues` styles H2/H4, not H3/H5; no fallback engine; not a separate owner-specific duplicate test claim |
| Fill / text / bold | PASS — native computed styles; owner conditional-format acceptance | native builder, persisted rule style, composer; owner accepted visible conditional formatting |

Added packages: `preset-sheets-data-validation`, `data-validation`, `sheets-data-validation`, `sheets-data-validation-ui`, `preset-sheets-conditional-formatting`, `sheets-conditional-formatting`, `sheets-conditional-formatting-ui`, all under `@univerjs`. Runtime tests check package.json version/license and Apache headers. The presets import facade extensions and register native model/UI plugins. Both bundled zh-TW locales and CSS are merged/imported in App.

Native plugin resource IDs are `SHEET_DATA_VALIDATION_PLUGIN` and `SHEET_CONDITIONAL_FORMATTING_PLUGIN`. Their installed resource controllers serialize per-sheet rule arrays into `workbook.save().resources` and hydrate them on opening. All existing persistence/copy pathways retain the whole snapshot; no parallel schema or rule engine was introduced.

Primary reference guides: [Univer data validation](https://docs.univer.ai/guides/sheets/features/data-validation) and [Univer conditional formatting](https://docs.univer.ai/guides/sheets/features/conditional-formatting). Actual installed 1.0.3 implementation/metadata, not current documentation alone, determined the capability/license matrix.

## Workflow and semantics

- Select a range, click **資料驗證／下拉選單** to manage native validation or **條件式格式設定** to manage native conditional rules. Add/edit/remove through the native sidebar. Invalid selection or command refusal yields a Traditional Chinese Tiger error. Native editors check invalid ranges/configuration; headless tests exercise empty-list and malformed-numeric validators, not their visible error UI.
- Inline single-choice lists are the certified source policy. Choose arrow/chip display in native options. Range sources, multi-choice and other native editor options are not certified by Phase 1I.
- First-version mode: native **顯示警告**. Invalid data stays in the cell and evaluates INVALID; the installed native renderer supplies an invalid corner marker and hover error. Owner runtime validation acceptance is PASS for the documented workflow; deterministic tests directly confirm INVALID results. Do not call invalid data valid or infer separate STOP certification.
- Native **拒絕輸入** (STOP + showErrorMessage) has a native input-interceptor/dialog implementation, but was not certified by keyboard tests. Facade/API writes can bypass interactive rejection; tests deliberately use WARNING and inspect real validator results.
- Text-length validation does not force a text cell type. Before typing leading-zero codes, select the code range and click **代碼設為文字** (native `@` number format). This does not convert existing numeric data or reconstruct zeroes. Its shortcut has a 50,000-cell limit and explicit refusal/error.
- Native dropdown manager submits a same-choice single-cell write. A small native BeforeCommandExecute integration identifies only the exact unchanged LIST payload on a plain text cell, so Tiger's dirty listener ignores that semantic no-op. Native commands still run normally (no cancellation or replacement renderer). It does not suppress changed choices, rich text/formula replacements, paste, formatting, or rule updates. Actual native command tests prove no dirty notification for the same choice, persistence for a new choice, and preservation of legitimate formula replacement. Tracking is transient/bounded and reads only the target cell, not a full snapshot per keypress.
- Native add/update/remove mutations mark dirty through Phase 1H's existing listener. Rule/UI operations and formula/conditional evaluation alone do not trigger autosave. Rules use the same 3-second autosave and independently debounced IndexedDB checkpoint, with unchanged external-file permission/conflict guarantees. No second recovery system.
- Save/reopen, rename, native-file import and Save As preserve resources. Copies are independently loaded models keyed by new backend workbook ID. Delete uses existing recovery cleanup.
- CSV remains displayed-value-only on export, text-only on import; it does not carry or invent rules. XLSX explicitly warns that validation/dropdowns and conditional rules/dynamic styles are not exported; it is not lossless. No ExcelJS mapping was added.

## Evidence and validation

`validate:phase1i-rules` uses real Univer plugins, validators, commands, formula calculation, and conditional render-style composer. It is not a custom/mock validation engine. IndexedDB integration uses fake-indexeddb for the existing production RecoveryStore; autosave uses its production coordinator with a deterministic clock.

- Dropdown representative: A1=狀態, A2:A10 options 待處理/處理中/已完成. Actual choice values/INVALID arbitrary input validated; remove/undo/redo preserves existing data.
- Whole B2:B20 1..100: 1/50/100 VALID; 0/101/1.5/文字 INVALID. Decimal C2:C20 0..1: 0/0.25/1 VALID; -0.1/1.1/文字 INVALID. D2:D20 length<=8: ABC123/00123 VALID; ABCDEFGHI INVALID. `00123` remains a STRING with native text format.
- F2:F5 values 50/100/150/200: >100 selects F4/F5; <100 selects F2; =100 selects F3. Live F2 50→150→50 updates composer styles without manual refresh. Native remove/undo/redo and edit re-evaluation tested.
- G2:G5 台中公司/台北公司/台中門市/高雄公司: contains 台中 selects G2/G4 only. H2:H5 A001/A002/A001/A003: duplicates selects H2/H4 only. Native fill/text color/bold verified on every expected styled cell.
- Formula case J1=50, J2=`=J1*2`, J2 >120 initially unstyled; J1=70 recalculates J2=140 and native style appears. This numerical result case works, not a claim of advanced formula-rule parity.
- Rule snapshot reopen re-tests validators and computed styles, not JSON alone. Actual rule changes trigger production autosave/recovery; reopened checkpoint restores rules. Save As copy modification leaves original rules unchanged. Recovery cleanup/save/delete key isolation tested.
- 1,000-cell dropdown, 1,000-cell numeric validation, 1,000-cell conditional calculation and 100 repeated edits pass in headless runtime. Measured aggregate runs around 125–185 ms; **this is not evidence of browser typing responsiveness**.
- Final closure reran the complete backend suite: 49 tests passed. The focused Phase 1I suite passed all 16 deterministic groups; isolated API and post-restart modes each passed 17 groups. Retained frontend Phase 1D, safe-sort, Phase 1E native files, Phase 1F CSV, Phase 1G XLSX and Phase 1H autosave suites passed. Independent Python OOXML verification passed. TypeScript, production build and lint passed; existing large-bundle warning remains.

Actual destructive API checks, repeated during final closure, used only nonce `phase1i-20261009-a1`, backend 18302, frontend 5285, database `.cache/isolated-runtimes/phase1i-20261009-a1/workbook.db`, and managed root alongside it. Health paths/runtime/nonce were verified before first write. Explicit `TIGER_WEB_SHEETS_DB`/workbook-root settings, production database refusal, owner workbook-root refusal and occupied-port refusal passed. Disposable native rule workbook was saved, renamed, copied (copy modified/deleted), and native-document reimported. Direct inspection of its on-disk `.tws.json` confirmed list, whole, decimal, textLength, numeric conditional and 台中 text-contains conditional rules. Backend was stopped/restarted and persisted native rules were loaded into a fresh real Univer runtime; validators/styles were re-tested successfully. Closure-start versus closure-end SHA-256 comparisons confirmed the owner database and all six managed-directory files unchanged. Task-owned runtime processes were stopped after tests and both test ports released; ignored disposable evidence remains in `.cache`.

Historical automation diagnostic: browser helper initialization failed twice before UI input: `node_repl kernel exited unexpectedly` with `windows sandbox failed: helper_unknown_error: setup refresh had errors`, then `trusted Node process exited unexpectedly; kernel reset, rerun your request`. Those attempts supplied no browser evidence. The subsequent owner manual acceptance is PASS for the explicitly listed runtime capabilities, including visible dropdowns, leading-zero text, conditional formatting, persistence, autosave, backend restart, Save As and XLSX warnings. Closure does not require or retry Codex browser automation. No agent-generated screenshots, keyboard observations, or browser benchmark numbers are fabricated; additional unlisted native options/error dialogs remain uncertified.

## Known limits and closure

- Support is limited to the tested first-version rules above; no certified advanced Excel parity, advanced rules, dependent/cascading dropdowns, cross-workbook sources or XLSX rule mapping. Advanced conditional-format types (including color scales, data bars and icon sets) remain uncertified.
- Native extra sidebar features are not certified merely because present.
- Text format is required BEFORE entering leading-zero codes. Text length alone accepts numeric values using their text representation.
- Native `.tws.json` remains the authoritative Tiger format for these rules. CSV does not preserve validation/conditional formatting. XLSX rule round-trip is not certified and export must warn.
- Native STOP keyboard/dialog behavior is not separately certified; facade/API writes are not a rejection boundary.
- Existing Phase 1C structural formula-reference rewriting remains **PARTIAL**.
- Recovery bounds/shutdown checkpoint window remain Phase 1H's documented limits; no guaranteed network completion on browser close.
- Normal interactive behavior has owner acceptance. No browser benchmark was measured; the 1,000-cell dropdown/numeric/conditional tests are headless evidence only. Multi-rule overlap/priority behavior remains uncertified.

## Exact 53-step owner checkpoint

Retained checkpoint instructions for reproducibility, not an outstanding acceptance gate: owner runtime acceptance is **PASS**, explicitly confirmed on 2026-10-09 for the capabilities listed above. Autosave/recovery integration also passes deterministic production-coordinator/RecoveryStore tests; no additional owner crash-recovery observation is inferred beyond the owner's stated acceptance. Use a disposable workbook. For step 19, prepare the selected code range with **代碼設為文字** before entry; this is the documented native text-storage workflow, not automatic reconstruction of zeroes. For invalid-input steps use **顯示警告** with the native marker/hover error; separate STOP certification is outside this closure.

1. Start Tiger-Web-Sheets.
2. Create/open a test workbook.
3. In A1 enter: 狀態
4. Apply dropdown validation to A2:A10 using: 待處理 / 處理中 / 已完成
5. Confirm dropdown control appears.
6. Select: 處理中
7. Confirm A2 becomes: 處理中
8. Test an invalid value and confirm documented invalid-state behavior.
9. In B1 enter: 數量
10. Apply whole-number validation to B2:B10: minimum 1 / maximum 100
11. Confirm: 50 is valid.
12. Test: 101
13. Confirm invalid behavior.
14. In C1 enter: 折扣
15. Apply decimal validation: 0 to 1
16. Confirm: 0.25 works.
17. In D1 enter: 代碼
18. Apply text-length validation: <= 8
19. Enter: 00123
20. Confirm leading zero remains.
21. Test a value longer than 8 characters and confirm invalid behavior.
22. Save.
23. Reload.
24. Confirm all validation/dropdown rules remain active.
25. Enter conditional-format test: F1 = 金額 / F2 = 50 / F3 = 100 / F4 = 150 / F5 = 200
26. Add rule: greater than 100
27. Apply an obvious fill/text style.
28. Confirm only F4/F5 are styled.
29. Change F2 from 50 to 150.
30. Confirm F2 becomes styled automatically.
31. Change F2 back to 50.
32. Confirm style disappears.
33. Test: text contains 台中 with: 台中公司 / 台北公司 / 台中門市 / 高雄公司
34. Confirm only the two 台中 cells are styled.
35. Remove one conditional-format rule.
36. Confirm formatting rule disappears but cell values remain.
37. Confirm workbook becomes 未儲存 after rule changes.
38. Wait for autosave.
39. Confirm 已儲存.
40. Restart backend.
41. Reload.
42. Confirm rules still work.
43. Save As a copy.
44. Modify validation or conditional formatting in the copy.
45. Reopen original.
46. Confirm original rule did not change.
47. Export CSV.
48. Confirm CSV contains values but not Tiger validation/conditional formatting.
49. Export XLSX.
50. Confirm compatibility warning appears for unsupported Phase 1I features.
51. Test one crash-recovery case with an unsaved rule change.
52. Choose 復原.
53. Confirm the rule returns.

The owner has already decided runtime acceptance PASS. Do not begin another phase automatically.

## Final capability status

- Dropdown: PASS
- Whole-number validation: PASS
- Decimal validation: PASS
- Text-length validation: PASS
- Conditional formatting numeric rules: PASS
- Traditional Chinese text contains: PASS
- Live reevaluation: PASS
- Persistence: PASS
- Autosave / recovery integration: PASS
- Owner runtime acceptance: PASS
- Phase 1I: PASS
