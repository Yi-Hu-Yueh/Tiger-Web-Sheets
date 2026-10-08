import type { ICellData, IWorkbookData, IWorksheetData } from '@univerjs/core'
import type { Workbook, CellValue } from 'exceljs'
import { scanFormula } from './xlsxCompatibility'
import { styleFromExcel } from './xlsxStyles'
import { decodeRange } from './xlsxSecurity'
import { addFinding, assertAllowed, XLSX_LIMITS as L, type Finding, type ImportResult } from './xlsxTypes'

export function dateSerial(date: Date) {
  const serial = (date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000
  return serial < 61 ? serial - 1 : serial
}
function scalar(value: CellValue): ICellData {
  if (value instanceof Date) return { v: dateSerial(value), t: 2 }
  if (typeof value === 'string') return { v: value, t: 1 }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('XLSX 包含非有限數值，拒絕匯入。')
    return { v: value, t: 2 }
  }
  if (typeof value === 'boolean') return { v: value, t: 3 }
  if (value && typeof value === 'object' && 'error' in value) return { v: value.error, t: 4 }
  if (value && typeof value === 'object' && 'richText' in value) return { v: value.richText.map((run) => run.text).join(''), t: 1 }
  if (value && typeof value === 'object' && 'text' in value) return { v: value.text, t: 1 }
  return { v: null }
}
export function fromExcelJS(book: Workbook, name: string, findings: Finding[] = []): ImportResult {
  if (!book.worksheets.length || book.worksheets.length > L.sheets) throw new Error('XLSX 必須有 1–32 個工作表。')
  const snapshot: IWorkbookData = { id: crypto.randomUUID(), name, appVersion: '1.0.0', locale: 'zhTW' as IWorkbookData['locale'], styles: {}, sheetOrder: [], sheets: {} }
  let cells = 0
  for (const source of book.worksheets) {
    if (source.rowCount > 250_000 || source.columnCount > 1024 || source.rowCount * source.columnCount > 1_000_000) throw new Error('XLSX 稀疏範圍超過安全配置。')
    const id = crypto.randomUUID()
    const sheet: Pick<IWorksheetData, 'id' | 'name' | 'rowCount' | 'columnCount' | 'cellData' | 'mergeData' | 'rowData' | 'columnData'> = { id, name: source.name, rowCount: Math.max(100, source.rowCount), columnCount: Math.max(26, source.columnCount), cellData: {}, mergeData: [], rowData: {}, columnData: {} }
    snapshot.sheetOrder.push(id); snapshot.sheets[id] = sheet
    if (source.state !== 'visible') addFinding(findings, 'hidden', '隱藏工作表會以可見工作表匯入')
    source.eachRow({ includeEmpty: true }, (row, r) => {
      if (row.height) sheet.rowData![r - 1] = { h: row.height * 96 / 72, ia: 0 }
      if (row.hidden || row.outlineLevel) addFinding(findings, 'row-state', '隱藏列 / 大綱不會保留')
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        if (cell.isMerged && cell.master.address !== cell.address) return
        if (cell.value === null && !Object.keys(cell.style).length) return
        if (++cells > L.cells) throw new Error('XLSX 有內容或格式的儲存格超過 250,000。')
        let data: ICellData
        if (cell.formula) {
          const f = `=${cell.formula.replace(/^=/, '')}`
          scanFormula(f, findings)
          data = { f, v: null } // NEVER trust any XLSX formula result, including supported formulas.
        } else {
          if (cell.value instanceof Date && cell.value.getTime() < Date.UTC(1900, 2, 1)) addFinding(findings, 'early-date', '1900 年三月以前日期（含 Excel 虛構閏日）不在認證範圍')
          if (cell.value && typeof cell.value === 'object' && 'richText' in cell.value) addFinding(findings, 'rich-text', '富文字轉為純文字，文字內格式不會保留')
          data = scalar(cell.value)
        }
        const style = styleFromExcel(cell.style, findings)
        if (Object.keys(style).length) data.s = style
        sheet.cellData[r - 1] ??= {}; sheet.cellData[r - 1][c - 1] = data
      })
    })
    source.columns.forEach((column, c) => {
      if (column.width !== undefined) sheet.columnData![c] = { w: column.width * 7 }
      if (column.hidden || column.outlineLevel) addFinding(findings, 'column-state', '隱藏欄 / 大綱不會保留')
    })
    sheet.mergeData = source.model.merges.map(decodeRange)
  }
  addFinding(findings, 'baseline', '認證基本內容保留；公式快取全部丟棄並由 Tiger 重新計算', 'SUPPORTED')
  const summary = { sheets: book.worksheets.map((sheet) => sheet.name), cells, findings }
  assertAllowed(summary)
  return { snapshot, summary }
}
