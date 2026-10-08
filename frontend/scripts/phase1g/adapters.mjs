// Evaluation adapters only: never imported by the Tiger application.
import { randomUUID } from 'node:crypto'

const DAY = 86_400_000
const BASE = Date.UTC(1899, 11, 30)
export const LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, cells: 250_000, sheets: 32 })
export const FORMATS = { percentage: '0.00%', currency: '"NT$"#,##0.00', date: 'yyyy-mm-dd' }
const borders = { thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, double: 7, medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, slantDashDot: 12, thick: 13 }
const horizontal = { left: 1, center: 2, right: 3 }
const vertical = { top: 1, middle: 2, bottom: 3 }
const sides = { top: 't', right: 'r', bottom: 'b', left: 'l' }
const reverse = (record, value) => Object.keys(record).find((key) => record[key] === value)
const rgb = (color) => color?.argb ? `#${color.argb.slice(-6)}` : undefined
const argb = (color) => color?.rgb ? `FF${color.rgb.replace('#', '')}` : undefined
const clone = (value) => JSON.parse(JSON.stringify(value))

export function dateSerial(date) {
  const serial = (date.getTime() - BASE) / DAY
  return serial < 61 ? serial - 1 : serial
}

function styleFromExcel(style = {}) {
  const result = {}
  if (style.numFmt && style.numFmt !== 'General') result.n = { pattern: style.numFmt }
  if (style.font?.name) result.ff = style.font.name
  if (style.font?.size) result.fs = style.font.size
  if (style.font?.bold) result.bl = 1
  if (style.font?.italic) result.it = 1
  if (rgb(style.font?.color)) result.cl = { rgb: rgb(style.font.color) }
  if (style.fill?.type === 'pattern' && style.fill.pattern === 'solid' && rgb(style.fill.fgColor)) result.bg = { rgb: rgb(style.fill.fgColor) }
  for (const [excelSide, tigerSide] of Object.entries(sides)) {
    const border = style.border?.[excelSide]
    if (borders[border?.style] && rgb(border.color)) {
      result.bd ??= {}
      result.bd[tigerSide] = { s: borders[border.style], cl: { rgb: rgb(border.color) } }
    }
  }
  if (horizontal[style.alignment?.horizontal]) result.ht = horizontal[style.alignment.horizontal]
  if (vertical[style.alignment?.vertical]) result.vt = vertical[style.alignment.vertical]
  if (style.alignment?.wrapText) result.tb = 3
  return result
}

function styleToExcel(style = {}) {
  const result = {}
  if (style.n?.pattern) result.numFmt = style.n.pattern
  if (style.ff || style.fs || style.bl || style.it || style.cl) {
    result.font = {
      ...(style.ff ? { name: style.ff } : {}), ...(style.fs ? { size: style.fs } : {}),
      ...(style.bl ? { bold: true } : {}), ...(style.it ? { italic: true } : {}),
      ...(argb(style.cl) ? { color: { argb: argb(style.cl) } } : {}),
    }
  }
  if (argb(style.bg)) result.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(style.bg) } }
  for (const [excelSide, tigerSide] of Object.entries(sides)) {
    const border = style.bd?.[tigerSide]
    if (border && reverse(borders, border.s)) {
      result.border ??= {}
      result.border[excelSide] = { style: reverse(borders, border.s), color: { argb: argb(border.cl) ?? 'FF000000' } }
    }
  }
  if (style.ht || style.vt || style.tb) result.alignment = {
    ...(reverse(horizontal, style.ht) ? { horizontal: reverse(horizontal, style.ht) } : {}),
    ...(reverse(vertical, style.vt) ? { vertical: reverse(vertical, style.vt) } : {}),
    ...(style.tb === 3 ? { wrapText: true } : {}),
  }
  return result
}

function blankSnapshot(name) {
  return { id: randomUUID(), name, appVersion: '1.0.0', locale: 'zhTW', styles: {}, sheetOrder: [], sheets: {} }
}

