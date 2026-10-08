import { CellValueType, LocaleType, type ICellData, type IWorkbookData } from '@univerjs/core'

export const CSV_BOM = '\uFEFF'
export const CSV_RECORD_SEPARATOR = '\r\n'

export type CsvUsedRange = {
  rowCount: number
  columnCount: number
}

type CsvDisplayWorksheet = {
  getRange: (row: number, column: number, rowCount: number, columnCount: number) => {
    getDisplayValues: () => string[][]
  }
}

export function serializeCsv(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
    .join(CSV_RECORD_SEPARATOR)
  return `${CSV_BOM}${body}${CSV_RECORD_SEPARATOR}`
}

export function csvNameFromFilename(filename: string): string {
  const name = filename.toLowerCase().endsWith('.csv') ? filename.slice(0, -4) : filename
  return name.trim() || 'CSV 匯入'
}

export function sanitizeCsvSheetName(name: string): string {
  const sanitized = name.replace(/[\\/?*:[\]]/g, ' ').replace(/^'+|'+$/g, '').trim()
  return sanitized.slice(0, 31) || 'CSV 資料'
}

export function suggestedCsvFilename(sheetName: string): string {
  const safe = sheetName.trim().replace(/[\\/:*?"<>|]/g, '_') || '工作表'
  return safe.toLowerCase().endsWith('.csv') ? safe : `${safe}.csv`
}

export function createCsvWorkbookSnapshot(
  workbookName: string,
  sheetName: string,
  rows: readonly (readonly string[])[],
): IWorkbookData {
  const sheetId = 'sheet-01'
  const cellData: Record<number, Record<number, ICellData>> = {}
  rows.forEach((values, rowIndex) => {
    cellData[rowIndex] = {}
    values.forEach((value, columnIndex) => {
      cellData[rowIndex][columnIndex] = { v: value, t: CellValueType.STRING }
    })
  })
  return {
    id: crypto.randomUUID(),
    name: workbookName,
    appVersion: '1.0.0',
    locale: LocaleType.ZH_TW,
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: sanitizeCsvSheetName(sheetName),
        rowCount: Math.max(100, rows.length),
        columnCount: Math.max(26, ...rows.map((values) => values.length)),
        cellData,
      },
    },
  }
}

export function meaningfulCsvRange(cellData: unknown): CsvUsedRange | null {
  if (typeof cellData !== 'object' || cellData === null) return null
  let lastRow = -1
  let lastColumn = -1
  for (const [rowKey, rowValue] of Object.entries(cellData)) {
    if (typeof rowValue !== 'object' || rowValue === null) continue
    const rowIndex = Number(rowKey)
    if (!Number.isInteger(rowIndex) || rowIndex < 0) continue
    for (const [columnKey, cellValue] of Object.entries(rowValue)) {
      if (typeof cellValue !== 'object' || cellValue === null) continue
      const cell = cellValue as Record<string, unknown>
      const hasValue = 'v' in cell && cell.v !== null && cell.v !== undefined
      const hasFormula = typeof cell.f === 'string' && cell.f.length > 0
      const hasRichText = cell.p !== null && cell.p !== undefined
      if (!hasValue && !hasFormula && !hasRichText) continue
      const columnIndex = Number(columnKey)
      if (!Number.isInteger(columnIndex) || columnIndex < 0) continue
      lastRow = Math.max(lastRow, rowIndex)
      lastColumn = Math.max(lastColumn, columnIndex)
    }
  }
  return lastRow < 0 || lastColumn < 0
    ? null
    : { rowCount: lastRow + 1, columnCount: lastColumn + 1 }
}

export function csvRowsForWorksheet(
  sheet: CsvDisplayWorksheet,
  cellData: unknown,
): string[][] | null {
  const usedRange = meaningfulCsvRange(cellData)
  return usedRange
    ? sheet.getRange(0, 0, usedRange.rowCount, usedRange.columnCount).getDisplayValues()
    : null
}
