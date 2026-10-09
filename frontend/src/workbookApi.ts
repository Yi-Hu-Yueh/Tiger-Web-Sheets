import type { IWorkbookData } from '@univerjs/core'
import type { NativeWorkbookDocument } from './files/nativeFileAccess'

export type WorkbookSummary = {
  id: string
  name: string
  revision: number
  created_at: string
  updated_at: string
}

export type PersistedWorkbook = WorkbookSummary & {
  snapshot: IWorkbookData
}

export type WorkbookVersion = {
  version_id: string
  workbook_id: string
  source_revision: number
  created_at: string
  source_type: 'manual' | 'autosave' | 'pre_restore' | 'restore'
  label: string | null
  snapshot_sha256: string
  worksheet_count: number
  worksheet_names: string[]
  populated_cell_count: number
  integrity: 'ok' | 'corrupt'
}

export type WorkbookRestoreResult = {
  workbook: PersistedWorkbook
  safety_version: WorkbookVersion
}

type RuntimeHealth = {
  status: string
  product_version: string
  database: string
  runtime_mode: string
  database_path: string
  workbook_root: string
  history_root: string
  instance_nonce: string | null
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function normalizeRuntimePath(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase()
}

export async function verifyRuntimeIdentity(signal?: AbortSignal): Promise<void> {
  const expectedMode = import.meta.env.VITE_TIGER_RUNTIME_MODE
  const expectedDatabasePath = import.meta.env.VITE_TIGER_DATABASE_PATH
  const expectedNonce = import.meta.env.VITE_TIGER_INSTANCE_NONCE
  const expectedWorkbookRoot = import.meta.env.VITE_TIGER_WORKBOOK_ROOT
  const expectedHistoryRoot = import.meta.env.VITE_TIGER_HISTORY_ROOT
  const configured = [expectedMode, expectedDatabasePath, expectedWorkbookRoot, expectedHistoryRoot, expectedNonce]

  if (configured.every((value) => !value)) return
  if (configured.some((value) => !value)) {
    throw new ApiError('執行環境識別設定不完整，已拒絕存取。', 503)
  }

  let response: Response
  try {
    response = await fetch('/api/health', { signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('無法連線至儲存服務。請確認後端已啟動。', 0)
  }
  if (!response.ok) throw new ApiError('無法驗證後端執行環境。', response.status)
  const health = await response.json() as RuntimeHealth
  if (
    health.status !== 'ok' ||
    health.product_version !== __TIGER_VERSION__ ||
    health.runtime_mode !== expectedMode ||
    health.instance_nonce !== expectedNonce ||
    normalizeRuntimePath(health.database_path) !== normalizeRuntimePath(expectedDatabasePath) ||
    normalizeRuntimePath(health.workbook_root) !== normalizeRuntimePath(expectedWorkbookRoot) ||
    normalizeRuntimePath(health.history_root) !== normalizeRuntimePath(expectedHistoryRoot)
  ) {
    throw new ApiError('後端執行環境識別不符，已拒絕存取。', 503)
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  await verifyRuntimeIdentity(init?.signal ?? undefined)
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('無法連線至儲存服務。請確認後端已啟動。', 0)
  }
  if (!response.ok) {
    let detail: unknown
    try { detail = (await response.json() as { detail?: unknown }).detail } catch { /* no JSON detail */ }
    const known: Record<string, string> = {
      'database unavailable': '儲存資料庫目前無法使用。',
      'save failed': '儲存失敗；目前內容仍保留在畫面中。',
      'create failed': '建立活頁簿失敗。',
      'rename failed': '重新命名失敗。',
      'delete failed': '刪除活頁簿失敗。',
      'workbook not found': '找不到指定的活頁簿。',
      'version not found': '找不到指定的版本。',
      'version history unavailable': '版本紀錄目前無法使用。',
      'version creation failed': '建立版本失敗。',
      'version restore failed': '版本還原失敗；目前版本未被取代。',
    }
    const detailText = typeof detail === 'string' ? detail : ''
    const localizedDetail = /[\u3400-\u9fff]/u.test(detailText) ? detailText : ''
    const message = response.status === 409
      ? '儲存衝突：伺服器已有較新的版本，未覆寫其內容。'
      : known[detailText] || (response.status === 413 ? '檔案或版本超過支援大小。' : localizedDetail || '文件操作失敗。')
    throw new ApiError(message, response.status)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export function listWorkbooks(signal?: AbortSignal): Promise<WorkbookSummary[]> {
  return api('/api/workbooks', { signal })
}

export function loadWorkbook(id: string, signal?: AbortSignal): Promise<PersistedWorkbook> {
  return api(`/api/workbooks/${encodeURIComponent(id)}`, { signal })
}

export function createWorkbook(name: string, snapshot: IWorkbookData): Promise<PersistedWorkbook> {
  return api('/api/workbooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, snapshot }),
  })
}

export function importNativeWorkbook(
  name: string,
  document: NativeWorkbookDocument,
): Promise<PersistedWorkbook> {
  return api('/api/native-files/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, document }),
  })
}

export function loadNativeDocument(
  id: string,
  signal?: AbortSignal,
): Promise<NativeWorkbookDocument> {
  return api(`/api/workbooks/${encodeURIComponent(id)}/native`, { signal })
}

export function saveWorkbook(
  id: string,
  name: string,
  snapshot: IWorkbookData,
  expectedRevision: number,
): Promise<PersistedWorkbook> {
  return api(`/api/workbooks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, snapshot, expected_revision: expectedRevision }),
  })
}

export function renameWorkbook(
  id: string,
  name: string,
  expectedRevision: number,
): Promise<PersistedWorkbook> {
  return api(`/api/workbooks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, expected_revision: expectedRevision }),
  })
}

export function deleteWorkbook(id: string): Promise<void> {
  return api(`/api/workbooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listWorkbookVersions(id: string): Promise<WorkbookVersion[]> {
  return api(`/api/workbooks/${encodeURIComponent(id)}/versions`)
}

export function createWorkbookVersion(
  id: string,
  expectedRevision: number,
  label: string | null,
): Promise<WorkbookVersion> {
  return api(`/api/workbooks/${encodeURIComponent(id)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, label }),
  })
}

export function restoreWorkbookVersion(
  id: string,
  versionId: string,
  expectedRevision: number,
): Promise<WorkbookRestoreResult> {
  return api(`/api/workbooks/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision }),
  })
}