function addSheet(snapshot, name, rows, columns) {
  if (snapshot.sheetOrder.length >= LIMITS.sheets) throw new Error('Worksheet limit exceeded')
  if (rows * columns > LIMITS.cells) throw new Error('Worksheet rectangle exceeds cell limit')
  const id = `sheet-${snapshot.sheetOrder.length + 1}`
  snapshot.sheetOrder.push(id)
  const sheet = { id, name, rowCount: Math.max(100, rows), columnCount: Math.max(26, columns), cellData: {}, mergeData: [], rowData: {}, columnData: {} }
  snapshot.sheets[id] = sheet
  return sheet
}

function put(sheet, row, column, cell) {
  sheet.cellData[row] ??= {}
  sheet.cellData[row][column] = cell
}

function scalarCell(value) {
  if (value instanceof Date) return { v: dateSerial(value), t: 2 }
  if (typeof value === 'string') return { v: value, t: 1 }
  if (typeof value === 'number') return { v: value, t: 2 }
  if (typeof value === 'boolean') return { v: value, t: 3 }
  if (value?.error) return { v: value.error, t: 4 }
  return { v: null }
}

function formulaCell(formula, cached, warnings) {
  const f = `=${formula.replace(/^=/, '')}`
  const functions = [...f.matchAll(/([A-Z_][A-Z0-9_.]*)\s*\(/gi)].map((match) => match[1].toUpperCase())
  if (functions.some((name) => name !== 'SUM')) {
    warnings.push(`Formula outside tested baseline preserved without trusted cache: ${f}`)
    return { f, v: null }
  }
  return { ...scalarCell(cached), f }
}

export function fromExcelJS(book, name = 'Phase 1G') {
  if (!book.worksheets.length) throw new Error('No usable worksheets')
  const snapshot = blankSnapshot(name)
  const warnings = []
  let totalCells = 0
  for (const source of book.worksheets) {
    const sheet = addSheet(snapshot, source.name, source.rowCount, source.columnCount)
    source.eachRow({ includeEmpty: false }, (row, rowIndex) => {
      if (row.height) sheet.rowData[rowIndex - 1] = { h: row.height * 96 / 72, ia: 0 }
      row.eachCell({ includeEmpty: false }, (cell, columnIndex) => {
        if (cell.isMerged && cell.master.address !== cell.address) return
        if (++totalCells > LIMITS.cells) throw new Error('Workbook cell limit exceeded')
        let data
        if (cell.formula) data = formulaCell(cell.formula, cell.result, warnings)
        else if (cell.value?.richText || cell.value?.hyperlink) throw new Error('Rich text/hyperlink outside spike boundary')
        else data = scalarCell(cell.value)
        const style = styleFromExcel(cell.style)
        if (Object.keys(style).length) data.s = style
        put(sheet, rowIndex - 1, columnIndex - 1, data)
      })
    })
    source.columns.forEach((column, index) => {
      if (column.width !== undefined) sheet.columnData[index] = { w: column.width * 7 }
    })
    for (const address of source.model.merges ?? []) sheet.mergeData.push(decodeRange(address))
  }
  return { snapshot, warnings }
}

export function toExcelJS(ExcelJS, snapshot) {
  const book = new ExcelJS.Workbook()
  book.calcProperties.fullCalcOnLoad = true
  for (const id of snapshot.sheetOrder) {
    const source = snapshot.sheets[id]
    const sheet = book.addWorksheet(source.name)
    for (const [r, row] of Object.entries(source.cellData)) for (const [c, value] of Object.entries(row)) {
      const cell = sheet.getCell(Number(r) + 1, Number(c) + 1)
      cell.value = value.f ? { formula: value.f.slice(1), ...(value.v !== null && value.v !== undefined ? { result: value.t === 4 ? { error: value.v } : value.v } : {}) } : value.v ?? null
      cell.style = styleToExcel(typeof value.s === 'string' ? snapshot.styles[value.s] : value.s)
    }
    for (const [r, data] of Object.entries(source.rowData ?? {})) if (data.h) sheet.getRow(Number(r) + 1).height = data.h * 72 / 96
    for (const [c, data] of Object.entries(source.columnData ?? {})) if (data.w) sheet.getColumn(Number(c) + 1).width = data.w / 7
    for (const merge of source.mergeData ?? []) sheet.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1)
  }
  return book
}

