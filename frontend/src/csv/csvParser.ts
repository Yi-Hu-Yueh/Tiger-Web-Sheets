export const MAX_CSV_FILE_BYTES = 5 * 1024 * 1024
export const MAX_CSV_CELLS = 250_000
export const CSV_PREVIEW_ROWS = 8

export type CsvTable = {
  rows: string[][]
  rowCount: number
  columnCount: number
}

export class CsvParseError extends Error {}
export class CsvSizeError extends CsvParseError {}

export function parseCsvText(source: string): CsvTable {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  if (!text.length) throw new CsvParseError('CSV 檔案是空的。')

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let closedQuote = false
  let endedWithRecordSeparator = false
  let parsedCells = 0

  const appendField = () => {
    parsedCells += 1
    if (parsedCells > MAX_CSV_CELLS) {
      throw new CsvSizeError(`CSV 超過 ${MAX_CSV_CELLS.toLocaleString('en-US')} 個儲存格的安全限制。`)
    }
    row.push(field)
    field = ''
    closedQuote = false
  }
  const appendRow = () => {
    appendField()
    rows.push(row)
    row = []
    endedWithRecordSeparator = true
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    endedWithRecordSeparator = false

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
          closedQuote = true
        }
      } else {
        field += character
      }
      continue
    }

    if (closedQuote) {
      if (character === ',') {
        appendField()
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1
        appendRow()
      } else {
        throw new CsvParseError('CSV 引號欄位後包含無效字元。')
      }
      continue
    }

    if (character === ',') {
      appendField()
    } else if (character === '"') {
      if (field.length) throw new CsvParseError('CSV 未加引號的欄位中包含無效引號。')
      inQuotes = true
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      appendRow()
    } else {
      field += character
    }
  }

  if (inQuotes) throw new CsvParseError('CSV 包含未結束的引號欄位。')
  if (!endedWithRecordSeparator) appendRow()

  const columnCount = Math.max(0, ...rows.map((values) => values.length))
  if (!rows.some((values) => values.some((value) => value.length > 0))) {
    throw new CsvParseError('CSV 沒有可匯入的資料。')
  }
  if (rows.length * columnCount > MAX_CSV_CELLS) {
    throw new CsvSizeError(`CSV 超過 ${MAX_CSV_CELLS.toLocaleString('en-US')} 個儲存格的安全限制。`)
  }
  const rectangularRows = rows.map((values) => [
    ...values,
    ...Array<string>(columnCount - values.length).fill(''),
  ])
  return { rows: rectangularRows, rowCount: rows.length, columnCount }
}
