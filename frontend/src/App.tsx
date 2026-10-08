import { useCallback, useEffect, useRef, useState } from 'react'
import type { IRange, IWorkbookData } from '@univerjs/core'
import { CommandType, LocaleType } from '@univerjs/core'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhTW from '@univerjs/preset-sheets-core/locales/zh-TW'
import {
  SetSheetFilterRangeCommand,
  UniverSheetsFilterPreset,
} from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsFilterZhTW from '@univerjs/preset-sheets-filter/locales/zh-TW'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import UniverPresetSheetsFindReplaceZhTW from '@univerjs/preset-sheets-find-replace/locales/zh-TW'
import {
  SortRangeCommand,
  SortType,
  UniverSheetsSortPlugin,
} from '@univerjs/preset-sheets-sort'
import { createUniver, mergeLocales } from '@univerjs/presets'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'

// Register the native sort model/command without Univer's ambiguous quick-sort UI.
// Tiger exposes one explicit whole-record workflow below and always sets hasTitle.
const UniverSheetsSafeSortPreset = () => ({ plugins: [UniverSheetsSortPlugin] })

const WORKBOOK_ID = 'default'
const NON_PERSISTENT_MUTATIONS = new Set(['doc.mutation.rich-text-editing'])
const PERSISTED_COMMANDS = new Set([
  'sheet.command.replace',
  'sheet.command.set-range-values',
])

function isPersistedWorkbookMutation(event: {
  id: string
  type: CommandType
  params?: unknown
}): boolean {
  if (event.type === CommandType.COMMAND && PERSISTED_COMMANDS.has(event.id)) {
    return true
  }
  if (event.type !== CommandType.MUTATION) return false
  if (NON_PERSISTENT_MUTATIONS.has(event.id)) return false
  if (event.id.startsWith('formula.mutation.')) return false

  if (event.id === 'sheet.mutation.set-range-values') {
    return (
      typeof event.params === 'object' &&
      event.params !== null &&
      'trigger' in event.params
    )
  }

  return true
}

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

type RuntimeHealth = {
  status: string
  database: string
  runtime_mode: string
  database_path: string
  instance_nonce: string | null
}

type SaveStatus =
  | 'loading'
  | 'unsaved'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'conflict'
  | 'load-error'

type SafeSortSelection = {
  unitId: string
  subUnitId: string
  sheetName: string
  a1Notation: string
  range: IRange
  columns: Array<{ index: number; label: string }>
}

function valuesChanged(before: unknown[][], after: unknown[][]): boolean {
  return JSON.stringify(before) !== JSON.stringify(after)
}

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

function normalizeRuntimePath(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase()
}

