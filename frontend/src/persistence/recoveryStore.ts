import type { IWorkbookData } from '@univerjs/core'
import type { PersistedWorkbook } from '../workbookApi'

export const RECOVERY_LIMITS = { bytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, workbooks: 32, age: 7 * 24 * 60 * 60 * 1_000 }
export type RecoveryCheckpoint = {
  workbookId: string; baseRevision: number; baseUpdatedAt: string; timestamp: number
  sessionId: string; generation: number; snapshot: IWorkbookData; bytes: number
}
type RecoveryBudget = Pick<RecoveryCheckpoint, 'workbookId' | 'timestamp' | 'bytes'>
export function validCheckpoint(value: unknown): value is RecoveryCheckpoint {
  if (!value || typeof value !== 'object') return false
  const item = value as RecoveryCheckpoint
  return typeof item.workbookId === 'string' && !!item.workbookId && Number.isInteger(item.baseRevision) && item.baseRevision > 0 &&
    typeof item.baseUpdatedAt === 'string' && Number.isFinite(Date.parse(item.baseUpdatedAt)) &&
    Number.isFinite(item.timestamp) && typeof item.sessionId === 'string' && Number.isInteger(item.generation) && item.generation >= 0 &&
    Number.isInteger(item.bytes) && item.bytes > 0 && item.bytes <= RECOVERY_LIMITS.bytes &&
    !!item.snapshot && typeof item.snapshot.id === 'string' && typeof item.snapshot.name === 'string' &&
    Array.isArray(item.snapshot.sheetOrder) && item.snapshot.sheetOrder.length > 0 && !!item.snapshot.sheets && !!item.snapshot.styles &&
    item.snapshot.sheetOrder.every((id) => !!item.snapshot.sheets[id])
}
export function recoveryDisposition(record: RecoveryCheckpoint | null, committed: PersistedWorkbook, now = Date.now()): 'none' | 'restore' | 'conflict' {
  if (!record || !validCheckpoint(record) || record.workbookId !== committed.id || now - record.timestamp > RECOVERY_LIMITS.age) return 'none'
  // A matching snapshot is already committed, regardless of browser clock skew.
  if (JSON.stringify(record.snapshot) === JSON.stringify(committed.snapshot)) return 'none'
  if (record.baseRevision !== committed.revision || record.baseUpdatedAt !== committed.updated_at) return 'conflict'
  return 'restore'
}

/** Latest checkpoint per workbook; transactions resolve ONLY on IDB commit. */
export class RecoveryStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly namespace: string, private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}
  private async open(): Promise<IDBDatabase> {
    if (!this.factory) throw new Error('此瀏覽器無法使用 IndexedDB；本機復原未寫入，請手動儲存。')
    return new Promise((resolve, reject) => {
      let failed = false
      const request = this.factory!.open(`tiger-web-sheets-recovery-${this.namespace}`, 2)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('checkpoints')) request.result.createObjectStore('checkpoints', { keyPath: 'workbookId' })
        if (!request.result.objectStoreNames.contains('budgets')) {
          const budgets = request.result.createObjectStore('budgets', { keyPath: 'workbookId' })
          // Upgrade any early local checkpoints once, not on each typing checkpoint.
          const cursor = request.transaction!.objectStore('checkpoints').openCursor()
          cursor.onsuccess = () => {
            if (!cursor.result) return
            const item = cursor.result.value as RecoveryCheckpoint
            budgets.put({ workbookId: item.workbookId, timestamp: item.timestamp, bytes: item.bytes })
            cursor.result.continue()
          }
        }
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        if (failed) request.result.close()
        else resolve(request.result)
      }
      request.onerror = () => { failed = true; reject(request.error ?? new Error('無法開啟復原儲存區。')) }
      request.onblocked = () => { failed = true; reject(new Error('復原儲存區被其他視窗阻擋。')) }
    })
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action)
    this.queue = pending.catch(() => {})
    return pending
  }
  private async transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void, budgets: IDBObjectStore) => void): Promise<T> {
    const database = await this.open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(['checkpoints', 'budgets'], mode)
        let value: T
        transaction.oncomplete = () => resolve(value)
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('本機復原寫入失敗（容量或儲存區錯誤）。'))
        try { run(transaction.objectStore('checkpoints'), (result) => { value = result }, transaction.objectStore('budgets')) }
        catch (error) { transaction.abort(); reject(error) }
      })
    } finally { database.close() }
  }
  read(workbookId: string): Promise<RecoveryCheckpoint | null> {
    return this.serial(() => this.transaction('readonly', (store, result) => {
      const request = store.get(workbookId)
      request.onsuccess = () => result(validCheckpoint(request.result) ? request.result : null)
    }))
  }
  write(input: Omit<RecoveryCheckpoint, 'bytes'>): Promise<void> {
    // Capture/clone before queueing, not after later workbook mutations.
    const record = structuredClone({ ...input, bytes: new TextEncoder().encode(JSON.stringify(input.snapshot)).byteLength })
    if (!validCheckpoint(record)) return Promise.reject(new Error('復原快照無效或超過 16 MiB；請立即手動儲存。'))
    return this.serial(() => this.transaction<void>('readwrite', (store, result, budgets) => {
      // Read only tiny budgets, never every other workbook's full snapshot.
      const request = budgets.getAll()
      request.onsuccess = () => {
        const retained: RecoveryBudget[] = []
        for (const item of request.result as RecoveryBudget[]) {
          if (!Number.isFinite(item.timestamp) || !Number.isInteger(item.bytes) || item.bytes < 1 || Date.now() - item.timestamp > RECOVERY_LIMITS.age) {
            store.delete(item.workbookId); budgets.delete(item.workbookId)
          }
          else if (item.workbookId !== record.workbookId) retained.push(item)
        }
        if (retained.length >= RECOVERY_LIMITS.workbooks || retained.reduce((total, item) => total + item.bytes, record.bytes) > RECOVERY_LIMITS.totalBytes) {
          store.transaction.abort(); return
        }
        store.put(record); budgets.put({ workbookId: record.workbookId, timestamp: record.timestamp, bytes: record.bytes }); result(undefined)
      }
    }))
  }
  remove(workbookId: string): Promise<void> {
    return this.serial(() => this.transaction<void>('readwrite', (store, result, budgets) => { store.delete(workbookId); budgets.delete(workbookId); result(undefined) }))
  }
  acknowledge(workbookId: string, sessionId: string, generation: number): Promise<void> {
    return this.serial(() => this.transaction<void>('readwrite', (store, result, budgets) => {
      const request = store.get(workbookId)
      request.onsuccess = () => {
        const item = request.result as RecoveryCheckpoint | undefined
        if (item?.sessionId === sessionId && item.generation <= generation) { store.delete(workbookId); budgets.delete(workbookId) }
        result(undefined)
      }
    }))
  }
}

// Browser origins isolate storage naturally; the test nonce also isolates local records.
export const recoveryStore = new RecoveryStore(import.meta.env.VITE_TIGER_INSTANCE_NONCE || 'manual')
