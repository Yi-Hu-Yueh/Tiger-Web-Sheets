import type { IWorkbookData } from '@univerjs/core'

export const NATIVE_FORMAT = 'tiger-web-sheets'
export const NATIVE_FORMAT_VERSION = 1
export const NATIVE_EXTENSION = '.tws.json'

export type NativeWorkbookDocument = {
  format: typeof NATIVE_FORMAT
  format_version: typeof NATIVE_FORMAT_VERSION
  workbook_id: string
  revision: number
  saved_at: string
  snapshot_sha256: string
  snapshot: IWorkbookData
}

type FilePermissionMode = 'read' | 'readwrite'
type FilePermissionState = 'granted' | 'denied' | 'prompt'

export type NativeFileWritable = {
  write: (data: string | ArrayBuffer) => Promise<void>
  close: () => Promise<void>
  abort?: () => Promise<void>
}

export type NativeFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  createWritable: () => Promise<NativeFileWritable>
  queryPermission?: (options: { mode: FilePermissionMode }) => Promise<FilePermissionState>
  requestPermission?: (options: { mode: FilePermissionMode }) => Promise<FilePermissionState>
}

export type NativePickerType = {
  description: string
  accept: Record<string, string[]>
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple: false
    excludeAcceptAllOption: true
    types: NativePickerType[]
  }) => Promise<NativeFileHandle[]>
  showSaveFilePicker?: (options: {
    suggestedName: string
    excludeAcceptAllOption: true
    types: NativePickerType[]
  }) => Promise<NativeFileHandle>
}

const PICKER_TYPES: NativePickerType[] = [{
  description: 'Tiger Web Sheets Workbook',
  accept: { 'application/json': [NATIVE_EXTENSION] },
}]

const HANDLE_DATABASE = 'tiger-web-sheets-file-handles'
const HANDLE_STORE = 'handles'
const HANDLE_DATABASE_VERSION = 1
const sessionHandles = new Map<string, NativeFileHandle>()

export class NativeFileAccessError extends Error {}
export class NativeFileAccessUnsupportedError extends NativeFileAccessError {}
export class NativeFileValidationError extends NativeFileAccessError {}
export class NativeFilePermissionError extends NativeFileAccessError {}

export class NativePersistenceError<T> extends NativeFileAccessError {
  constructor(
    readonly stage: 'internal' | 'synchronization' | 'external',
    message: string,
    readonly committed?: T,
    readonly document?: NativeWorkbookDocument,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

function pickerWindow(): PickerWindow {
  return window as PickerWindow
}

export function supportsNativeFilePickers(): boolean {
  const target = pickerWindow()
  return typeof target.showOpenFilePicker === 'function' && typeof target.showSaveFilePicker === 'function'
}

export async function chooseFileForOpen(types: NativePickerType[]): Promise<NativeFileHandle | null> {
  const target = pickerWindow()
  if (typeof target.showOpenFilePicker !== 'function') {
    throw new NativeFileAccessUnsupportedError('目前瀏覽器不支援本機檔案選擇功能。請使用支援此功能的桌面 Chrome 或 Edge。')
  }
  try {
    const handles = await target.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: true,
      types,
    })
    return handles[0] ?? null
  } catch (error: unknown) {
    if (isPickerCancellation(error)) return null
    throw pickerFailure('開啟', error)
  }
}

export async function chooseFileForSave(
  suggestedName: string,
  types: NativePickerType[],
): Promise<NativeFileHandle | null> {
  const target = pickerWindow()
  if (typeof target.showSaveFilePicker !== 'function') {
    throw new NativeFileAccessUnsupportedError('目前瀏覽器不支援本機檔案選擇功能。請使用支援此功能的桌面 Chrome 或 Edge。')
  }
  try {
    return await target.showSaveFilePicker({
      suggestedName,
      excludeAcceptAllOption: true,
      types,
    })
  } catch (error: unknown) {
    if (isPickerCancellation(error)) return null
    throw pickerFailure('儲存', error)
  }
}

export function suggestedNativeFilename(name: string): string {
  const trimmed = name.trim() || '未命名活頁簿'
  return trimmed.toLowerCase().endsWith(NATIVE_EXTENSION) ? trimmed : `${trimmed}${NATIVE_EXTENSION}`
}

