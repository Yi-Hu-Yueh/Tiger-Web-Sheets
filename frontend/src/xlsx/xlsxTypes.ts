import type { IWorkbookData } from '@univerjs/core'

export const XLSX_LIMITS = Object.freeze({
  compressed: 10 * 1024 * 1024, expanded: 64 * 1024 * 1024,
  entry: 16 * 1024 * 1024, entries: 2048, ratio: 200, sheets: 32, cells: 250_000,
})
export type Finding = { code: string; level: 'SUPPORTED' | 'WARNING' | 'UNSUPPORTED'; message: string; count: number }
export type Summary = { sheets: string[]; cells: number; findings: Finding[] }
export type ImportResult = { snapshot: IWorkbookData; summary: Summary }
export type ExportResult = { bytes: ArrayBuffer; summary: Summary }
export type WorkerRequest =
  | { operation: 'import'; bytes: ArrayBuffer; name: string }
  | { operation: 'inspect'; snapshot: IWorkbookData }
  | { operation: 'export'; snapshot: IWorkbookData }
export type WorkerResult = ImportResult | ExportResult | Summary
export function addFinding(findings: Finding[], code: string, message: string, level: Finding['level'] = 'WARNING') {
  const existing = findings.find((finding) => finding.code === code)
  if (existing) existing.count++
  else findings.push({ code, level, message, count: 1 })
}
export function assertAllowed(summary: Summary) {
  const refused = summary.findings.filter((finding) => finding.level === 'UNSUPPORTED')
  if (refused.length) throw new Error(`拒絕 XLSX：${refused.map((finding) => finding.message).join('；')}`)
}
