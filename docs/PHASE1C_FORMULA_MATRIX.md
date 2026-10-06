# Phase 1C Formula Compatibility Matrix

## Scope and test environment

This baseline records the behavior of the installed open-source Univer 1.0.3 formula engine. No alternate calculation engine, Univer Pro package, dependency upgrade, or Excel-compatibility shim was used.

- Frontend: `http://127.0.0.1:5173/`
- Backend: `http://127.0.0.1:18085/`
- Isolated database: `.cache/phase1c-runtime/phase1c.db`
- Production/manual database: `data/tiger_web_sheets.db` (not opened or modified)
- Runtime workbook: `tiger-phase-1c-formula-baseline`
- Worksheets: `公式基準`, `資料表`, `結構測試`
- Reusable snapshot: `backend/tests/fixtures/phase1c_formula_cases.json`

The browser grid supplied visible evidence. After each save, the API snapshot supplied direct evidence for formula text (`f`), calculated value (`v`), type (`t`), worksheet identity, and workbook structure. A successful browser reload and a backend-only restart were verified against the same isolated database.

Status meanings:

- `VERIFIED SUPPORTED`: observed in the running Univer workbook and confirmed in the persisted snapshot.
- `PARTIAL`: the supported core behavior is usable, but the automated environment could not complete an adjacent edge case.
- `FAILED`: the tested behavior produced an incorrect result.
- `NOT TESTED`: no defensible runtime observation was obtained.

## Formula matrix

| Category | Test location | Formula or action | Expected | Observed runtime/snapshot | Status |
| --- | --- | --- | --- | --- | --- |
| Arithmetic literal addition | `公式基準!D1` | `=1+2` | `3` | `f = =1+2`, `v = 3` | VERIFIED SUPPORTED |
| Arithmetic literal subtraction | `公式基準!D2` | `=10-3` | `7` | `f = =10-3`, `v = 7` | VERIFIED SUPPORTED |
| Arithmetic literal multiplication | `公式基準!D3` | `=4*5` | `20` | `f = =4*5`, `v = 20` | VERIFIED SUPPORTED |
| Arithmetic literal division | `公式基準!D4` | `=20/4` | `5` | `f = =20/4`, `v = 5` | VERIFIED SUPPORTED |
| Operator precedence | `公式基準!D5` | `=2+3*4` | `14` | `f = =2+3*4`, `v = 14` | VERIFIED SUPPORTED |
| Parentheses | `公式基準!D6` | `=(2+3)*4` | `20` | `f = =(2+3)*4`, `v = 20` | VERIFIED SUPPORTED |
| Reference addition | `公式基準!D7` | `=A1+B1` | `12` | `f = =A1+B1`, `v = 12` | VERIFIED SUPPORTED |
| Reference subtraction | `公式基準!D8` | `=A1-B1` | `8` | `f = =A1-B1`, `v = 8` | VERIFIED SUPPORTED |
| Reference multiplication | `公式基準!D9` | `=A1*B1` | `20` | `f = =A1*B1`, `v = 20` | VERIFIED SUPPORTED |
| Reference division | `公式基準!D10` | `=A1/B1` | `5` | `f = =A1/B1`, `v = 5` | VERIFIED SUPPORTED |
| `SUM` with mixed input | `公式基準!E1` | `=SUM(A1:A5)` | `60` | numeric cells summed; text and blank ignored; `v = 60` | VERIFIED SUPPORTED |
| `AVERAGE` with mixed input | `公式基準!E2` | `=AVERAGE(A1:A5)` | `20` | text and blank ignored; `v = 20` | VERIFIED SUPPORTED |
| `MIN` with mixed input | `公式基準!E3` | `=MIN(A1:A5)` | `10` | `v = 10` | VERIFIED SUPPORTED |
| `MAX` with mixed input | `公式基準!E4` | `=MAX(A1:A5)` | `30` | `v = 30` | VERIFIED SUPPORTED |
| `COUNT` with mixed input | `公式基準!E5` | `=COUNT(A1:A5)` | `3` | only three numeric cells counted; `v = 3` | VERIFIED SUPPORTED |
| `IF` true branch | `公式基準!E6` | `=IF(A1>=10,"PASS","FAIL")` | `PASS` | `v = PASS` | VERIFIED SUPPORTED |
| `IF` false branch | `公式基準!E7` | `=IF(B1>=10,"PASS","FAIL")` | `FAIL` | `v = FAIL` | VERIFIED SUPPORTED |
| Relative reference | `公式基準!F1` | `=A1` | `10` | formula and value persisted | VERIFIED SUPPORTED |
| Absolute reference | `公式基準!F2` | `=$A$1` | `10` | formula and value persisted | VERIFIED SUPPORTED |
| Mixed column-absolute | `公式基準!F3` | `=$A1` | `10` | formula and value persisted | VERIFIED SUPPORTED |
| Mixed row-absolute | `公式基準!F4` | `=A$1` | `10` | formula and value persisted | VERIFIED SUPPORTED |
| Range reference | `公式基準!F5` | `=SUM(A1:B3)` | `69` | `f = =SUM(A1:B3)`, `v = 69` | VERIFIED SUPPORTED |
| Cross-sheet scalar | `公式基準!G1` | `=資料表!A1` | `100` | `f` remained cross-sheet; `v = 100` | VERIFIED SUPPORTED |
| Cross-sheet range | `公式基準!G2` | `=SUM(資料表!A1:A3)` | `600` | `f` remained cross-sheet; `v = 600` | VERIFIED SUPPORTED |
| Divide by zero | `公式基準!H1` | `=1/0` | error | `v = #DIV/0!`, `t = 1` | VERIFIED SUPPORTED |
| Unknown function | `公式基準!H2` | `=NOT_A_REAL_FUNCTION(1)` | error | `v = #NAME?`, `t = 1` | VERIFIED SUPPORTED |

