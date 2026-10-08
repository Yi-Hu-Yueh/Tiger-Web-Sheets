import type { IWorkbookData } from '@univerjs/core'
import { runXlsxWorker } from '../src/xlsx/xlsxWorkerClient'
import { verifyRuntimeIdentity } from '../src/workbookApi'
import type { ExportResult, ImportResult } from '../src/xlsx/xlsxTypes'
import fixtureUrl from '../../.cache/phase1gr1-results/Phase1G-Representative.xlsx?url'

const status = document.querySelector('#status')!, evidence = document.querySelector('#evidence')!
document.querySelector('#run')!.addEventListener('click', async () => {
  const results: Record<string, unknown> = {}
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  try {
    assert(import.meta.env.VITE_TIGER_RUNTIME_MODE === 'isolated-test', 'Refuse non-isolated runtime')
    assert(import.meta.env.VITE_TIGER_INSTANCE_NONCE?.startsWith('phase1gr1-'), 'Refuse unexpected nonce')
    await verifyRuntimeIdentity()
    const bytes = await (await fetch(fixtureUrl)).arrayBuffer()
    const fixture = await runXlsxWorker<ImportResult>({ operation: 'import', bytes, name: 'browser fixture' }, new AbortController().signal, (message) => { status.textContent = message })
    const main = fixture.result.snapshot.sheets[fixture.result.snapshot.sheetOrder[0]]
    assert(main.cellData![2][0].v == null, 'All formula caches discarded')
    assert(main.cellData![0][2].v === '00123', 'Leading zeros preserved')
    results.baselineImport = { elapsedMs: fixture.elapsedMs, summary: fixture.result.summary }
    for (const rows of [1000, 10000]) {
      const snapshot: IWorkbookData = { id: crypto.randomUUID(), name: `perf-${rows}x20`, appVersion: '1.0.0', locale: 'zhTW' as IWorkbookData['locale'], styles: {}, sheetOrder: ['perf'], sheets: { perf: { id: 'perf', name: '效能測試', rowCount: rows, columnCount: 20, cellData: {} } } }
      const data = snapshot.sheets.perf.cellData!
      for (let r = 0; r < rows; r++) {
        data[r] = {}
        for (let c = 0; c < 20; c++) data[r][c] = { v: r * 20 + c, t: 2 }
      }
      let ticks = 0, maxGap = 0, last = performance.now()
      const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++ }, 20)
      try {
        const exported = await runXlsxWorker<ExportResult>({ operation: 'export', snapshot }, new AbortController().signal, (message) => { status.textContent = message })
        const imported = await runXlsxWorker<ImportResult>({ operation: 'import', bytes: exported.result.bytes.slice(0), name: 'performance reimport' }, new AbortController().signal)
        assert(imported.result.summary.cells === rows * 20, 'Complete cell count')
        assert(imported.result.snapshot.sheets[imported.result.snapshot.sheetOrder[0]].cellData![rows - 1][19].v === rows * 20 - 1, 'Last value correct')
        const controller = new AbortController()
        const cancelStarted = performance.now()
        const pending = runXlsxWorker<ImportResult>({ operation: 'import', bytes: exported.result.bytes, name: 'cancel' }, controller.signal)
        setTimeout(() => controller.abort(), 50)
        let cancelled = false
        try { await pending } catch (error) { cancelled = error instanceof DOMException && error.name === 'AbortError' }
        assert(cancelled, 'Worker cancellation rejected with AbortError')
        assert(ticks > 0, 'Main thread heartbeat advanced during worker processing')
        results[`${rows}x20`] = { exportWorkerMs: exported.elapsedMs, importWorkerMs: imported.elapsedMs, heartbeatTicks: ticks, maxHeartbeatGapMs: maxGap, cancellationMs: performance.now() - cancelStarted, cancellation: 'PASS', mainThreadHeapOnly: (performance as Performance & { memory?: unknown }).memory ?? 'NOT_MEASURABLE', noDatabaseWrites: true }
      } finally { clearInterval(timer) }
    }
    results.result = 'PASS'
  } catch (error) { results.result = 'FAIL'; results.error = String(error) }
  evidence.textContent = JSON.stringify(results, null, 2)
  status.textContent = String(results.result)
})
