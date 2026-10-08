import type { IWorkbookData } from '@univerjs/core'

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

type RuntimeHealth = {
  status: string
  database: string
  runtime_mode: string
  database_path: string
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
  const configured = [expectedMode, expectedDatabasePath, expectedNonce]

  if (configured.every((value) => !value)) return
  if (configured.some((value) => !value)) {
    throw new ApiError('隔離測試環境識別設定不完整', 503)
  }

  const response = await fetch('/api/health', { signal })
  if (!response.ok) throw new ApiError('無法驗證後端隔離環境', response.status)
  const health = await response.json() as RuntimeHealth
  if (
    health.status !== 'ok' ||
    health.runtime_mode !== expectedMode ||
    health.instance_nonce !== expectedNonce ||
    normalizeRuntimePath(health.database_path) !== normalizeRuntimePath(expectedDatabasePath)
  ) {
    throw new ApiError('後端隔離環境識別不符，已拒絕存取', 503)
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  await verifyRuntimeIdentity(init?.signal ?? undefined)
  const response = await fetch(path, init)
  if (!response.ok) {
    const message = response.status === 409 ? '儲存衝突' : '文件操作失敗'
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