## Reference adjustment

Univer's fill commands were used because they were reliably exercisable in the isolated browser runtime and expose the adjusted formula strings in the saved snapshot.

| Direction | Source | Destination | Observed formula after fill | Status |
| --- | --- | --- | --- | --- |
| Down | `J1 = =A1` | `J2` | `=A2` | VERIFIED SUPPORTED |
| Down | `K1 = =$A$1` | `K2` | `=$A$1` | VERIFIED SUPPORTED |
| Down | `L1 = =$A1` | `L2` | `=$A2` | VERIFIED SUPPORTED |
| Down | `M1 = =A$1` | `M2` | `=A$1` | VERIFIED SUPPORTED |
| Right | `J4 = =A1` | `K4` | `=B1` | VERIFIED SUPPORTED |
| Right | `J5 = =A$1` | `K5` | `=B$1` | VERIFIED SUPPORTED |
| Right | `J6 = =$A1` | `K6` | `=$A1` | VERIFIED SUPPORTED |
| Right | `J7 = =$A$1` | `K7` | `=$A$1` | VERIFIED SUPPORTED |

`Ctrl+D` and `Ctrl+R` used Univer's native fill behavior and produced the formula strings above. The in-app browser's `Ctrl+C`/`Ctrl+V` clipboard route copied the four source formula strings literally into the destination before fill was applied, so ordinary desktop native-copy reference adjustment remains an owner checkpoint. This is classified `PARTIAL`, not a false failure of the formula engine.

## Recalculation and dirty state

- Direct precedent: changing `公式基準!A1` from `10` to `15` changed `D7` from `12` to `17`, `E1` from `60` to `65`, and `F1` from `10` to `15`.
- Cross-sheet precedent: changing `資料表!A1` from `100` to `250` changed `公式基準!G1` to `250` and `G2` to `750`.
- The input edits changed the application header from `已儲存` to `未儲存`.
- Formula entry and native fill also changed the status to `未儲存`.
- Calculation-result mutations did not create a second false dirty transition: saving after calculation reached `已儲存`, and reload/hydration remained `已儲存`.
- The canonical saved values were restored to `公式基準!A1 = 10` and `資料表!A1 = 100` after the mutation checks.

All recalculation cases above are `VERIFIED SUPPORTED`.

