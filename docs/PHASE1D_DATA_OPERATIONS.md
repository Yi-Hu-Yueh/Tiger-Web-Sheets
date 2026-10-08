# Phase 1D data operations

Tiger Web Sheets configures the Apache-2.0 Univer 1.0.3 sort, filter, and find/replace presets. No Univer Pro package, parallel grid, or application-owned spreadsheet data model is used.

## Capability matrix

| Capability | Starting status | Implemented integration | Validation status |
| --- | --- | --- | --- |
| Sort | `PASS` | Tiger **安全排序** UI over Univer's native `sheet.command.sort-range` model | Full-tuple automation, actual Apply-button browser regression, X-close repair, and owner desktop acceptance pass |
| Filter | `PASS` | Tiger **啟用篩選** control over Univer's native `sheet.command.set-filter-range`, with `@univerjs/preset-sheets-filter` 1.0.3 UI | Native model/snapshot checks, actual header-menu browser workflow, save/reload, clear-filter safety, and owner desktop acceptance pass |
| Find | `PASS` | `@univerjs/preset-sheets-find-replace` 1.0.3 | Native UI integration and owner desktop acceptance pass; Find remains non-dirty |
| Replace | `PASS` | `@univerjs/preset-sheets-find-replace` 1.0.3 plus explicit dirty tracking for native replace commands | Native UI integration, persisted-change tracking, and owner desktop acceptance pass |

Owner manual acceptance is complete for Safe Sort, Safe Sort X close, Filter, Find, and Replace.

## Supported safe sort workflow

For the first-version workflow:

1. Select the complete rectangular record range, including the header row and every ordinary data column that must move together.
2. Select **安全排序** in the Tiger Web Sheets application bar.
3. Verify the displayed worksheet and range, choose the sort key and direction, and keep **第一列為標題（必要）** checked.
4. Select **套用安全排序**.

For the Phase 1D fixture the supported sort rectangle is `A1:E5`, with the header option enabled. The native `sheet.command.sort-range` command moved complete `ID | 姓名 | 電話 | 金額 | 城市` tuples, preserved all leading-zero phone strings, excluded the header from the reordered rows, and participated in native undo/redo.

Observed orders:

- 金額 ascending: `R001, R002, R003, R004`
- 金額 descending: `R004, R003, R002, R001`
- 姓名 ascending: `李小華, 林小美, 王小明, 陳大同`
- ID ascending: `R001, R002, R003, R004`

Univer 1.0.3's normal quick-sort action sorts only the current selection, while its expanded quick-sort action does not mark the first row as a header. Both can split records or move the header. Tiger therefore registers the open-source core sort model without Univer's sort UI plugin. The ambiguous native toolbar/context-menu actions and filter-popup sort shortcuts are not exposed. The application-owned **安全排序** control is the only visible sorting path and always calls the native sort command with the exact selected rectangle and `hasTitle: true`.

### Formula-column limitation

The fixture keeps `F2:F5` as same-row formulas (`=D2*0.95` through `=D5*0.95`) and sorts `A1:E5`. The formula cells remain in their rows and recalculate correctly after every tested sort.

Do not include this kind of self-row-derived formula column in the sort rectangle in Univer 1.0.3. A diagnostic sort of `A2:F5` moved each formula string unchanged with its source record; after recalculation, the unchanged row references pointed at different destination rows and produced mismatched results. The **安全排序** control rejects selected rectangles containing formulas and asks the user to select ordinary data columns only. Tiger Web Sheets does not rewrite Univer's sort engine.

## Filter behavior

The visible **啟用篩選** control creates a filter on the selected header-bearing rectangle with Univer's native `sheet.command.set-filter-range`. This explicit entry point is necessary because Univer 1.0.3 exposes filter activation as the primary action of a selector whose dropdown lists only clear/recalculate actions. After activation, Univer's native header controls and filter panel handle criteria. The automated model check creates a filter over `A1:F5`; the actual browser workflow was accepted over `A1:E5`.