export function decodeRange(address) {
  const decode = (cell) => {
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(cell)
    let column = 0
    for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64
    return { r: Number(row) - 1, c: column - 1 }
  }
  const [start, end = start] = address.split(':').map(decode)
  return { startRow: start.r, endRow: end.r, startColumn: start.c, endColumn: end.c }
}

export function fromSheetJS(XLSX, book, name = 'Phase 1G') {
  if (!book.SheetNames.length) throw new Error('No usable worksheets')
  const snapshot = blankSnapshot(name)
  const warnings = ['SheetJS CE does not preserve the full font/border/alignment baseline; export styling may be lost.']
  let totalCells = 0
  for (const sheetName of book.SheetNames) {
    const source = book.Sheets[sheetName]
    const range = source['!ref'] ? XLSX.utils.decode_range(source['!ref']) : { e: { r: 0, c: 0 } }
    const sheet = addSheet(snapshot, sheetName, range.e.r + 1, range.e.c + 1)
    for (const [address, cell] of Object.entries(source)) {
      if (address.startsWith('!')) continue
      if (++totalCells > LIMITS.cells) throw new Error('Workbook cell limit exceeded')
      const at = XLSX.utils.decode_cell(address)
      if (at.r * (range.e.c + 1) + at.c >= LIMITS.cells) throw new Error('Cell outside safe rectangle')
      const data = cell.f ? formulaCell(cell.f, cell.v, warnings) : scalarCell(cell.v)
      if (book.Workbook?.WBProps?.date1904 && XLSX.SSF.is_date(cell.z ?? '')) data.v += 1462
      const style = {}
      if (cell.z && cell.z !== 'General') style.n = { pattern: cell.z }
      if (cell.s?.patternType === 'solid' && cell.s.fgColor?.rgb) style.bg = { rgb: `#${cell.s.fgColor.rgb.slice(-6)}` }
      if (Object.keys(style).length) data.s = style
      put(sheet, at.r, at.c, data)
    }
    source['!rows']?.forEach((row, index) => {
      if (row?.hpt || row?.hpx) sheet.rowData[index] = { h: row.hpt !== undefined ? row.hpt * 96 / 72 : row.hpx, ia: 0 }
    })
    source['!cols']?.forEach((col, index) => {
      if (col?.width !== undefined) sheet.columnData[index] = { w: col.width * 7 }
    })
    sheet.mergeData = (source['!merges'] ?? []).map((merge) => ({ startRow: merge.s.r, endRow: merge.e.r, startColumn: merge.s.c, endColumn: merge.e.c }))
  }
  return { snapshot, warnings }
}

export function toSheetJS(XLSX, snapshot) {
  const book = XLSX.utils.book_new()
  for (const id of snapshot.sheetOrder) {
    const source = snapshot.sheets[id]
    const sheet = {}
    let lastRow = 0
    let lastColumn = 0
    for (const [r, row] of Object.entries(source.cellData)) for (const [c, value] of Object.entries(row)) {
      const style = typeof value.s === 'string' ? snapshot.styles[value.s] : value.s
      const cell = { t: value.t === 1 ? 's' : value.t === 3 ? 'b' : 'n', v: value.v ?? undefined }
      if (value.f) cell.f = value.f.slice(1)
      if (style?.n?.pattern) cell.z = style.n.pattern
      cell.s = styleToExcel(style) // Deliberately attempted: CE writer ignores these common styles.
      sheet[XLSX.utils.encode_cell({ r: Number(r), c: Number(c) })] = cell
      lastRow = Math.max(lastRow, Number(r)); lastColumn = Math.max(lastColumn, Number(c))
    }
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastColumn } })
    sheet['!merges'] = (source.mergeData ?? []).map((merge) => ({ s: { r: merge.startRow, c: merge.startColumn }, e: { r: merge.endRow, c: merge.endColumn } }))
    sheet['!rows'] = []
    sheet['!cols'] = []
    for (const [r, data] of Object.entries(source.rowData ?? {})) if (data.h) sheet['!rows'][Number(r)] = { hpt: data.h * 72 / 96 }
    for (const [c, data] of Object.entries(source.columnData ?? {})) if (data.w) sheet['!cols'][Number(c)] = { width: data.w / 7 }
    XLSX.utils.book_append_sheet(book, sheet, source.name)
  }
  return book
}