## Structural reference behavior

The baseline `結構測試!A3 = SUM(A1:A2)` calculated `30` and round-tripped as a formula. The Univer cell context menu exposed native insert/delete commands. The automated in-app browser could open the nested insert/delete menus but could not reliably activate their nested row/column commands without risking a different canvas selection. No structural mutation was claimed.

- Formula before mutation: verified (`=SUM(A1:A2)`, value `30`).
- Inserted-row reference rewrite: `NOT TESTED`.
- Deleted-row/cell invalid reference: `NOT TESTED`.
- Overall structural edge-case classification: `PARTIAL`.

This limitation is not a critical core-formula failure; the workbook remained internally usable and all saved formulas, values, references, worksheets, and revisions remained intact.

## Persistence evidence

- Browser save advanced the isolated workbook through revisions `1` to `8` and reached `已儲存` after every retained mutation.
- A browser reload returned `已儲存` and displayed the formulas' calculated results.
- After restarting only the FastAPI/Uvicorn backend, revision `8` loaded from `.cache/phase1c-runtime/phase1c.db`.
- The post-restart API still returned `公式基準!E1` as `f = =SUM(A1:A5)`, `v = 60`; formulas were not replaced by hard-coded values.
- The post-restart grid visibly retained arithmetic, aggregate, conditional, reference, cross-sheet, fill-adjusted, and error results.

## Exact owner formula test (45 steps)

1. Create or open worksheet: `公式測試`.
2. Enter `A1 = 10`, `A2 = 20`, `A3 = 30`.
3. Enter `B1 = =A1+A2`; confirm `30`.
4. Enter `B2 = =A2-A1`; confirm `10`.
5. Enter `B3 = =A1*A2`; confirm `200`.
6. Enter `B4 = =A2/A1`; confirm `2`.
7. Enter `C1 = =SUM(A1:A3)`; confirm `60`.
8. Enter `C2 = =AVERAGE(A1:A3)`; confirm `20`.
9. Enter `C3 = =MIN(A1:A3)`; confirm `10`.
10. Enter `C4 = =MAX(A1:A3)`; confirm `30`.
11. Enter `C5 = =COUNT(A1:A3)`; confirm `3`.
12. Enter `D1 = =IF(A1>=10,"PASS","FAIL")`; confirm `PASS`.
13. Change `A1` to `5`; confirm `D1` becomes `FAIL`.
14. Confirm formulas depending on `A1` recalculate accordingly.
15. Restore `A1` to `10`.
16. Enter `E1 = =A1`.
17. Copy `E1` to `E2`; inspect formula text and confirm the relative reference adjusts.
18. Enter `F1 = =$A$1`.
19. Copy `F1` to `F2`; confirm formula still references `$A$1`.
20. Enter `G1 = =$A1`.
21. Copy `G1` downward; confirm row changes while column A remains absolute.
22. Enter `H1 = =A$1`.
23. Copy `H1` across; confirm column changes while row 1 remains absolute.
24. Create or use worksheet `資料表`.
25. Enter `資料表!A1 = 100`.
26. Back in `公式測試`, enter a cross-sheet formula referencing `資料表!A1`.
27. Confirm result = `100`.
28. Change `資料表!A1` to `250`.
29. Confirm cross-sheet result changes to `250`.
30. Confirm workbook status becomes `未儲存` after formula/input edits.
31. Click Save.
32. Confirm `儲存中 -> 已儲存`.
33. Refresh browser.
34. Confirm formulas are still formulas, not hard-coded values.
35. Confirm `SUM` / `AVERAGE` / `MIN` / `MAX` / `COUNT` / `IF` results remain correct.
36. Confirm relative/absolute/mixed formulas remain intact.
37. Confirm cross-sheet formula remains intact.
38. Restart only the Tiger-Web-Sheets backend.
39. Reload browser.
40. Confirm the same formula workbook remains correct.
41. Change `A1` again.
42. Confirm dependent formulas recalculate.
43. Confirm status becomes `未儲存`.
44. Save again.
45. Confirm status returns to `已儲存`.

Owner must decide PASS or FAIL.
