# Phase 1G-R1 XLSX exchange

Phase 1G-R1 technical implementation: **PASS**.
Phase 1G-R1 Owner Runtime: **PASS**.

Owner acceptance was recorded on **2026-10-09 (Asia/Taipei)** from the owner's FINAL CLOSURE authorization. The owner manually passed the real desktop Chrome/Edge workflow and Microsoft Excel / Tiger round-trip baseline. This is authoritative owner-reported runtime evidence, separate from automated source/headless checks. The prior Codex `setup refresh had errors` / `trusted Node process exited unexpectedly` failures were execution-environment incidents, not project failures or outstanding closure gates. Browser automation is not rerun for closure.

## Format and workflows

`.tws.json` remains the native Tiger workbook and normal Save format. CSV is single-sheet table exchange. XLSX is a bounded Excel-compatible exchange format, not a full-fidelity Excel document format.

Separate **匯入 XLSX / 匯出 XLSX** actions reuse the existing File System Access picker abstraction. Native Open is still `.tws.json`. Import derives the filename basename, previews sheet names/count, populated-or-styled cell count, and compatibility findings. Only explicit confirmation creates a new UUID workbook; it never overwrites the current workbook. Existing unsaved-navigation protection applies. Imported workbooks are 未儲存, without a bound native file handle.

Export recalculates first, captures one snapshot, then scans it in a worker. A separate confirmation gesture invokes the native Save picker with `<name>.xlsx`. Generation and re-read verification complete before any writable stream opens. The final file is read back byte-for-byte. Export never calls Tiger Save or updates Tiger save status. File/protocol checks cover this separation, and the owner verified that XLSX export preserves Tiger dirty state: an unsaved workbook remains 未儲存.

Native picker cancellation creates no workbook record and performs no write. Worker exceptions, malformed content, permission errors, re-read mismatches and disk errors cannot produce a success message. Processing uses a modal dialog, keeps the rest of the app inert, and provides Cancel. Abort terminates the dedicated worker; completion/error also terminate it. Explicit import confirmation begins the normal non-cancellable backend creation transaction, after parsing and preview are complete. A native writable stream is aborted where possible if cancellation occurs before close. Cancellation during/after the OS close boundary cannot promise removal of an already committed file; no success is announced in that case, and Tiger save state is unchanged. Save pickers themselves may create an empty placeholder depending on browser/OS behavior.

## Architecture and dependencies

- `exceljs` **4.4.0**, pinned production dependency; MIT. No SheetJS or commercial XLSX engine was added.
- `fflate` 0.8.2 and `saxes` 6.0.0 are pinned ZIP/XML validation utilities, not spreadsheet engines.
- `xlsxWorker.ts` owns preflight, ExcelJS parsing/generation, conversion, compatibility inspection and export re-read validation. Progress is posted between phases and during import preflight. Main-thread cancellation forcibly terminates the worker, including synchronous ExcelJS/conversion phases. A 120-second deadline fails closed.
- Vite selects ExcelJS's browser entry. ExcelJS is not imported into App or the initial UI module graph. The production worker asset is approximately **990 kB uncompressed**. Existing initial Univer UI remains large (~6.77 MB uncompressed); no claim of overall small bundle size is made.
- Focused types/security/styles/import/export/compatibility/client/recalculation modules keep conversion out of App.tsx.