export function baselineSnapshot() {
  const snapshot = blankSnapshot('Phase 1G baseline')
  const sheet = addSheet(snapshot, '工作表1', 5, 9)
  put(sheet, 0, 0, { v: 10, t: 2, s: { ff: 'Calibri', fs: 11, bl: 1 } })
  put(sheet, 1, 0, { v: 20, t: 2 })
  put(sheet, 2, 0, { f: '=SUM(A1:A2)', v: 999, t: 2 }) // Intentionally stale, recalculation must fix it.
  put(sheet, 0, 1, { v: '台中公司', t: 1, s: { bg: { rgb: '#FFF2CC' } } })
  put(sheet, 0, 2, { v: '00123', t: 1, s: { bd: { b: { s: 1, cl: { rgb: '#FF0000' } } } } })
  put(sheet, 1, 2, { v: '0912345678', t: 1 })
  put(sheet, 2, 2, { v: '01234567', t: 1 })
  put(sheet, 0, 3, { v: 0.25, t: 2, s: { n: { pattern: FORMATS.percentage } } })
  put(sheet, 0, 4, { v: 1234.5, t: 2, s: { n: { pattern: FORMATS.currency } } })
  put(sheet, 0, 5, { v: dateSerial(new Date('2026-10-08T00:00:00Z')), t: 2, s: { n: { pattern: FORMATS.date } } })
  put(sheet, 0, 6, { v: '合併標題', t: 1, s: { ht: 2, vt: 2, tb: 3 } })
  put(sheet, 0, 8, { f: '=資料表!A1', v: 999, t: 2 })
  put(sheet, 4, 1, { v: '=1+1', t: 1 })
  sheet.mergeData = [{ startRow: 0, endRow: 0, startColumn: 6, endColumn: 7 }]
  sheet.rowData[0] = { h: 40, ia: 0 }
  sheet.columnData[1] = { w: 168 }
  const second = addSheet(snapshot, '資料表', 1, 1)
  put(second, 0, 0, { v: 100, t: 2 })
  return snapshot
}

export function normalizedFeatures(snapshot) {
  const sheets = snapshot.sheetOrder.map((id) => snapshot.sheets[id])
  const main = sheets[0]
  const cell = (r, c) => main.cellData[r]?.[c] ?? {}
  const style = (r, c) => typeof cell(r, c).s === 'string' ? snapshot.styles[cell(r, c).s] : cell(r, c).s ?? {}
  return {
    values: [cell(0, 0).v, cell(1, 0).v, cell(0, 1).v, cell(0, 3).v, cell(0, 4).v, sheets[1]?.cellData[0]?.[0]?.v, cell(4, 1).v],
    leadingZeros: [cell(0, 2), cell(1, 2), cell(2, 2)].map((data) => [data.v, data.t]),
    formulas: [cell(2, 0).f, cell(0, 8).f], formulaReferences: [cell(2, 0).f, cell(0, 8).f],
    worksheets: sheets.length, names: sheets.map((sheet) => sheet.name),
    numberFormats: [style(0, 3).n?.pattern, style(0, 4).n?.pattern, style(0, 5).n?.pattern],
    dates: cell(0, 5).v, font: [style(0, 0).ff, style(0, 0).fs, style(0, 0).bl],
    fill: style(0, 1).bg?.rgb, borders: style(0, 2).bd?.b,
    alignment: [style(0, 6).ht, style(0, 6).vt, style(0, 6).tb],
    merge: clone(main.mergeData), rowHeight: main.rowData[0]?.h, columnWidth: main.columnData[1]?.w,
  }
}
