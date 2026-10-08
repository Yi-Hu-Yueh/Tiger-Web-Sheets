# Phase 1F CSV import and export

CSV support is an exchange workflow. Tiger's complete native workbook format remains `.tws.json`.

## Import

**匯入 CSV** calls the browser's native `showOpenFilePicker()` directly from a user action and advertises `text/csv` / `.csv`. Cancellation changes nothing. Tiger reads only UTF-8, accepts an optional UTF-8 BOM, and rejects undecodable input instead of displaying mojibake.

The internal parser supports comma delimiters, CRLF and LF records, quoted commas, escaped double quotes, embedded newlines, empty fields, trailing empty fields, and meaningful blank rows. It rejects malformed quotes, empty/no-data input, files larger than 5 MiB, and tables larger than 250,000 rectangular cells.

Before creating anything, Tiger shows the browser-exposed filename, row count, column count, and the first eight rows. Confirmation creates a new internal Tiger workbook with one sanitized worksheet; the previously open workbook is not overwritten. The imported workbook is **未儲存** until the owner uses the normal Tiger Save flow to choose a `.tws.json` file.

Every CSV field is imported as text. Numeric-looking identifiers such as `0912345678`, `01234567`, and `00123` retain their leading zeros. A field such as `=1+1` remains literal text and is not executed as a Tiger formula.

## Export

**匯出 CSV** calls `showSaveFilePicker()` and suggests `<worksheet-name>.csv`. A one-sheet workbook exports that sheet directly. A multi-sheet workbook first requires an explicit worksheet choice; Tiger never concatenates worksheets.

Tiger finds the last cell containing a value, formula, or rich-text value and exports only that meaningful rectangle. Internal empty cells and explicitly imported trailing empty fields inside that rectangle are retained; formatting-only trailing cells do not expand the export.

Export uses Univer's displayed/calculated values. Formula results are exported as values, not formula source strings. Every field is quoted and embedded quotes are doubled. Records use CRLF and output begins with a UTF-8 BOM. Tiger's own export/import round trip preserves Traditional Chinese, leading zeros, commas, quotes, newlines, empty cells, and row relationships.

Export is not Save. A dirty Tiger workbook remains **未儲存** after CSV export, and a saved workbook's state is likewise unchanged. Picker cancellation and write failure do not alter the workbook.

## CSV limitations

CSV contains one table and cannot preserve multiple worksheets, Tiger formulas, formatting, merged cells, freeze state, row height, column width, filters, charts, or workbook metadata. Third-party spreadsheet applications may apply their own type inference when opening CSV; Tiger guarantees exact leading-zero preservation in its own CSV round trip. No delimiter detection, TSV product workflow, legacy encoding support, XLS, or XLSX is included.
