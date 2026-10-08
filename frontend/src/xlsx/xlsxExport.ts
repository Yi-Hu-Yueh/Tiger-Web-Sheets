import type { IWorkbookData, ICellData } from '@univerjs/core'
import type { Workbook, CellValue } from 'exceljs'
import { styleToExcel } from './xlsxStyles'

export function toExcelJS(book: Workbook, snapshot: IWorkbookData) {
  book.calcProperties.fullCalcOnLoad = true
  for (const id of snapshot.sheetOrder) {
    const source = snapshot.sheets[id], sheet = book.addWorksheet(source.name)
    for (const [r, row] of Object.entries(source.cellData as Record<number, Record<number, ICellData>> ?? {})) for (const [c, value] of Object.entries(row)) {
      if (!value) continue
      const cell = sheet.getCell(Number(r) + 1, Number(c) + 1)
      const text = value.p?.body?.dataStream?.replace(/\r\n$/, '')
      cell.value = value.f ? { formula: value.f.replace(/^=/, ''), ...(value.v !== null && value.v !== undefined ? { result: value.t === 4 ? { error: value.v } : value.v } : {}) } as CellValue
        : text ?? (value.t === 4 ? { error: value.v } : value.v ?? null) as CellValue
      cell.style = styleToExcel(typeof value.s === 'string' ? snapshot.styles[value.s] : value.s ?? undefined)
    }
    for (const [r, data] of Object.entries(source.rowData ?? {})) if (data.h) sheet.getRow(Number(r) + 1).height = data.h * 72 / 96
    for (const [c, data] of Object.entries(source.columnData ?? {})) if (data.w) sheet.getColumn(Number(c) + 1).width = data.w / 7
    for (const merge of source.mergeData ?? []) sheet.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1)
  }
  return book
}

/** Compare the generated/re-read Excel model to the intended model, not just the ZIP signature. */
export function verifyExport(expected: Workbook, actual: Workbook) {
  const fail = (location = '工作表結構') => { throw new Error(`XLSX 匯出重新讀取驗證失敗（${location}）；不會寫入檔案。`) }
  if (expected.worksheets.length !== actual.worksheets.length) fail()
  expected.worksheets.forEach((sheet, i) => {
    const reread = actual.worksheets[i]
    if (sheet.name !== reread.name || JSON.stringify(sheet.model.merges) !== JSON.stringify(reread.model.merges)) fail()
    sheet.eachRow({ includeEmpty: true }, (row, r) => {
      const other = reread.getRow(r)
      if (row.height !== other.height) fail(`${sheet.name}!列 ${r} 高度`)
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const otherCell = other.getCell(c)
        // ExcelJS normalizes dates to UTC Date on reload. Use numeric serial comparison.
        const normalize = (value: unknown): unknown => {
          if (value instanceof Date) {
            const serial = (value.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000
            return serial < 61 ? serial - 1 : serial
          }
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]))
          return value
        }
        if (JSON.stringify(normalize(cell.value)) !== JSON.stringify(normalize(otherCell.value))) fail(`${sheet.name}!${cell.address} 值：${JSON.stringify(cell.value)} / ${JSON.stringify(otherCell.value)}`)
        for (const key of ['numFmt', 'font', 'fill', 'border', 'alignment'] as const) {
          const normalizedStyle = (style: Partial<import('exceljs').Style>) => {
            const value = style[key]
            if (key === 'numFmt' && value === 'General') return undefined
            if (key === 'fill' && style.fill?.type === 'pattern' && style.fill.pattern === 'none') return undefined
            // ExcelJS adds its known default font to format-only cells on reload.
            // This is not a loss of an explicitly supplied font.
            if (key === 'font' && style.font?.name === 'Calibri' && style.font.size === 11 && style.font.family === 2 && style.font.scheme === 'minor' && style.font.color?.theme === 1 && Object.keys(style.font).every((field) => ['name', 'size', 'family', 'scheme', 'color'].includes(field))) return undefined
            if (value && typeof value === 'object' && !Object.keys(value).length) return undefined
            return value
          }
          const canonical = (value: unknown): string => {
            if (!value || typeof value !== 'object') return JSON.stringify(value ?? null)
            return JSON.stringify(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
          }
          if (canonical(normalizedStyle(cell.style)) !== canonical(normalizedStyle(otherCell.style))) fail(`${sheet.name}!${cell.address} ${key}：${canonical(cell.style[key])} / ${canonical(otherCell.style[key])}`)
        }
      })
    })
    sheet.columns.forEach((column, c) => { if (column.width !== undefined && Math.abs(column.width - (reread.getColumn(c + 1).width ?? 0)) > 0.001) fail() })
  })
}
