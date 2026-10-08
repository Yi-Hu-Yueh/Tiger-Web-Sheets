import type { WorkerRequest, WorkerResult } from './xlsxTypes'

export function runXlsxWorker<T extends WorkerResult>(request: WorkerRequest, signal: AbortSignal, progress: (message: string) => void = () => {}): Promise<{ result: T; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('已取消 XLSX 處理。', 'AbortError')); return }
    const worker = new Worker(new URL('./xlsxWorker.ts', import.meta.url), { type: 'module' })
    const finish = () => { worker.terminate(); signal.removeEventListener('abort', cancel); clearTimeout(timeout) }
    const cancel = () => { finish(); reject(new DOMException('已取消 XLSX 處理。', 'AbortError')) }
    const timeout = setTimeout(() => { finish(); reject(new Error('XLSX 處理超過 120 秒，已停止。')) }, 120_000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.onerror = () => { finish(); reject(new Error('XLSX Worker 發生錯誤，已停止處理。')) }
    worker.onmessageerror = () => { finish(); reject(new Error('XLSX Worker 資料傳輸失敗。')) }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress(data.message)
      else if (data.type === 'error') { finish(); reject(new Error(data.message)) }
      else if (data.type === 'result') { finish(); resolve({ result: data.result as T, elapsedMs: data.elapsedMs }) }
    }
    worker.postMessage(request, request.operation === 'import' ? [request.bytes] : [])
  })
}
