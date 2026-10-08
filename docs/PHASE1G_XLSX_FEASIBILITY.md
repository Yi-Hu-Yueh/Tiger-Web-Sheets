# Phase 1G XLSX open-source feasibility

Evaluated 2026-10-08. Result: **PASS for the defined fixture baseline**.
Recommendation: **SELECT_EXCELJS**. The owner may authorize Phase 1G-R1 with
the boundary and production requirements below. This spike adds no XLSX product
UI, application imports, production dependencies, backend endpoints, or autosave.
It does not claim Microsoft Excel visual parity or general OOXML fidelity.

## Starting gate and isolation

The starting branch was `main`, HEAD was
`53ae01735d22d580b2106d013f1d4fb9df2a61cd`, and the working tree was clean.
The previous environment failure was not counted as a compatibility failure.
The retry used approved external execution because local sandbox process setup
continued to fail. All generated files are under `.cache/phase1g-results` and
evaluation dependencies under `.cache/phase1g-deps`; neither is committed.

The test uses in-memory Univer instances, has no HTTP client or database writes,
and starts no runtime server. Before/after SHA-256 comparisons verified the
manual SQLite database and all existing managed workbook files unchanged.
Database hash:
`7c0faf1ad541627294dcf7678011ef44c74dc295818fd55ed3f45d385e9192f3`.

## Current official package audit

The official sources were checked before installation. No commercial package or
service was purchased, installed, or activated.

| Candidate | Tested version | License | Distribution and browser support |
| --- | --- | --- | --- |
| SheetJS CE | 0.20.3 | Apache-2.0 | Official CDN tarball; browser standalone/ESM builds; XLSX read/write |
| ExcelJS | 4.4.0 | MIT | npm `exceljs@4.4.0`; prebundled document-model browser implementation; XLSX read/write |