async function verifyRuntimeIdentity(signal?: AbortSignal): Promise<void> {
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

async function loadWorkbook(signal: AbortSignal): Promise<PersistedWorkbook | null> {
  await verifyRuntimeIdentity(signal)
  const response = await fetch(`/api/workbooks/${WORKBOOK_ID}`, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new ApiError('無法載入活頁簿', response.status)
  return response.json() as Promise<PersistedWorkbook>
}

async function persistWorkbook(
  snapshot: IWorkbookData,
  expectedRevision: number,
): Promise<PersistedWorkbook> {
  await verifyRuntimeIdentity()
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
  const [safeSortSelection, setSafeSortSelection] = useState<SafeSortSelection | null>(null)
  const [safeSortColumn, setSafeSortColumn] = useState(0)
  const [safeSortDirection, setSafeSortDirection] = useState<'asc' | 'desc'>('asc')
  const [safeSortHasHeader, setSafeSortHasHeader] = useState(true)
  const [safeSortError, setSafeSortError] = useState('')
  const [safeSortPending, setSafeSortPending] = useState(false)
  const [safeSortNotice, setSafeSortNotice] = useState('')
  const [filterPending, setFilterPending] = useState(false)
  const [filterNotice, setFilterNotice] = useState('')
  const [filterError, setFilterError] = useState('')

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
          [LocaleType.ZH_TW]: mergeLocales(
            UniverPresetSheetsCoreZhTW,
            UniverPresetSheetsFilterZhTW,
            UniverPresetSheetsFindReplaceZhTW,
          ),
        },
        presets: [
          UniverSheetsCorePreset({ container: containerRef.current }),
          UniverSheetsFilterPreset(),
          UniverSheetsFindReplacePreset(),
          UniverSheetsSafeSortPreset(),
        ],
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
          if (!isPersistedWorkbookMutation(event)) return
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

  const closeSafeSort = useCallback(() => {
    setSafeSortSelection(null)
    setSafeSortError('')
  }, [])

  const enableFilter = useCallback(async () => {
    setFilterNotice('')
    setFilterError('')

    const univerAPI = apiRef.current
    const workbook = univerAPI?.getActiveWorkbook()
    const activeRange = workbook?.getActiveRange()
    if (!univerAPI || !workbook || !activeRange) {
      setFilterError('請先選取包含標題列的完整資料表。')
      return
    }

    if (activeRange.getHeight() < 2) {
      setFilterError('篩選範圍必須包含一列標題與至少一列資料。')
      return
    }

    const headers = activeRange.getDisplayValues()[0] ?? []
    if (headers.some((header) => !header.trim())) {
      setFilterError('篩選範圍第一列的每個欄位都必須有標題。')
      return
    }

    const sheet = workbook.getSheetBySheetId(activeRange.getSheetId())
    if (sheet?.getFilter()) {
      setFilterNotice(`${activeRange.getSheetName()} 已啟用篩選。`)
      return
    }

    setFilterPending(true)
    try {
      const ok = await univerAPI.executeCommand(SetSheetFilterRangeCommand.id, {
        unitId: activeRange.getUnitId(),
        subUnitId: activeRange.getSheetId(),
        range: { ...activeRange.getRange() },
      })
      if (ok !== true) {
        throw new Error('Univer 拒絕建立篩選範圍。')
      }
      setFilterNotice(`已啟用篩選 ${activeRange.getSheetName()}!${activeRange.getA1Notation()}。`)
    } catch (error: unknown) {
      const reason = error instanceof Error && error.message
        ? error.message
        : '無法建立 Univer 篩選範圍。'
      setFilterError(`啟用篩選失敗：${reason}`)
    } finally {
      setFilterPending(false)
    }
  }, [])

  const openSafeSort = useCallback(() => {
    setSafeSortNotice('')
    setSafeSortError('')

    const workbook = apiRef.current?.getActiveWorkbook()
    const activeRange = workbook?.getActiveRange()
    if (!workbook || !activeRange) {
      setSafeSortError('請先在工作表中選取完整資料表（包含標題列）。')
      setSafeSortSelection(null)
      return
    }

    // getRange() exposes Univer's selection object. Copy its scalar bounds so
    // focus changes in the external panel cannot mutate the captured target.
    const range = { ...activeRange.getRange() }
    if (activeRange.getHeight() < 2) {
      setSafeSortError('選取範圍必須包含一列標題與至少一列資料。')
      setSafeSortSelection(null)
      return
    }

    if (activeRange.getWidth() < 2) {
      setSafeSortError('不可只選取單一欄。請選取包含所有記錄欄位的完整資料表。')
      setSafeSortSelection(null)
      return
    }

    if (activeRange.getFormulas().flat().some((formula) => Boolean(formula))) {
      setSafeSortError('安全排序目前不接受公式欄。請只選取一般資料欄位。')
      setSafeSortSelection(null)
      return
    }

    const headers = activeRange.getDisplayValues()[0] ?? []
    if (headers.some((header) => !header.trim())) {
      setSafeSortError('選取範圍第一列的每個欄位都必須有標題。')
      setSafeSortSelection(null)
      return
    }

    const columns = headers.map((header, offset) => ({
      index: range.startColumn + offset,
      label: header,
    }))
    setSafeSortColumn(columns[0].index)
    setSafeSortDirection('asc')
    setSafeSortHasHeader(true)
    setSafeSortSelection({
      unitId: activeRange.getUnitId(),
      subUnitId: activeRange.getSheetId(),
      sheetName: activeRange.getSheetName(),
      a1Notation: activeRange.getA1Notation(),
      range,
      columns,
    })
  }, [])

  const applySafeSort = useCallback(async () => {
    const univerAPI = apiRef.current
    const workbook = workbookRef.current
    const selection = safeSortSelection
    if (!univerAPI || !workbook || !selection || safeSortPending) {
      if (!safeSortPending) {
        setSafeSortError('安全排序失敗：找不到已載入的活頁簿或選取範圍。')
      }
      return
    }
    if (!safeSortHasHeader) {
      setSafeSortError('為保護欄位標題，必須勾選「第一列為標題」。')
      return
    }

    const sheet = workbook.getSheetBySheetId(selection.subUnitId)
    if (workbook.getId() !== selection.unitId || !sheet) {
      setSafeSortError('安全排序失敗：原先選取的工作表已不存在，請重新選取完整資料表。')
      return
    }

    setSafeSortPending(true)
    setSafeSortError('')
    try {
      const targetRange = sheet.getRange(selection.a1Notation)
      const beforeValues = targetRange.getValues()
      const ok = await univerAPI.executeCommand(SortRangeCommand.id, {
        unitId: selection.unitId,
        subUnitId: selection.subUnitId,
        range: selection.range,
        orderRules: [{
          colIndex: safeSortColumn,
          type: safeSortDirection === 'asc' ? SortType.ASC : SortType.DESC,
        }],
        hasTitle: true,
      })
      if (ok !== true) {
        throw new Error('Univer 拒絕執行排序命令。')
      }

      const afterValues = targetRange.getValues()
      setSafeSortSelection(null)
      if (valuesChanged(beforeValues, afterValues)) {
        setSafeSortNotice(
          `已安全排序 ${selection.sheetName}!${selection.a1Notation}；完整資料列已一起移動。`,
        )
      } else {
        setSafeSortNotice(
          `${selection.sheetName}!${selection.a1Notation} 已符合所選排序順序，沒有需要移動的資料列。`,
        )
      }
    } catch (error: unknown) {
      const reason = error instanceof Error && error.message
        ? error.message
        : '無法執行 Univer 排序命令。'
      setSafeSortError(`安全排序失敗：${reason}`)
    } finally {
      setSafeSortPending(false)
    }
  }, [safeSortColumn, safeSortDirection, safeSortHasHeader, safeSortPending, safeSortSelection])

  const canUseSafeSort = status !== 'loading' && status !== 'load-error' && !safeSortPending
  const canEnableFilter = status !== 'loading' && status !== 'load-error' && !filterPending

  return (
    <main className="app-shell">
      <header className="app-bar">
        <h1>Tiger Web Sheets</h1>
        <div className="app-actions">
          {safeSortNotice && <span className="safe-sort-notice" role="status">{safeSortNotice}</span>}
          {filterNotice && <span className="filter-notice" role="status">{filterNotice}</span>}
          {filterError && <span className="filter-error" role="alert">{filterError}</span>}
          <button
            type="button"
            className="filter-button"
            onClick={enableFilter}
            disabled={!canEnableFilter}
            data-testid="enable-filter-button"
          >
            {filterPending ? '啟用中…' : '啟用篩選'}
          </button>
          <button
            type="button"
            className="safe-sort-button"
            onClick={openSafeSort}
            disabled={!canUseSafeSort}
            data-testid="safe-sort-button"
          >
            安全排序
          </button>
          <div className="save-controls">
            <span className={`save-status save-status--${status}`} data-testid="save-status">
              {statusLabels[status]}
            </span>
            <button type="button" onClick={save} disabled={!canSave} data-testid="save-button">
              儲存
            </button>
          </div>
        </div>
      </header>
      <section className="workbook-area">
        <div ref={containerRef} className="univer-shell" aria-label="Tiger Web Sheets" />
        {(safeSortSelection || safeSortError) && (
          <div className="safe-sort-panel" role="dialog" aria-labelledby="safe-sort-title">
            <div className="safe-sort-panel__heading">
              <div>
                <strong id="safe-sort-title">安全排序完整資料列</strong>
                {safeSortSelection && (
                  <span>{safeSortSelection.sheetName}!{safeSortSelection.a1Notation}</span>
                )}
              </div>
              <button
                type="button"
                className="safe-sort-close"
                aria-label="關閉安全排序"
                onClick={closeSafeSort}
              >
                ×
              </button>
            </div>
            <p className="safe-sort-help">
              請先選取包含標題列的完整資料表。排序時，每一列的所有欄位都會一起移動。
            </p>
            {safeSortError && <p className="safe-sort-error" role="alert">{safeSortError}</p>}
            {safeSortSelection && (
              <>
                <label>
                  排序依據
                  <select
                    value={safeSortColumn}
                    onChange={(event) => setSafeSortColumn(Number(event.target.value))}
                    disabled={safeSortPending}
                  >
                    {safeSortSelection.columns.map((column) => (
                      <option key={column.index} value={column.index}>{column.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  排序方向
                  <select
                    value={safeSortDirection}
                    onChange={(event) => setSafeSortDirection(event.target.value as 'asc' | 'desc')}
                    disabled={safeSortPending}
                  >
                    <option value="asc">遞增</option>
                    <option value="desc">遞減</option>
                  </select>
                </label>
                <label className="safe-sort-checkbox">
                  <input
                    type="checkbox"
                    checked={safeSortHasHeader}
                    onChange={(event) => setSafeSortHasHeader(event.target.checked)}
                    disabled={safeSortPending}
                  />
                  第一列為標題（必要）
                </label>
                <div className="safe-sort-panel__actions">
                  <button
                    type="button"
                    className="safe-sort-cancel"
                    onClick={closeSafeSort}
                    disabled={safeSortPending}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="safe-sort-apply"
                    onClick={applySafeSort}
                    disabled={safeSortPending || !safeSortHasHeader}
                    data-testid="safe-sort-apply"
                  >
                    {safeSortPending ? '排序中…' : '套用安全排序'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
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

