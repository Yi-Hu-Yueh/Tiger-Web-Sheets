import { useCallback, useEffect, useRef, useState } from 'react'
import type { IWorkbookData } from '@univerjs/core'
import { CommandType, LocaleType } from '@univerjs/core'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhTW from '@univerjs/preset-sheets-core/locales/zh-TW'
import { createUniver, mergeLocales } from '@univerjs/presets'
import '@univerjs/preset-sheets-core/lib/index.css'

const WORKBOOK_ID = 'default'
const NON_PERSISTENT_MUTATIONS = new Set(['doc.mutation.rich-text-editing'])

const fallbackWorkbook: IWorkbookData = {
  id: 'tiger-phase-1a-workbook',
  name: 'Tiger Web Sheets',
  appVersion: '1.0.0',
  locale: LocaleType.ZH_TW,
  styles: {},
  sheetOrder: ['sheet-01'],
  sheets: {
    'sheet-01': {
      id: 'sheet-01',
      name: '工作表1',
      rowCount: 100,
      columnCount: 26,
      cellData: {
        0: {
          0: { v: 10 },
          1: { v: '台中公司' },
        },
        1: {
          0: { v: 20 },
        },
        2: {
          0: { f: '=SUM(A1:A2)' },
        },
      },
    },
  },
}

type PersistedWorkbook = {
  id: string
  name: string
  snapshot: IWorkbookData
  revision: number
  updated_at: string
}

type SaveStatus =
  | 'loading'
  | 'unsaved'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'conflict'
  | 'load-error'

const statusLabels: Record<SaveStatus, string> = {
  loading: '載入中',
  unsaved: '未儲存',
  saving: '儲存中',
  saved: '已儲存',
  failed: '儲存失敗',
  conflict: '儲存衝突',
  'load-error': '後端連線失敗',
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function loadWorkbook(signal: AbortSignal): Promise<PersistedWorkbook | null> {
  const response = await fetch(`/api/workbooks/${WORKBOOK_ID}`, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new ApiError('無法載入活頁簿', response.status)
  return response.json() as Promise<PersistedWorkbook>
}

async function persistWorkbook(
  snapshot: IWorkbookData,
  expectedRevision: number,
): Promise<PersistedWorkbook> {
  const response = await fetch(`/api/workbooks/${WORKBOOK_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: snapshot.name || 'Tiger Web Sheets',
      snapshot,
      expected_revision: expectedRevision,
    }),
  })

  if (!response.ok) {
    throw new ApiError(
      response.status === 409 ? '儲存衝突' : '儲存失敗',
      response.status,
    )
  }

  return response.json() as Promise<PersistedWorkbook>
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const workbookRef = useRef<ReturnType<ReturnType<typeof createUniver>['univerAPI']['createWorkbook']> | null>(null)
  const apiRef = useRef<ReturnType<typeof createUniver>['univerAPI'] | null>(null)
  const revisionRef = useRef(0)
  const changeGenerationRef = useRef(0)
  const savingRef = useRef(false)
  const [status, setStatus] = useState<SaveStatus>('loading')
  const [loadMessage, setLoadMessage] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const abortController = new AbortController()
    let disposed = false
    let univerInstance: ReturnType<typeof createUniver>['univer'] | null = null
    const disposables: Array<{ dispose: () => void }> = []

    workbookRef.current = null
    apiRef.current = null
    revisionRef.current = 0
    changeGenerationRef.current = 0

    async function initialize() {
      const persisted = await loadWorkbook(abortController.signal)
      if (disposed || !containerRef.current) return

      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_TW,
        locales: {
          [LocaleType.ZH_TW]: mergeLocales(UniverPresetSheetsCoreZhTW),
        },
        presets: [UniverSheetsCorePreset({ container: containerRef.current })],
      })

      univerInstance = univer
      apiRef.current = univerAPI
      const workbook = univerAPI.createWorkbook(persisted?.snapshot ?? fallbackWorkbook)
      workbookRef.current = workbook
      revisionRef.current = persisted?.revision ?? 0

      // Univer schedules initial hydration and formula commands after workbook creation.
      // Keep dirty tracking detached until those snapshot-derived mutations settle.
      await new Promise((resolve) => window.setTimeout(resolve, 500))
      try {
        await univerAPI.getFormula().onCalculationResultApplied(1_000)
      } catch {
        // Snapshots without pending formula work may time out without affecting rendering.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0))

      if (disposed) return

      disposables.push(
        univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
          if (
            event.type !== CommandType.MUTATION ||
            NON_PERSISTENT_MUTATIONS.has(event.id)
          ) return
          changeGenerationRef.current += 1
          setStatus('unsaved')
        }),
      )

      setStatus(persisted ? 'saved' : 'unsaved')
    }

    initialize().catch((error: unknown) => {
      if (disposed || abortController.signal.aborted) return
      setLoadMessage(error instanceof Error ? error.message : '無法連線至後端')
      setStatus('load-error')
    })

    return () => {
      disposed = true
      abortController.abort()
      disposables.forEach((disposable) => disposable.dispose())
      workbookRef.current = null
      apiRef.current = null
      univerInstance?.dispose()
    }
  }, [reloadToken])

  const save = useCallback(async () => {
    const workbook = workbookRef.current
    const univerAPI = apiRef.current
    if (!workbook || !univerAPI || savingRef.current) return

    savingRef.current = true
    setStatus('saving')

    try {
      const generationAtSnapshot = changeGenerationRef.current
      const snapshot = workbook.save()
      const [persisted] = await Promise.all([
        persistWorkbook(snapshot, revisionRef.current),
        new Promise((resolve) => window.setTimeout(resolve, 300)),
      ])
      revisionRef.current = persisted.revision
      setStatus(
        changeGenerationRef.current === generationAtSnapshot ? 'saved' : 'unsaved',
      )
    } catch (error: unknown) {
      setStatus(error instanceof ApiError && error.status === 409 ? 'conflict' : 'failed')
    } finally {
      savingRef.current = false
    }
  }, [])

  const canSave = status !== 'loading' && status !== 'load-error' && status !== 'saving'

  return (
    <main className="app-shell">
      <header className="app-bar">
        <h1>Tiger Web Sheets</h1>
        <div className="save-controls">
          <span className={`save-status save-status--${status}`} data-testid="save-status">
            {statusLabels[status]}
          </span>
          <button type="button" onClick={save} disabled={!canSave} data-testid="save-button">
            儲存
          </button>
        </div>
      </header>
      <section className="workbook-area">
        <div ref={containerRef} className="univer-shell" aria-label="Tiger Web Sheets" />
        {status === 'loading' && <div className="state-panel">正在載入活頁簿…</div>}
        {status === 'load-error' && (
          <div className="state-panel state-panel--error" role="alert">
            <strong>無法連線至儲存服務</strong>
            <span>{loadMessage || '請確認 FastAPI 後端正在執行。'}</span>
            <button
              type="button"
              onClick={() => {
                setStatus('loading')
                setLoadMessage('')
                setReloadToken((value) => value + 1)
              }}
            >
              重試
            </button>
          </div>
        )}
      </section>
    </main>
  )
}

export default App