SheetJS's [official distribution](https://cdn.sheetjs.com/) identifies 0.20.3 and
Apache-2.0. Its [Node installation guide](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
specifies `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; do not substitute
the older npm-registry release. The
[parse options](https://docs.sheetjs.com/docs/api/parse-options/) require
`cellNF` for original number formats and `cellStyles` for styling metadata and
dimensions. CE does not provide the full cell/text styling path described for Pro.

ExcelJS's [package metadata](https://github.com/exceljs/exceljs/blob/v4.4.0/package.json),
[license](https://github.com/exceljs/exceljs/blob/v4.4.0/LICENSE), and
[README](https://github.com/exceljs/exceljs/blob/v4.4.0/README.md) describe the
document-based browser bundle, common styles, formulas with cached results,
merges, and dimensions. Streaming readers/writers are not available in browsers.
ExcelJS does not evaluate formulas itself.

Univer's [official exchange guide](https://docs.univer.ai/guides/sheets/features/import-export)
uses `@univerjs-pro/exchange-client` / `@univerjs-pro/sheets-exchange-client` and a
conversion backend, including snapshot import/export. This is separate from the
installed open-source Univer 1.0.3 packages. The spike uses neither Pro nor that
conversion service.

## Controlled fixture and method

`frontend/scripts/phase1g/check.mjs` constructs one shared XLSX fixture through
ExcelJS and imports the identical bytes through both candidates. The fixture is
generated deterministically in content; ZIP timestamps make the byte hash vary
across executions. Each run records its source hash in `evidence.json`.

The fixture contains:

- `工作表1`: A1=10, A2=20, A3=`SUM(A1:A2)`; B1=`台中公司`;
  C1:C3 are explicit text `00123`, `0912345678`, `01234567`;
  D1=0.25 / `0.00%`; E1=1234.5 / `"NT$"#,##0.00`;
  F1 is the real date 2026-10-08 / `yyyy-mm-dd` (serial 46303).
- A1 uses Calibri 11 bold; B1 solid RGB `#FFF2CC`; C1 thin red bottom border;
  G1 is centered horizontally/vertically with wrapping and merged across G1:H1.
- Row 1 height is 30 points (40 Univer pixels); B width is 24 width units
  (168 pixels using the spike's stated seven-pixel digit-width assumption).
- `資料表`: A1=100; main-sheet I1=`資料表!A1`.
- B5 is literal text `=1+1`, independent of formula cells.

The fixture deliberately caches 999 for both supported formulas. Both import
paths preserve formula text in snapshot `f`, run the actual Univer formula engine,
and export a saved Univer snapshot. An A1 edit tests live recalculation. The
export-only check starts from an independently constructed Tiger snapshot with
the same features, rather than relying only on import/export symmetry.

Both libraries re-read their own generated XLSX. The other candidate also reads
it independently. Python's standard-library ZIP/XML parser additionally asserts
OOXML text types, values, formula text/results, sheet names, style records,
number formats, merges, row height and column width. This distinguishes SheetJS
parser limitations from genuinely missing styles in ExcelJS output.

## Import matrix

PASS means exact preservation of the tested feature. FAIL identifies observed
loss in this adapter/library path; it is not a claim about every library feature.

| Feature | SheetJS CE | ExcelJS |
| --- | --- | --- |
| Scalar values / Chinese | PASS | PASS |
| Leading-zero text / text type | PASS | PASS |
| Formula strings | PASS | PASS |
| Formula references | PASS | PASS |
| Multiple worksheets | PASS | PASS |
| Worksheet names | PASS | PASS |
| Percentage/currency/date formats | PASS | PASS |
| Date serial / date format | PASS | PASS |
| Font name/size/bold | FAIL | PASS |
| Solid RGB fill | PASS | PASS |
| Thin RGB bottom border | FAIL | PASS |
| Center/middle/wrap alignment | FAIL | PASS |
| G1:H1 merged range | PASS | PASS |
| Custom row height | PASS | PASS |
| Custom column width | PASS | PASS |

The same matrix remains true after Univer creation/save. SheetJS row heights
must use `hpt` converted to pixels; preferring its `hpx` field gave an incorrect
30-pixel height in the first probe. The adapter now explicitly uses point units.

## Export and full round-trip matrix

Each status below is the same for export-only and the full
XLSX → Univer → XLSX round trip.

| Feature | SheetJS CE | ExcelJS |
| --- | --- | --- |
| Scalar values / Chinese | PASS | PASS |
| Leading-zero text / text type | PASS | PASS |
| Formula strings | PASS | PASS |
| Formula references | PASS | PASS |
| Multiple worksheets | PASS | PASS |
| Worksheet names | PASS | PASS |
| Percentage/currency/date formats | PASS | PASS |
| Date serial / date format | PASS | PASS |
| Font name/size/bold | FAIL | PASS |
| Solid RGB fill | FAIL | PASS |
| Thin RGB bottom border | FAIL | PASS |
| Center/middle/wrap alignment | FAIL | PASS |
| G1:H1 merged range | PASS | PASS |
| Custom row height | PASS | PASS |
| Custom column width | PASS | PASS |

ExcelJS retains all 15 checked baseline categories through the actual saved
Univer model. Independent OOXML checks confirm common styles exist in its
output. SheetJS independently reads its values, formulas, text, formats, merges,
and dimensions but cannot expose all of those ExcelJS style records.

SheetJS CE loses font name/size/bold, border and alignment on import. On export
it also loses the solid fill, even when common style objects are supplied.
The independent ExcelJS read and OOXML inspection confirm the output losses.
The CE adapter returns an explicit loss warning. No leading-zero conversion or
formula-source loss occurred on either baseline path.

## Formula behavior and date/layout boundaries

After explicit `univerAPI.getFormula().executeCalculation()`, both candidates'
imported formulas return 30 and 100, replacing intentionally stale caches of 999.
Changing A1 to 15 recalculates A3 to 35; resetting it to 10 returns 30. Formula
strings remain `=SUM(A1:A2)` and `=資料表!A1` in the saved model and exported XML.
Merely loading the headless snapshot did not reliably refresh stale caches.
Production import must trigger calculation and wait for completion before export.

An unsupported `TIGER_UNSUPPORTED(A1)` formula retains its source text, discards
its fabricated cache of 123456, emits a limitation warning, and becomes `#NAME?`
in Univer. ExcelJS export/re-read retains the formula. SUM and direct cross-sheet
references are the demonstrated formula baseline. Arithmetic expressions pass
through the adapter but were not separately certified in this fixture.
It does not certify Excel's complete formula catalog, shared/array/spill formulas,
external references, named ranges, or dynamic functions.

Date PASS applies to the explicit 2026-10-08 fixture in the 1900 date system.
1904 normalization code exists but is not certified by this fixture. Early-1900
dates, the fictitious Excel leap day, timezones and date/time formulas need
separate acceptance before expanding the support boundary.

Column width conversion assumes a seven-pixel maximum digit width. Numeric
width units round-trip exactly in this Calibri fixture; fonts, DPI and zoom can
change visual width. Row height uses 96/72 point/pixel conversion. No Excel
visual-parity assertion is made.

## Performance smoke results

Windows host, Node 24.19.0, actual Univer 1.0.3 headless engine. Import times include
ZIP preflight, library parsing and snapshot mapping. Export times include mapping
and XLSX serialization. Separate model times include Univer creation/save/dispose.
These are single-run approximations, not statistically controlled benchmarks.

| Candidate | Cells | Import | Univer model | Export | Heap before/after | RSS after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ExcelJS | 1,000 × 20 | 178 ms | 66 ms | 268 ms | 46 / 121 MiB | 262 MiB |
| SheetJS CE | 1,000 × 20 | 164 ms | 46 ms | 199 ms | 50 / 76 MiB | 271 MiB |
| ExcelJS | 10,000 × 20 | 1,131 ms | 182 ms | 1,705 ms | 45 / 376 MiB | 568 MiB |
| SheetJS CE | 10,000 × 20 | 1,169 ms | 168 ms | 829 ms | 84 / 181 MiB | 541 MiB |

Both sizes completed without exceptions; last-row numeric and leading-zero
values were checked after export/re-read. Memory figures are process samples
after the combined work, not measured peaks, and RSS can retain previous V8
allocations. ExcelJS's 200,000-cell path is feasible on this machine but has
material memory cost. Browser heap/rendering and responsiveness were not measured.
Phase 1G-R1 must use a lazy-loaded worker with cancellation/timeout and measure
the browser before selecting final product limits.

## Candidate comparison

| Dimension | SheetJS CE | ExcelJS |
| --- | --- | --- |
| License | Apache-2.0 | MIT |
| Browser suitability | Standalone/ESM; documented support | Prebundled document model; no browser streaming |
| Tested minified browser bundle | 951,904 bytes / 335,530 gzip | 947,702 bytes / 257,676 gzip |
| Values, formulas, text, sheets/names | Baseline PASS | Baseline PASS |
| Common number formats and dates | Baseline PASS | Baseline PASS |
| Font, border, alignment | Baseline losses | Baseline PASS |
| Fill | Import PASS, export FAIL | Baseline PASS |
| Merges and dimensions | Baseline PASS | Baseline PASS |
| Round-trip stability | Data stable, style losses | All baseline categories stable |
| Conversion complexity | Small value adapter; major added work to close style gaps | Explicit, bounded style/layout mappings demonstrated |
| Important limitations | Richer styling reserved for Pro; no formula evaluation | No formula evaluation; browser memory; conversion coverage still bounded |

Sizes are the installed standalone minified bundles, gzip level default, not a
measured Vite incremental bundle or network transfer. Both dependencies remain
temporary and isolated; neither changes the production build. ExcelJS installation
also emitted deprecated transitive dependency notices, requiring dependency
security review in the production phase. A hybrid adds complexity without solving
a gap in this baseline and is not recommended.

## Security evidence and production requirements

The Node-only spike preflight checks ZIP signature, directory/local-header bounds,
duplicate/traversal paths, required OOXML parts and supported compression. It
rejects encrypted, multi-disk and ZIP64 archives, macros, external relationships,
and DTD/entity XML. Each entry is actually decompressed with an output cap and its
declared expanded length checked before library parsing.

Tested limits are 10 MiB compressed file, 64 MiB total expansion, 16 MiB per entry,
2,048 ZIP entries, maximum 200:1 per-entry expansion ratio, 32 worksheets and
250,000 cells. Snapshot mapping enforces workbook cell count as well as worksheet
rectangle size. Tests reject non-ZIP input, truncated archives, files over 10 MiB,
a compressed repeated-data archive, external-link content, an enormous declared
worksheet range, and malformed workbook XML through both candidate paths.

This is evidence of a viable bounded parsing approach, not a complete security
audit. The Node preflight is not browser-ready product code. Production must
implement equivalent bounded decompression in a worker, validate actual cell
coordinates even when dimensions lie, verify checksums and XML/content types,
handle parser errors without changing the open workbook, and enforce a timeout.
Final limits must be rechecked in desktop browsers. Unsupported features require
pre-import/export warnings or refusal, never silent dropping.

## Proposed first-version support boundary

Proceed with ExcelJS after owner acceptance: plain values and explicit text;
multiple worksheets/names; tested formula strings with Univer-supported
recalculation; common percentage/currency/date patterns; explicit RGB font/fill
and simple borders; basic alignment/wrap; rectangular merges; row heights and
column widths with the stated unit assumptions. Preserve unsupported formula text
with a visible limitation, never invent a successful result.

Explicitly outside the accepted baseline: complete Excel appearance, theme/tint
and gradient/pattern fills, rich-text runs, complex border/alignment effects,
conditional formatting, charts, drawings, images, pivots, tables, named ranges,
validation, protection, print settings, comments/hyperlinks, hidden/outlined
rows/sheets, external links, macros, encrypted files, ZIP64, unsupported date
systems, dynamic/spill formulas and arbitrary Excel functions. Some are library
capabilities, but their Tiger conversions are not certified here. Detect and warn
or refuse such content before any production lossy conversion.

## Reproduction

From the repository root in PowerShell, with the existing project Node on PATH:

```powershell
& .\.tools\node-v24.19.0-win-x64\npm.cmd install --prefix .cache\phase1g-deps --no-save --package-lock=false --ignore-scripts exceljs@4.4.0 https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
& .\.tools\node-v24.19.0-win-x64\node.exe --expose-gc frontend\scripts\phase1g\check.mjs
& D:\python3.11.3\python.exe frontend\scripts\phase1g\xml_check.py
```

The check asserts both candidate versions and emits detailed matrices, timings,
security outcomes and owner-file fingerprints to `.cache/phase1g-results/evidence.json`.
Generated XLSX files are disposable fixtures, not owner data. No test service
connects to the production/manual runtime. Existing frontend dependencies are
required for the headless Univer checks.

Final validation passed: 46 backend tests, existing Phase 1D runtime/Safe Sort,
Phase 1E native-file and Phase 1F CSV checks, independent OOXML assertions,
ESLint, TypeScript and production build. Vite retains its existing large-chunk
warning. The production bundle content and dependency manifests are unchanged.

## Next decision

The open-source baseline is viable with ExcelJS. Phase 1G-R1 may proceed after
owner acceptance, including browser worker integration, native file pickers,
feature-loss confirmation and real-browser/Excel acceptance. Do not begin it
automatically. Production remains at its existing CSV and `.tws.json` workflow.