Primary references: [ExcelJS](https://github.com/exceljs/exceljs), [fflate](https://github.com/101arrowz/fflate), [saxes](https://github.com/lddubeau/saxes).

## Certified source-level baseline

The controlled fixture runs through production ExcelJS import, actual headless Univer recalculation, production export, ExcelJS re-read, and an independent Python standard-library OOXML verifier. These are source/headless tests, not evidence of browser or Excel visual parity.

| Category | Result |
| --- | --- |
| Scalar values and literal `=1+1` text | PASS |
| Traditional Chinese `台中公司` | PASS |
| Exact text `00123`, `0912345678`, `01234567` | PASS |
| Formula text, same-sheet and cross-sheet references | PASS |
| Multiple worksheets, order and Chinese names | PASS |
| Percentage `0.00%` | PASS |
| Currency `"NT$"#,##0.00` | PASS |
| Date serial 46303 / `yyyy-mm-dd` / 2026-10-08 UTC | PASS |
| Font family/size/bold and RGB font color | PASS |
| Solid RGB fill | PASS |
| Thin RGB border | PASS |
| Horizontal / vertical alignment and wrap | PASS |
| Rectangular merge G1:H1 | PASS |
| Row height 40 px ↔ 30 pt | PASS |
| Column width 168 px ↔ 24 Excel units | PASS |

Row heights use 96/72 px/pt conversion. Column widths use 7 px per Excel digit-width unit: **approximate**, font/DPI dependent. Arbitrary fonts, custom formats and visual layouts are not certified. Date conversion uses UTC milliseconds, never local-time string conversion. ExcelJS handles the source date system; Tiger uses serials in the 1900 system. The modern baseline is tested; dates before March 1900, Excel's fictitious leap day and arbitrary date formats are not certified and receive warnings where detected.

## Formula policy

All XLSX formula caches are discarded, including supported formulas. Formula text is retained with a leading `=`. Tiger explicitly triggers and awaits Univer calculation on imported workbook creation and before export snapshot collection. A calculation timeout fails the workflow rather than exporting cached values.

Actual headless evidence: SUM(A1:A2) with cache 999 computes **30**; cross-sheet `資料表!A1` with cache 999 computes **100**. Editing A1 from 10 to 15 computes **35**. `TIGER_UNSUPPORTED(A1)` with fabricated cache 123456 retains its formula and computes **#NAME?**.

Only SUM and ordinary cell references are certified for exchange. Other function families warn even if Univer can calculate them; this is not a claim that every warned function fails. Unsafe external/structured/active-connection formulas are refused. Formula cells export formula text plus the current result, including Excel error values. Re-read validation checks formulas and caches as well as ordinary values.

## Compatibility boundary

Findings are SUPPORTED / WARNING / UNSUPPORTED. Counts are detected occurrences, not a guaranteed inventory of all Excel objects. Benign findings require explicit continuation and describe loss; dangerous findings refuse import/export.

WARNING / not preserved or not certified:

- Charts, images, pivots, tables (ordinary table cells remain), conditional formatting.
- Named ranges, worksheet/workbook protection, data validation, comments.
- Rich text becomes plain text, hyperlinks are not retained; external hyperlink relationships are refused.
- Theme/indexed colors, gradients/non-solid fills, advanced fonts, diagonal/unmapped borders, advanced alignment/rotation/indent/shrink/reading order.
- Custom formats retain their pattern text without a fidelity claim.
- Print/page/header/footer settings, freeze/split panes, hidden sheets/rows/columns, outlines, source filter state, extensions and arbitrary metadata.
- Tiger plugin resources (including Filter), future/unknown sheet/workbook/cell metadata, default/row/column styles and unmapped Tiger formatting.
- Unsupported functions preserve formula text and receive normal Univer results/errors, never fabricated caches.

UNSUPPORTED / refusal:

- Encryption, non-supported ZIP methods/flags, multi-disk/ZIP64 containers and malformed or suspicious archives/XML.
- Macros/VBA, macro-enabled/binary workbook content, external workbook parts/relationships, embeddings/OLE, ActiveX and custom UI.
- External/structured formula references and DDE/WEBSERVICE/RTD/CALL/REGISTER/HYPERLINK/IMAGE/IMPORTXML/IMPORTDATA active-connection formulas.
- Unexpanded Tiger shared formulas, invalid/duplicate Excel sheet names, no valid worksheet, non-finite values, limits or unsafe coordinates.

No full Excel compatibility, rich-text fidelity, arbitrary metadata preservation, perfect page layout or Microsoft Excel visual parity is claimed. Rare unknown OOXML extensions remain outside certification; scanning is not a malware scanner or exhaustive Excel feature interpreter.

## Security

| Limit | Production value |
| --- | --- |
| Compressed bytes | 10 MiB |
| Total expanded ZIP bytes | 64 MiB |
| Single expanded entry | 16 MiB |
| Entries | 2,048 |
| Entry expansion ratio | 200:1 |
| Worksheets | 32 |
| Populated or styled cells | 250,000 |

Preflight checks signature/EOCD, central and local header consistency, bounds, dangerous/duplicate paths, overlap, permitted flags/methods, actual bounded streaming inflation and CRC. Every XML/rels part is parsed with saxes; DTD/entity declarations are refused. Actual cell/row/column/merge coordinates are checked, not just declared dimensions. Additional allocation limits refuse extremely sparse sheets exceeding 250k rows, 1024 columns or a 1m-cell used bounding rectangle. UTF-8 OOXML is the supported input boundary; other encodings can be refused.

Tests reject all seven hard limits, invalid signature, truncation, malformed XML, DTD, traversal, macro/external parts and relationships, active formulas, sparse coordinates, and export re-read mismatches. Export gets the same archive limits/preflight, so a file Tiger cannot safely reimport is not written.

## Validation and isolation

Final non-browser regression passed: backend tests (46), TypeScript/build, lint, Phase 1D native operations and Safe Sort, Phase 1E local files, Phase 1F CSV, production XLSX unit/security/file/protocol tests, and independent OOXML checks. Protocol-level mocked worker termination remains distinct from the owner's real processing-cancellation acceptance.

Closure safeguard runtime: backend **18291**, frontend **5274**, nonce **phase1gr1-closure-20261009-a1**, database `.cache/isolated-runtimes/phase1gr1-closure-20261009-a1/workbook.db`, managed root alongside it under `workbooks`. Explicit database/root/nonce health identity, canonical DB refusal, manual workbook-root refusal, out-of-cache path refusal, invalid nonce refusal, and occupied-port refusal were checked. Backend tests additionally cover missing explicit database/root/nonce and invalid identity paths. No automated workbook writes were made against production/manual data. Task-owned test processes are stopped after validation; logs/database remain preserved under `.cache`.

The closure-start SHA-256 fingerprint of the manual SQLite DB is `B2CAA63F8E191553E81F86DA571BA3D775E0791DD333ECDDFBE24FA33791535F`. That DB and the complete managed-file name/hash inventory were unchanged during closure. This comparison begins after the owner's manual acceptance; it does not assert that legitimate owner changes before closure never occurred. No owner data, runtime cache, logs, generated XLSX, or build output is committed.

### Owner runtime acceptance — PASS

The owner manually verified:

- XLSX import, compatibility preview, and worksheets `工作表1` / `資料表`.
- SUM, cross-sheet formulas, and formula recalculation after editing.
- Exact leading-zero text; percentage, currency, and date formatting.
- Bold, fill, border, alignment/wrap, merged cells, row height, and column width.
- XLSX export, the native Windows Save picker, and the Microsoft Excel / Tiger round-trip baseline.
- Unsupported-feature warnings; import/export picker cancellation; active processing cancellation; no partial workbook after cancellation.
- XLSX export preserves Tiger dirty state.
- A **10,000 × 20** runtime completed without permanent UI failure.

These observations are attributed to the owner, not to a new Codex browser run. No final owner timing, heartbeat, or memory numbers were supplied, so none are invented.

### Reproducible non-browser checks

```powershell
cd frontend
..\.tools\node-v24.19.0-win-x64\npm.cmd run validate:phase1g-xlsx
D:\0TIGER\6months\PythonAPIDevelopment\venv_multi_query\Scripts\python.exe scripts/phase1g-xlsx-xml-check.py
```

The retained isolated harness `/scripts/phase1g-browser.html` is a diagnostic tool, not a pending closure gate. It was not run during final closure. Any future automated runtime test must use the identity-verified isolated environment, never manual port 5173 or owner data.

Generated, ignored manual artifacts: `.cache/phase1gr1-results/Phase1G-Representative.xlsx`, `Tiger-XLSX-Roundtrip.xlsx`, `evidence.json`. No XLSX binary or generated workbook is intended for Git.

## Performance boundary

**1,000 × 20** is within the tested baseline. **10,000 × 20** completed in owner runtime without permanent UI failure. The Web Worker architecture is required; the main thread still pays snapshot-copy, preview, and Univer-rendering costs. Memory/performance beyond tested sizes is not guaranteed. The 120-second worker deadline and all security/allocation limits remain unchanged. No large-enterprise-sheet or measured throughput/peak-memory claim is made.

## Owner checkpoint

**PASS — owner runtime accepted; closure gate satisfied.** Native dialogs and Excel baseline acceptance were completed by the owner. This does not certify arbitrary Excel workbooks or full visual parity. Do not begin advanced XLSX compatibility automatically.