export function workbookNameFromFilename(filename: string): string {
  return filename.toLowerCase().endsWith(NATIVE_EXTENSION)
    ? filename.slice(0, -NATIVE_EXTENSION.length) || '未命名活頁簿'
    : filename || '未命名活頁簿'
}

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function pickerFailure(operation: '開啟' | '儲存', error: unknown): NativeFileAccessError {
  const errorName = error instanceof DOMException ? error.name : ''
  if (errorName === 'SecurityError' || errorName === 'NotAllowedError') {
    return new NativeFileAccessError(
      `瀏覽器拒絕${operation}原生檔案選擇器（${errorName}）。請直接按頁面按鈕重試，並確認使用支援的桌面 Chrome 或 Edge。`,
      { cause: error },
    )
  }
  return new NativeFileAccessError(`無法開啟本機檔案${operation}選擇器。`, { cause: error })
}

export async function chooseNativeOpenFile(): Promise<NativeFileHandle | null> {
  return chooseFileForOpen(PICKER_TYPES)
}

export async function chooseNativeSaveFile(name: string): Promise<NativeFileHandle | null> {
  return chooseFileForSave(suggestedNativeFilename(name), PICKER_TYPES)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export async function snapshotSha256(snapshot: IWorkbookData): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(snapshot))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isWorkbookSnapshot(value: unknown): value is IWorkbookData {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Record<string, unknown>
  return (
    typeof snapshot.id === 'string' &&
    typeof snapshot.name === 'string' &&
    Array.isArray(snapshot.sheetOrder) &&
    typeof snapshot.sheets === 'object' && snapshot.sheets !== null &&
    typeof snapshot.styles === 'object' && snapshot.styles !== null
  )
}

export async function parseNativeWorkbookText(text: string): Promise<NativeWorkbookDocument> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new NativeFileValidationError('本機檔案不是有效的 JSON。', { cause: error })
  }
  if (typeof value !== 'object' || value === null) {
    throw new NativeFileValidationError('本機檔案必須包含 Tiger Web Sheets 文件物件。')
  }
  const document = value as Record<string, unknown>
  if (document.format !== NATIVE_FORMAT) throw new NativeFileValidationError('本機檔案不是 Tiger Web Sheets 格式。')
  if (document.format_version !== NATIVE_FORMAT_VERSION) throw new NativeFileValidationError('本機檔案版本不受支援。')
  if (
    typeof document.workbook_id !== 'string' || !document.workbook_id ||
    !Number.isInteger(document.revision) || Number(document.revision) < 1 ||
    typeof document.saved_at !== 'string' ||
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(document.saved_at) ||
    Number.isNaN(Date.parse(document.saved_at)) ||
    typeof document.snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(document.snapshot_sha256) ||
    !isWorkbookSnapshot(document.snapshot)
  ) {
    throw new NativeFileValidationError('本機檔案缺少有效的活頁簿識別、版本、時間、雜湊或完整快照。')
  }
  const computedHash = await snapshotSha256(document.snapshot)
  if (computedHash !== document.snapshot_sha256.toLowerCase()) {
    throw new NativeFileValidationError('本機檔案快照雜湊不符。')
  }
  return {
    ...document,
    snapshot_sha256: document.snapshot_sha256.toLowerCase(),
  } as NativeWorkbookDocument
}

export async function permissionState(handle: NativeFileHandle, mode: FilePermissionMode): Promise<FilePermissionState> {
  if (!handle.queryPermission) return 'prompt'
  return handle.queryPermission({ mode })
}

export async function ensureWritePermission(handle: NativeFileHandle): Promise<void> {
  if (await permissionState(handle, 'readwrite') === 'granted') return
  if (!handle.requestPermission) {
    throw new NativeFilePermissionError('無法取得本機檔案寫入權限。請使用另存新檔重新選擇檔案。')
  }
  if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
    throw new NativeFilePermissionError('本機檔案寫入權限遭拒。請使用另存新檔重新選擇檔案。')
  }
}

export async function readNativeWorkbook(handle: NativeFileHandle): Promise<NativeWorkbookDocument> {
  return parseNativeWorkbookText(await (await handle.getFile()).text())
}

