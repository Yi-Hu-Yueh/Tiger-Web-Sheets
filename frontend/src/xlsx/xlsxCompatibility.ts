import type { IWorkbookData, IStyleData, ICellData } from '@univerjs/core'
import { addFinding, XLSX_LIMITS as L, type Finding, type Summary } from './xlsxTypes'

export function scanFormula(formula: string, findings: Finding[]) {
  // Ignore function-looking text inside Excel string literals.
  const stripped = formula.replace(/"(?:[^"]|"")*"/g, '""')
  if (/\[[^\]]*\]|(?:https?|file):|\b(?:DDE|WEBSERVICE|RTD|CALL|REGISTER(?:\.ID)?|HYPERLINK|IMAGE|IMPORTXML|IMPORTDATA)\s*\(/i.test(stripped)) addFinding(findings, 'unsafe-formula', '外部 / 結構化 / 主動連線公式不支援', 'UNSUPPORTED')
  else if ([...stripped.matchAll(/([A-Z_][A-Z0-9_.]*)\s*\(/gi)].some((match) => match[1].toUpperCase() !== 'SUM') || /_xlfn\.|[{}]|#(?!REF!|NAME\?|DIV\/0!|VALUE!|N\/A|NUM!|NULL!)/i.test(stripped)) addFinding(findings, 'formula', '公式超出認證範圍（SUM 與一般儲存格參照）；保留文字，由 Tiger 顯示計算結果或錯誤')
  else {
    const remaining = stripped.replace(/'(?:[^']|'')*'!|[\p{L}\p{N}_.]+!/gu, '')
      .replace(/\$?[A-Z]{1,3}\$?\d+|\b(?:SUM|TRUE|FALSE)\b|#(?:REF!|NAME\?|DIV\/0!|VALUE!|N\/A|NUM!|NULL!)/gi, '')
    if (/[\p{L}_]/u.test(remaining)) addFinding(findings, 'formula', '命名或其他非一般儲存格參照公式不在認證範圍；保留文字並由 Tiger 計算')
  }
}
export function inspectSnapshot(snapshot: IWorkbookData): Summary {
  const findings: Finding[] = [], sheets: string[] = []
  let cells = 0
  if (!snapshot.sheetOrder.length || snapshot.sheetOrder.length > L.sheets) throw new Error('XLSX 工作表數必須為 1–32。')
  if (snapshot.resources?.length) addFinding(findings, 'resources', 'Tiger 外掛內容（含篩選、圖片或其他資源）不會保留')
  if (Object.keys(snapshot).some((key) => !['id', 'name', 'appVersion', 'locale', 'styles', 'sheetOrder', 'sheets', 'resources'].includes(key))) addFinding(findings, 'workbook-metadata', '額外活頁簿中繼資料不會保留')
  const supportedStyles = new Set(['ff', 'fs', 'bl', 'it', 'cl', 'bg', 'bd', 'ht', 'vt', 'tb', 'n'])
  const checkStyle = (style?: IStyleData | null | void) => {
    if (!style) return
    if (Object.keys(style).some((key) => !supportedStyles.has(key))) addFinding(findings, 'style', '部分 Tiger 格式不會保留（僅認證基本字型、RGB 色彩、框線、對齊與換行）')
    if (style.tb != null && ![0, 3].includes(style.tb) || style.ht != null && ![0, 1, 2, 3].includes(style.ht) || style.vt != null && ![0, 1, 2, 3].includes(style.vt)) addFinding(findings, 'style-mode', '溢出 / 裁切文字或進階對齊不會保留')
    for (const color of [style.cl, style.bg, ...Object.values(style.bd ?? {}).map((border) => border?.cl)]) if (color && !/^#[0-9a-f]{6}$/i.test(color.rgb ?? '')) addFinding(findings, 'color', '非六位 RGB 色彩不會保留')
    if (Object.values(style.bd ?? {}).some((border) => border && (!border.s || border.s === 12 || border.s > 13))) addFinding(findings, 'border', '進階框線不會保留')
  }
  for (const id of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[id]
    if (!sheet || !sheet.name || sheet.name.length > 31 || /[\\/*?:[\]]/.test(sheet.name) || sheets.includes(sheet.name)) throw new Error('工作表名稱無法安全匯出至 XLSX。')
    sheets.push(sheet.name)
    if (Object.keys(sheet).some((key) => !['id', 'name', 'tabColor', 'hidden', 'freeze', 'rowCount', 'columnCount', 'zoomRatio', 'scrollTop', 'scrollLeft', 'defaultColumnWidth', 'defaultRowHeight', 'mergeData', 'cellData', 'rowData', 'columnData', 'showGridlines', 'rowHeader', 'columnHeader', 'rightToLeft', 'defaultStyle'].includes(key))) addFinding(findings, 'sheet-metadata', '額外工作表中繼資料不會保留')
    if (sheet.tabColor || sheet.rightToLeft) addFinding(findings, 'sheet-appearance', '工作表標籤色彩 / 從右至左版面不會保留')
    if (sheet.hidden || Object.values(sheet.rowData ?? {}).some((data) => data.hd) || Object.values(sheet.columnData ?? {}).some((data) => data.hd)) addFinding(findings, 'hidden', '隱藏工作表 / 列 / 欄狀態不會保留')
    if (Object.values(sheet.freeze ?? {}).some(Boolean)) addFinding(findings, 'freeze', '凍結窗格不會保留')
    for (const [r, row] of Object.entries(sheet.cellData as Record<number, Record<number, ICellData>> ?? {})) for (const [c, cell] of Object.entries(row)) {
      if (!cell) continue
      if (Number(r) < 0 || Number(c) < 0 || Number(r) >= 250_000 || Number(c) >= 1024 || !Number.isInteger(Number(r)) || !Number.isInteger(Number(c))) throw new Error('儲存格座標超過 XLSX 安全配置。')
      if (++cells > L.cells) throw new Error('XLSX 儲存格超過 250,000。')
      if (cell.f) scanFormula(cell.f, findings)
      if (cell.p) addFinding(findings, 'rich-text', '富文字將轉為純文字，文字內格式不會保留')
      if (cell.si) addFinding(findings, 'shared-formula', '未展開的 Tiger 共用公式不支援', 'UNSUPPORTED')
      if (Object.keys(cell).some((key) => !['v', 't', 'f', 's', 'p'].includes(key))) addFinding(findings, 'cell-metadata', '額外儲存格中繼資料不會保留')
      checkStyle(typeof cell.s === 'string' ? snapshot.styles[cell.s] : cell.s ?? undefined)
    }
    checkStyle((typeof sheet.defaultStyle === 'string' ? snapshot.styles[sheet.defaultStyle] : sheet.defaultStyle) ?? undefined)
    if (sheet.defaultStyle || Object.values(sheet.rowData ?? {}).some((data) => data.s) || Object.values(sheet.columnData ?? {}).some((data) => data.s)) addFinding(findings, 'dimension-style', '整列、整欄與工作表預設格式不會保留；儲存格格式保留')
  }
  addFinding(findings, 'baseline', '支援一般值、文字、公式文字、多工作表與認證基本格式；XLSX 是交換格式，非完整 Excel 相容', 'SUPPORTED')
  return { sheets, cells, findings }
}
