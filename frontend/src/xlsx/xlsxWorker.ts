import ExcelJS from 'exceljs'
import { securityPreflight } from './xlsxSecurity'
import { fromExcelJS } from './xlsxImport'
import { toExcelJS, verifyExport } from './xlsxExport'
import { inspectSnapshot } from './xlsxCompatibility'
import { assertAllowed, type WorkerRequest } from './xlsxTypes'

const scope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void; onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null }
const progress = async (message: string) => {
  scope.postMessage({ type: 'progress', message })
  await new Promise((resolve) => setTimeout(resolve, 0))
}
scope.onmessage = async ({ data }) => {
  const started = performance.now()
  try {
    await progress('安全性與相容性檢查中…')
    if (data.operation === 'import') {
      let lastProgress = 0
      const preflight = securityPreflight(data.bytes, (message) => {
        if (performance.now() - lastProgress < 100) return
        lastProgress = performance.now()
        scope.postMessage({ type: 'progress', message })
      })
      await progress('ExcelJS 解析中…')
      const book = new ExcelJS.Workbook()
      await book.xlsx.load(data.bytes)
      await progress('轉換 Tiger 活頁簿中…')
      const result = fromExcelJS(book, data.name, preflight.findings)
      scope.postMessage({ type: 'result', result, elapsedMs: performance.now() - started })
    } else {
      const summary = inspectSnapshot(data.snapshot)
      if (data.operation === 'inspect') {
        scope.postMessage({ type: 'result', result: summary, elapsedMs: performance.now() - started }); return
      }
      assertAllowed(summary)
      await progress('ExcelJS 產生 XLSX 中…')
      const expected = toExcelJS(new ExcelJS.Workbook(), data.snapshot)
      const generated = await expected.xlsx.writeBuffer()
      const bytes = new Uint8Array(generated).slice().buffer
      await progress('重新讀取與驗證 XLSX 中…')
      securityPreflight(bytes)
      const reread = new ExcelJS.Workbook()
      await reread.xlsx.load(bytes)
      verifyExport(expected, reread)
      scope.postMessage({ type: 'result', result: { bytes, summary }, elapsedMs: performance.now() - started }, [bytes])
    }
  } catch (error: unknown) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'XLSX 工作執行失敗（記憶體或解析錯誤）。' })
  }
}