- 城市 = 台中 left `R003` and `R004` visible and filtered out row indexes `1` and `2` after the final ID sort.
- 金額 in `{100, 200}` left `R001` and `R002` visible and filtered out row indexes `3` and `4`.
- Clearing criteria returned an empty filtered-row list. No cell values or rows were deleted.

Filter configuration is persisted by Univer in the workbook `resources` entry named `SHEET_FILTER_PLUGIN`. Recreating a native Univer workbook from the saved snapshot restored the 台中 criterion and the same filtered-row indexes. Applying, changing, clearing, or removing a filter emits persisted filter mutations, so Tiger Web Sheets marks the workbook `未儲存`; merely opening or closing filter UI does not.

## Find behavior

The native open-source find UI and Traditional Chinese locale are configured. Find/navigation does not emit a persisted workbook mutation, so it does not dirty the workbook. The owner completed and accepted the desktop Find checkpoint.

No custom search overlay, regex layer, fuzzy search, or Excel-parity claim was added.

## Replace behavior

The native open-source Replace and Replace All UI is configured. Tiger Web Sheets now treats native `sheet.command.set-range-values` and `sheet.command.replace` executions as persisted changes while still ignoring formula-engine recalculation mutations. This closes the dirty-state gap for native replacement commands without marking Find navigation dirty.

The owner completed and accepted the desktop Replace checkpoint. Automated validation still treats native replace commands as persisted changes without claiming broader Excel compatibility.

## Automated validation

`npm run validate:phase1d` uses Univer's headless open-source model and command APIs against the representative fixture. It validates:

- numeric ascending and descending sort
- exact complete-row tuple integrity
- header preservation
- leading-zero strings
- text and ID sort order
- native sort undo and redo
- formula recalculation in the supported range workflow
- city and numeric filters
- clear-filter safety
- filter snapshot restoration
- optional API save/load when `PHASE1D_API_URL` is set

`npm run validate:phase1d-safe-sort` is the focused R1 regression gate. It uses the same command contract as the visible **安全排序** control (`hasTitle: true` and one exact full-table rectangle) and checks complete five-field tuples, header preservation, leading-zero strings, ascending and descending order, native Undo/Redo, and saved-snapshot reconstruction.

The R2 browser regression additionally exercised the real React **套用安全排序** button against the isolated Phase 1D database. The panel retained the captured `A1:E5` range after focus moved to its dropdowns, ID ascending and 金額 ascending/descending moved complete records through `sheet.command.sort-range`, successful Apply changed the status to `未儲存`, native Undo/Redo restored and reapplied the order, and Save plus backend restart plus browser reload retained the descending result. The Apply path now uses the loaded workbook reference and the captured worksheet ID rather than re-resolving whichever workbook or sheet happens to be active after panel focus changes. Command rejection is surfaced as a visible Traditional Chinese error instead of a silent no-op.

The fixture is `backend/tests/fixtures/phase1d_data_operations.json`. The R2 isolated browser runtime used `.cache/phase1d-r2-runtime/phase1d-r2-isolated.db`; that cache is not source-controlled.

## Compatibility boundaries

- This is a tested Univer 1.0.3 baseline, not full Excel data-tool compatibility.
- Single-column sorting of a multi-column record set is unsafe and is no longer exposed as a normal-looking UI action.
- A self-row-derived formula column must stay outside the sort rectangle in the tested workflow.
- Generic TSV paste may auto-convert leading-zero values before sorting. R1 verifies only that existing string-valued phone records keep their leading zeros through sort; generic paste conversion remains open.
- Multi-column custom sort design, regex/fuzzy search, advanced filter languages, pivot tables, CSV, and XLSX are outside Phase 1D.

## Phase 1D final acceptance

`OWNER_MANUAL_ACCEPTANCE: PASS`

- Safe Sort: PASS
- Safe Sort X close: PASS
- Filter activation, criteria, clear, save, and reload: PASS
- Find: PASS
- Replace: PASS
