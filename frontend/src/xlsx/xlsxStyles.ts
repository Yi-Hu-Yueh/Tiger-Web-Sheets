import type { IStyleData } from '@univerjs/core'
import type { Style, BorderStyle, Alignment } from 'exceljs'
import { addFinding, type Finding } from './xlsxTypes'

const borders: Record<string, number> = { thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, double: 7, medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, thick: 13 }
const horizontal = { left: 1, center: 2, right: 3 }
const vertical = { top: 1, middle: 2, bottom: 3 }
const sides = { top: 't', right: 'r', bottom: 'b', left: 'l' } as const
const reverse = (record: Record<string, number>, value: number | void | null) => Object.keys(record).find((key) => record[key] === value)
const rgb = (color?: { argb?: string }) => color?.argb && /^[0-9a-f]{8}$/i.test(color.argb) ? `#${color.argb.slice(-6).toUpperCase()}` : undefined
const argb = (color?: { rgb?: string | void | null } | null | void) => color?.rgb && /^#[0-9a-f]{6}$/i.test(color.rgb) ? `FF${color.rgb.slice(1).toUpperCase()}` : undefined

export function styleFromExcel(style: Partial<Style> = {}, findings: Finding[] = []): IStyleData {
  const result: IStyleData = {}
  if (style.numFmt && style.numFmt !== 'General') {
    result.n = { pattern: style.numFmt }
    if (!/^(0(\.0+)?%|"?[^";]*"?#,##0(\.0+)?|yyyy-mm-dd|mm\/dd\/yyyy|0|0\.00|#,##0(\.00)?|@)$/i.test(style.numFmt)) addFinding(findings, 'custom-format', '自訂數字格式文字保留，但顯示不在認證範圍')
  }
  if (style.font?.name) result.ff = style.font.name
  if (style.font?.size) result.fs = style.font.size
  if (style.font?.bold) result.bl = 1
  if (style.font?.italic) result.it = 1
  if (rgb(style.font?.color)) result.cl = { rgb: rgb(style.font?.color)! }
  if (style.font?.underline || style.font?.strike || style.font?.vertAlign) addFinding(findings, 'advanced-font', '底線、刪除線、上/下標等進階字型不會保留')
  if (style.fill?.type === 'pattern' && style.fill.pattern === 'solid' && rgb(style.fill.fgColor)) result.bg = { rgb: rgb(style.fill.fgColor)! }
  else if (style.fill && !(style.fill.type === 'pattern' && style.fill.pattern === 'none')) addFinding(findings, 'fill', '非 RGB 實心填色不會保留')
  for (const [excelSide, tigerSide] of Object.entries(sides)) {
    const border = style.border?.[excelSide as keyof typeof sides]
    if (!border?.style) continue
    if (borders[border.style] && (!border.color || rgb(border.color))) {
      result.bd ??= {}
      result.bd[tigerSide] = { s: borders[border.style], cl: { rgb: rgb(border.color) ?? '#000000' } }
    } else addFinding(findings, 'border', '無法映射的框線不會保留')
  }
  if (style.border?.diagonal) addFinding(findings, 'diagonal', '對角框線不會保留')
  const alignment = style.alignment
  if (alignment?.horizontal && alignment.horizontal in horizontal) result.ht = horizontal[alignment.horizontal as keyof typeof horizontal]
  else if (alignment?.horizontal) addFinding(findings, 'horizontal', '進階水平對齊不會保留')
  if (alignment?.vertical && alignment.vertical in vertical) result.vt = vertical[alignment.vertical as keyof typeof vertical]
  else if (alignment?.vertical) addFinding(findings, 'vertical', '進階垂直對齊不會保留')
  if (alignment?.wrapText) result.tb = 3
  if (alignment?.textRotation || alignment?.indent || alignment?.shrinkToFit || alignment?.readingOrder) addFinding(findings, 'alignment', '旋轉、縮排、縮小文字或閱讀方向不會保留')
  return result
}

export function styleToExcel(input?: IStyleData | null | void): Partial<Style> {
  const style = input || {}
  const result: Partial<Style> = {}
  if (style.n?.pattern) result.numFmt = style.n.pattern
  if (style.ff || style.fs || style.bl || style.it || style.cl) result.font = {
    ...(style.ff ? { name: style.ff } : {}), ...(style.fs ? { size: style.fs } : {}),
    ...(style.bl ? { bold: true } : {}), ...(style.it ? { italic: true } : {}),
    ...(argb(style.cl) ? { color: { argb: argb(style.cl) } } : {}),
  }
  if (argb(style.bg)) result.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(style.bg)! } }
  for (const [excelSide, tigerSide] of Object.entries(sides)) {
    const border = style.bd?.[tigerSide]
    if (border && reverse(borders, border.s)) {
      result.border ??= {}
      result.border[excelSide as keyof typeof sides] = { style: reverse(borders, border.s) as BorderStyle, color: { argb: argb(border.cl) ?? 'FF000000' } }
    }
  }
  if (style.ht || style.vt || style.tb) result.alignment = {
    ...(reverse(horizontal, style.ht) ? { horizontal: reverse(horizontal, style.ht) as Alignment['horizontal'] } : {}),
    ...(reverse(vertical, style.vt) ? { vertical: reverse(vertical, style.vt) as Alignment['vertical'] } : {}),
    ...(style.tb === 3 ? { wrapText: true } : {}),
  }
  return result
}