export async function writeNativeWorkbook(handle: NativeFileHandle, document: NativeWorkbookDocument): Promise<void> {
  await ensureWritePermission(handle)
  let writable: NativeFileWritable | null = null
  try {
    writable = await handle.createWritable()
    await writable.write(`${JSON.stringify(document, null, 2)}\n`)
    await writable.close()
    writable = null
    const verified = await readNativeWorkbook(handle)
    if (!nativeDocumentsMatch(verified, document)) {
      throw new NativeFileValidationError('寫入後的本機檔案驗證失敗。')
    }
  } catch (error: unknown) {
    if (writable?.abort) {
      try { await writable.abort() } catch { /* Preserve the original error. */ }
    }
    if (error instanceof NativeFileAccessError) throw error
    throw new NativeFileAccessError('本機檔案寫入失敗。', { cause: error })
  }
}

export async function commitThenWriteNativeFile<T>(
  handle: NativeFileHandle,
  commitInternal: () => Promise<T>,
  loadCommittedDocument: (committed: T) => Promise<NativeWorkbookDocument>,
): Promise<{ committed: T; document: NativeWorkbookDocument }> {
  try {
    await ensureWritePermission(handle)
  } catch (error: unknown) {
    throw new NativePersistenceError<T>('external', '本機檔案寫入權限不可用；內部版本尚未變更。', undefined, undefined, { cause: error })
  }
  let committed: T
  try {
    committed = await commitInternal()
  } catch (error: unknown) {
    throw new NativePersistenceError<T>('internal', '內部活頁簿同步失敗。', undefined, undefined, { cause: error })
  }
  let document: NativeWorkbookDocument
  try {
    document = await loadCommittedDocument(committed)
  } catch (error: unknown) {
    throw new NativePersistenceError('synchronization', '已建立內部復原副本，但無法取得同步文件。', committed, undefined, { cause: error })
  }
  try {
    await writeNativeWorkbook(handle, document)
  } catch (error: unknown) {
    throw new NativePersistenceError('external', '內部復原副本已儲存，但本機檔案寫入失敗。', committed, document, { cause: error })
  }
  return { committed, document }
}

export function nativeDocumentsMatch(left: NativeWorkbookDocument, right: NativeWorkbookDocument): boolean {
  return (
    left.workbook_id === right.workbook_id &&
    left.revision === right.revision &&
    left.snapshot_sha256 === right.snapshot_sha256 &&
    canonicalJson(left.snapshot) === canonicalJson(right.snapshot)
  )
}

async function openHandleDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  try {
    return await new Promise((resolve) => {
      const request = indexedDB.open(HANDLE_DATABASE, HANDLE_DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(HANDLE_STORE)) request.result.createObjectStore(HANDLE_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

function isNativeFileHandle(value: unknown): value is NativeFileHandle {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<NativeFileHandle>
  return (
    candidate.kind === 'file' &&
    typeof candidate.name === 'string' &&
    typeof candidate.getFile === 'function' &&
    typeof candidate.createWritable === 'function'
  )
}

export async function bindNativeFileHandle(workbookId: string, handle: NativeFileHandle): Promise<void> {
  sessionHandles.set(workbookId, handle)
  const database = await openHandleDatabase()
  if (!database) return
  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(HANDLE_STORE, 'readwrite')
      transaction.objectStore(HANDLE_STORE).put(handle, workbookId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    })
  } catch {
    // Session binding remains usable when IndexedDB cannot clone the handle.
  } finally {
    database.close()
  }
}

export async function restoreNativeFileHandle(workbookId: string): Promise<NativeFileHandle | null> {
  const session = sessionHandles.get(workbookId)
  if (session) return session
  const database = await openHandleDatabase()
  if (!database) return null
  let handle: NativeFileHandle | null
  try {
    const value = await new Promise<unknown>((resolve) => {
      const transaction = database.transaction(HANDLE_STORE, 'readonly')
      const request = transaction.objectStore(HANDLE_STORE).get(workbookId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    handle = isNativeFileHandle(value) ? value : null
  } catch {
    handle = null
  } finally {
    database.close()
  }
  if (handle) sessionHandles.set(workbookId, handle)
  return handle
}

export async function forgetNativeFileHandle(workbookId: string): Promise<void> {
  sessionHandles.delete(workbookId)
  const database = await openHandleDatabase()
  if (!database) return
  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(HANDLE_STORE, 'readwrite')
      transaction.objectStore(HANDLE_STORE).delete(workbookId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    })
  } catch {
    // Forgetting the in-memory association is sufficient for safe fallback.
  } finally {
    database.close()
  }
}
