import type { IWorkbookData, ICellData } from '@univerjs/core'
import type { createUniver } from '@univerjs/presets'

type API = ReturnType<typeof createUniver>['univerAPI']
export async function recalculateXlsx(api: API, snapshot: IWorkbookData, signal?: AbortSignal) {
  if (!Object.values(snapshot.sheets).some((sheet) => Object.values(sheet.cellData as Record<number, Record<number, ICellData>> ?? {}).some((row) => Object.values(row).some((cell) => cell?.f)))) return
  signal?.throwIfAborted()
  const formula = api.getFormula()
  const applied = formula.onCalculationResultApplied(30_000)
  formula.executeCalculation()
  // Cancel waiting immediately; the normal Tiger formula engine remains owned by
  // Univer, not an orphan XLSX worker. No conversion/export starts after abort.
  await new Promise<void>((resolve, reject) => {
    const abort = () => { reject(new DOMException('已取消 XLSX 處理。', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    applied.then(() => resolve(), reject).finally(() => signal?.removeEventListener('abort', abort))
    if (signal?.aborted) abort()
  })
  signal?.throwIfAborted()
}
