import { useCallback, useEffect, useRef, useState } from 'react'
import type { IRange, IWorkbookData } from '@univerjs/core'
import { LocaleType } from '@univerjs/core'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhTW from '@univerjs/preset-sheets-core/locales/zh-TW'
import {
  SetSheetFilterRangeCommand,
  UniverSheetsFilterPreset,
} from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsFilterZhTW from '@univerjs/preset-sheets-filter/locales/zh-TW'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import UniverPresetSheetsFindReplaceZhTW from '@univerjs/preset-sheets-find-replace/locales/zh-TW'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import UniverPresetSheetsDataValidationZhTW from '@univerjs/preset-sheets-data-validation/locales/zh-TW'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import UniverPresetSheetsConditionalFormattingZhTW from '@univerjs/preset-sheets-conditional-formatting/locales/zh-TW'
import { openNativeRulePanel, formatSelectedCodeAsText, createRuleMutationTracker } from './rules/nativeRuleUi'
import {
  SortRangeCommand,
  SortType,
  UniverSheetsSortPlugin,
} from '@univerjs/preset-sheets-sort'
import { createUniver, mergeLocales } from '@univerjs/presets'
import WorkbookHome from './WorkbookHome'
import { useXlsx } from './xlsx/useXlsx'
import { recalculateXlsx } from './xlsx/xlsxRecalculation'
import { AutosaveCoordinator } from './persistence/autosaveCoordinator'
import { recoveryStore, recoveryDisposition, type RecoveryCheckpoint } from './persistence/recoveryStore'
import RecoveryDialog from './persistence/RecoveryDialog'
import {
  CsvImportPreviewDialog,
  CsvWorksheetDialog,
  DeleteDialog,
  NameDialog,
  NativeCollisionDialog,
  UnsavedDialog,
} from './WorkbookDialogs'
import { parseCsvText, type CsvTable } from './csv/csvParser'
import {
  createCsvWorkbookSnapshot,
  csvRowsForWorksheet,
  csvNameFromFilename,
  sanitizeCsvSheetName,
  serializeCsv,
} from './csv/csvSerializer'
import {
  chooseCsvOpenFile,
  chooseCsvSaveFile,
  readCsvFile,
  writeCsvFile,
} from './files/csvFileAccess'
import {
  bindNativeFileHandle,
  chooseNativeOpenFile,
  chooseNativeSaveFile,
  commitThenWriteNativeFile,
  ensureWritePermission,
  forgetNativeFileHandle,
  NativeFileAccessUnsupportedError,
  NativeFilePermissionError,
  NativePersistenceError,
  nativeDocumentsMatch,
  permissionState,
  readNativeWorkbook,
  restoreNativeFileHandle,
  workbookNameFromFilename,
  writeNativeWorkbook,
  type NativeFileHandle,
  type NativeWorkbookDocument,
} from './files/nativeFileAccess'
import {
  ApiError,
  createWorkbook,
  deleteWorkbook,
  importNativeWorkbook,
  listWorkbooks,
  loadNativeDocument,
  loadWorkbook,
  renameWorkbook,
  saveWorkbook,
  type PersistedWorkbook,
  type WorkbookSummary,
} from './workbookApi'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'

// Register the native sort model/command without Univer's ambiguous quick-sort UI.
// Tiger exposes one explicit whole-record workflow below and always sets hasTitle.
const UniverSheetsSafeSortPreset = () => ({ plugins: [UniverSheetsSortPlugin] })

function freshWorkbook(name: string): IWorkbookData {
  const workbookId = crypto.randomUUID()
  return {
    id: workbookId,
    name,
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
        cellData: {},
      },
    },
  }
}

type SaveStatus =
  | 'loading'
  | 'unsaved'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'conflict'
  | 'external-failed'
  | 'sync-failed'
  | 'permission-required'
  | 'unsupported'
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

function newestFirst(items: WorkbookSummary[]): WorkbookSummary[] {
  return [...items].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id),
  )
}

const statusLabels: Record<SaveStatus, string> = {
  loading: '載入中',
  unsaved: '未儲存',
  saving: '儲存中',
  saved: '已儲存',
  failed: '儲存失敗',
  conflict: '儲存衝突',
  'external-failed': '本機檔案儲存失敗',
  'sync-failed': '同步失敗',
  'permission-required': '本機檔案需重新授權',
  unsupported: '不支援本機檔案',
  'load-error': '後端連線失敗',
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const workbookRef = useRef<ReturnType<ReturnType<typeof createUniver>['univerAPI']['createWorkbook']> | null>(null)
  const apiRef = useRef<ReturnType<typeof createUniver>['univerAPI'] | null>(null)
  const revisionRef = useRef(0)
  const currentWorkbookRef = useRef<PersistedWorkbook | null>(null)
  const changeGenerationRef = useRef(0)
  const savingRef = useRef(false)
  const autosaveRef = useRef<AutosaveCoordinator | null>(null)
  const persistRef = useRef<() => Promise<{ ok: boolean; generation: number }>>(async () => ({ ok: false, generation: -1 }))
  const checkpointRef = useRef<() => Promise<void>>(async () => {})
  const sessionRef = useRef('')
  const baseUpdatedAtRef = useRef('')
  const readyRef = useRef(false)
  const fileInteractionRef = useRef(false)
  const manualRequestRef = useRef<Promise<boolean> | null>(null)
  const autosaveEnabledRef = useRef(true)
  const autosaveHoldRef = useRef(false)
  const recoveryDecisionRef = useRef<{ workbookId: string; record: RecoveryCheckpoint | null } | null>(null)
  const boundFileHandleRef = useRef<NativeFileHandle | null>(null)
  const pendingExternalWriteRef = useRef<{
    workbookId: string
    document: NativeWorkbookDocument
    generation: number
  } | null>(null)
  const openingStatusRef = useRef<{
    workbookId: string
    status: SaveStatus
    message?: string
    recalculate?: boolean
    snapshot?: IWorkbookData
  } | null>(null)
  const [status, setStatus] = useState<SaveStatus>('loading')
  const [saveActive, setSaveActive] = useState(false)
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
  const [ruleError, setRuleError] = useState('')
  const [ruleNotice, setRuleNotice] = useState('')
  const [csvNotice, setCsvNotice] = useState('')
  const [csvError, setCsvError] = useState('')
  const [csvPending, setCsvPending] = useState(false)
  const [csvPreview, setCsvPreview] = useState<{
    filename: string
    workbookName: string
    sheetName: string
    table: CsvTable
  } | null>(null)
  const [csvExportSheets, setCsvExportSheets] = useState<Array<{ id: string; name: string }> | null>(null)
  const [boundFileName, setBoundFileName] = useState<string | null>(null)
  const [currentWorkbook, setCurrentWorkbook] = useState<PersistedWorkbook | null>(null)
  const [workbooks, setWorkbooks] = useState<WorkbookSummary[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [homeError, setHomeError] = useState('')
  const [homeReloadToken, setHomeReloadToken] = useState(0)
  const [nameDialog, setNameDialog] = useState<{
    mode: 'new' | 'rename'
    target?: WorkbookSummary
  } | null>(null)
  const [nativeCollision, setNativeCollision] = useState<{
    handle: NativeFileHandle
    document: NativeWorkbookDocument
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkbookSummary | null>(null)
  const [documentActionPending, setDocumentActionPending] = useState(false)
  const [autosaveEnabled, setAutosaveEnabled] = useState(() => {
    try { return localStorage.getItem(`tiger-autosave-${import.meta.env.VITE_TIGER_INSTANCE_NONCE || 'manual'}`) !== 'off' } catch { return true }
  })
  const [recoveryWarning, setRecoveryWarning] = useState('')
  const [recoveryPrompt, setRecoveryPrompt] = useState<{ committed: PersistedWorkbook; record: RecoveryCheckpoint; conflict: boolean } | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<'home' | 'new' | 'open-local' | 'import-csv' | 'import-xlsx' | null>(null)

  const xlsx = useXlsx({
    collect: async (signal) => {
      const api = apiRef.current, workbook = workbookRef.current
      if (!api || !workbook || savingRef.current) throw new Error('目前活頁簿尚未就緒。')
      const generation = changeGenerationRef.current
      await recalculateXlsx(api, workbook.save(), signal)
      if (generation !== changeGenerationRef.current || workbook !== workbookRef.current) throw new Error('活頁簿在匯出檢查期間已變更，請重試。')
      signal.throwIfAborted()
      return workbook.save()
    },
    commit: async (name, snapshot) => {
      const created = await createWorkbook(name, snapshot)
      pendingExternalWriteRef.current = null
      openingStatusRef.current = { workbookId: created.id, status: 'unsaved', recalculate: true }
      setStatus('loading')
      setCurrentWorkbook(created)
      setReloadToken((value) => value + 1)
    },
  })

  useEffect(() => {
    currentWorkbookRef.current = currentWorkbook
  }, [currentWorkbook])

  const rememberBoundHandle = useCallback((workbookId: string, handle: NativeFileHandle) => {
    boundFileHandleRef.current = handle
    setBoundFileName(handle.name)
    void bindNativeFileHandle(workbookId, handle)
  }, [])

  useEffect(() => {
    if (currentWorkbook) return
    const abortController = new AbortController()
    listWorkbooks(abortController.signal)
      .then(setWorkbooks)
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          setHomeError(error instanceof Error ? error.message : '無法載入活頁簿清單')
        }
      })
      .finally(() => {
        if (!abortController.signal.aborted) setHomeLoading(false)
      })
    return () => abortController.abort()
  }, [currentWorkbook, homeReloadToken])

  useEffect(() => {
    const workbookToOpen = currentWorkbookRef.current
    if (!workbookToOpen) return
    const openedWorkbook = workbookToOpen
    const snapshotToOpen = openedWorkbook.snapshot
    const revisionToOpen = openedWorkbook.revision
    const abortController = new AbortController()
    let disposed = false
    let univerInstance: ReturnType<typeof createUniver>['univer'] | null = null
    const disposables: Array<{ dispose: () => void }> = []

    workbookRef.current = null
    apiRef.current = null
    revisionRef.current = 0
    changeGenerationRef.current = 0
    boundFileHandleRef.current = null
    readyRef.current = false
    autosaveRef.current?.dispose()
    autosaveRef.current = null
    setRecoveryWarning('')
    setRuleError('')
    setRuleNotice('')
    setBoundFileName(null)

    async function initialize() {
      if (disposed || !containerRef.current) return

      let recovery: RecoveryCheckpoint | null = null
      if (recoveryDecisionRef.current?.workbookId === openedWorkbook.id) {
        recovery = recoveryDecisionRef.current.record
        recoveryDecisionRef.current = null
      } else if (!(openingStatusRef.current?.workbookId === openedWorkbook.id && openingStatusRef.current.snapshot)) {
        try {
          const record = await recoveryStore.read(openedWorkbook.id)
          if (disposed) return
          const disposition = recoveryDisposition(record, openedWorkbook)
          if (record && disposition !== 'none') {
            setRecoveryPrompt({ committed: openedWorkbook, record, conflict: disposition === 'conflict' })
            return
          }
          if (record) await recoveryStore.acknowledge(record.workbookId, record.sessionId, record.generation)
        } catch (error) {
          setRecoveryWarning(error instanceof Error ? error.message : '無法讀取本機復原資料。')
        }
      }
      if (disposed) return
      const openingSnapshot = openingStatusRef.current?.workbookId === openedWorkbook.id ? openingStatusRef.current.snapshot : undefined
      const actualSnapshot = recovery?.snapshot ?? openingSnapshot ?? snapshotToOpen
      sessionRef.current = crypto.randomUUID()
      const sessionId = sessionRef.current
      baseUpdatedAtRef.current = recovery?.baseUpdatedAt ?? openedWorkbook.updated_at

      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_TW,
        locales: {
          [LocaleType.ZH_TW]: mergeLocales(
            UniverPresetSheetsCoreZhTW,
            UniverPresetSheetsFilterZhTW,
            UniverPresetSheetsFindReplaceZhTW,
            UniverPresetSheetsDataValidationZhTW,
            UniverPresetSheetsConditionalFormattingZhTW,
          ),
        },
        presets: [
          UniverSheetsCorePreset({ container: containerRef.current }),
          UniverSheetsFilterPreset(),
          UniverSheetsFindReplacePreset(),
          UniverSheetsSafeSortPreset(),
          UniverSheetsDataValidationPreset({ showEditOnDropdown: true }),
          UniverSheetsConditionalFormattingPreset(),
        ],
      })

      univerInstance = univer
      apiRef.current = univerAPI
      // Univer owns and mutates the object it receives. Keep the last committed
      // API snapshot immutable so Discard can reconstruct it exactly.
      const workbook = univerAPI.createWorkbook(structuredClone(actualSnapshot))
      workbookRef.current = workbook
      revisionRef.current = recovery?.baseRevision ?? revisionToOpen
      if (recovery || openingSnapshot) changeGenerationRef.current = 1
      const checkpoint = async () => {
        if (disposed || !readyRef.current) return
        await recoveryStore.write({ workbookId: openedWorkbook.id, baseRevision: revisionRef.current,
          baseUpdatedAt: baseUpdatedAtRef.current, timestamp: Date.now(), sessionId,
          generation: changeGenerationRef.current, snapshot: workbook.save() })
      }
      checkpointRef.current = checkpoint
      const coordinator = new AutosaveCoordinator({
        generation: () => changeGenerationRef.current,
        eligible: () => readyRef.current && autosaveEnabledRef.current && !!boundFileHandleRef.current && revisionRef.current > 0 && !fileInteractionRef.current && !autosaveHoldRef.current,
        save: () => persistRef.current(), checkpoint,
        recoveryError: (error) => { if (!disposed) setRecoveryWarning(error instanceof Error ? error.message : '本機復原寫入失敗，請手動儲存。') },
      })
      autosaveRef.current = coordinator

      // Univer schedules initial hydration and formula commands after workbook creation.
      // Keep dirty tracking detached until those snapshot-derived mutations settle.
      await new Promise((resolve) => window.setTimeout(resolve, 500))
      if (recovery || openingSnapshot || openingStatusRef.current?.workbookId === openedWorkbook.id && openingStatusRef.current.recalculate) {
        await recalculateXlsx(univerAPI, actualSnapshot, abortController.signal)
      }
      try {
        await univerAPI.getFormula().onCalculationResultApplied(1_000)
      } catch {
        // Snapshots without pending formula work may time out without affecting rendering.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0))

      if (disposed) return

      const ruleMutationTracker = createRuleMutationTracker(univerAPI)
      disposables.push(
        ruleMutationTracker,
        univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
          if (!ruleMutationTracker.isPersistent(event)) return
          changeGenerationRef.current += 1
          setStatus('unsaved')
          coordinator.mutation()
        }),
      )

      const openingStatus = openingStatusRef.current?.workbookId === openedWorkbook.id
        ? openingStatusRef.current
        : null
      if (openingStatus) openingStatusRef.current = null

      try {
        const restoredHandle = await restoreNativeFileHandle(openedWorkbook.id)
        if (disposed) return
        if (restoredHandle) {
          boundFileHandleRef.current = restoredHandle
          setBoundFileName(restoredHandle.name)
        }
        if (openingStatus) {
          if (openingStatus.message) setLoadMessage(openingStatus.message)
          setStatus(openingStatus.status)
        } else if (!restoredHandle) {
          setStatus('unsaved')
        } else if (await permissionState(restoredHandle, 'readwrite') !== 'granted') {
          setLoadMessage('請按儲存重新授權，或使用另存新檔重新選擇檔案。')
          setStatus('permission-required')
        } else {
          const [externalDocument, internalDocument] = await Promise.all([
            readNativeWorkbook(restoredHandle),
            loadNativeDocument(openedWorkbook.id),
          ])
          if (nativeDocumentsMatch(externalDocument, internalDocument)) {
            setStatus('saved')
          } else {
            setLoadMessage('本機檔案與 Tiger 內部復原副本不同步；請儲存或使用另存新檔。')
            setStatus('external-failed')
          }
        }
      } catch (error: unknown) {
        if (disposed) return
        setLoadMessage(error instanceof Error ? error.message : '無法驗證已連結的本機檔案。')
        setStatus('external-failed')
      }
      if (disposed) return
      readyRef.current = true
      if (recovery || changeGenerationRef.current > 0) {
        setStatus(recovery && recoveryDisposition(recovery, openedWorkbook) === 'conflict' ? 'conflict' : 'unsaved')
        coordinator.mutation()
        if (recovery && recoveryDisposition(recovery, openedWorkbook) === 'conflict') coordinator.block()
      }
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
      readyRef.current = false
      autosaveRef.current?.dispose()
      autosaveRef.current = null
      workbookRef.current = null
      apiRef.current = null
      univerInstance?.dispose()
    }
  }, [currentWorkbook?.id, reloadToken])

  const persist = useCallback(async (): Promise<{ ok: boolean; generation: number }> => {
    const workbook = workbookRef.current
    const current = currentWorkbookRef.current
    const handle = boundFileHandleRef.current
    if (!workbook || !current || !handle || savingRef.current) return { ok: false, generation: -1 }

    savingRef.current = true
    setSaveActive(true)
    setLoadMessage('')
    setStatus('saving')
    const generationAtSnapshot = changeGenerationRef.current
    const sessionId = sessionRef.current

    try {
      const pendingExternal = pendingExternalWriteRef.current
      if (pendingExternal?.workbookId === current.id && pendingExternal.generation === generationAtSnapshot) {
        const latest = await loadNativeDocument(current.id)
        if (!nativeDocumentsMatch(latest, pendingExternal.document)) throw new ApiError('儲存衝突：內部版本已變更，拒絕同步舊檔案。', 409)
        await writeNativeWorkbook(handle, pendingExternal.document, false)
        pendingExternalWriteRef.current = null
        setStatus(changeGenerationRef.current === generationAtSnapshot ? 'saved' : 'unsaved')
        try {
          if (changeGenerationRef.current !== generationAtSnapshot) await checkpointRef.current()
          await recoveryStore.acknowledge(current.id, sessionId, generationAtSnapshot)
        } catch { setRecoveryWarning('已儲存，但復原記錄清理失敗；下次開啟會比對已儲存內容。') }
        return { ok: true, generation: generationAtSnapshot }
      }

      const snapshot = structuredClone(workbook.save())
      const { committed: persisted } = await commitThenWriteNativeFile(
        handle,
        () => saveWorkbook(current.id, current.name, snapshot, revisionRef.current),
        (record) => loadNativeDocument(record.id),
        false,
      )
      revisionRef.current = persisted.revision
      baseUpdatedAtRef.current = persisted.updated_at
      currentWorkbookRef.current = persisted
      setCurrentWorkbook(persisted)
      pendingExternalWriteRef.current = null
      setStatus(
        changeGenerationRef.current === generationAtSnapshot ? 'saved' : 'unsaved',
      )
      try {
        if (changeGenerationRef.current !== generationAtSnapshot) await checkpointRef.current()
        await recoveryStore.acknowledge(current.id, sessionId, generationAtSnapshot)
      } catch { setRecoveryWarning('已儲存，但復原記錄清理失敗；下次開啟會比對已儲存內容。') }
      return { ok: true, generation: generationAtSnapshot }
    } catch (error: unknown) {
      if (error instanceof NativePersistenceError) {
        const committed = error.committed as PersistedWorkbook | undefined
        if (committed) {
          revisionRef.current = committed.revision
          baseUpdatedAtRef.current = committed.updated_at
          currentWorkbookRef.current = committed
          setCurrentWorkbook(committed)
        }
        if (error.stage === 'external' && error.document && committed) {
          pendingExternalWriteRef.current = {
            workbookId: committed.id,
            document: error.document,
            generation: generationAtSnapshot,
          }
        }
        const cause = error.cause
        if (error.stage === 'internal' && cause instanceof ApiError && cause.status === 409) {
          setStatus('conflict')
        } else if (cause instanceof NativeFilePermissionError) {
          setStatus('permission-required')
        } else {
          setStatus(error.stage === 'external' ? 'external-failed' : 'sync-failed')
        }
        setLoadMessage(error.message)
      } else {
        setLoadMessage(error instanceof Error ? error.message : '本機檔案儲存失敗。')
        setStatus(error instanceof ApiError && error.status === 409 ? 'conflict' : error instanceof NativeFilePermissionError ? 'permission-required' : 'external-failed')
      }
      return { ok: false, generation: generationAtSnapshot }
    } finally {
      savingRef.current = false
      setSaveActive(false)
    }
  }, [])

  useEffect(() => { persistRef.current = persist }, [persist])
  useEffect(() => {
    autosaveEnabledRef.current = autosaveEnabled
    try { localStorage.setItem(`tiger-autosave-${import.meta.env.VITE_TIGER_INSTANCE_NONCE || 'manual'}`, autosaveEnabled ? 'on' : 'off') } catch { /* Setting is still usable for this session. */ }
    if (autosaveEnabled) autosaveRef.current?.resume()
    else autosaveRef.current?.suspend()
  }, [autosaveEnabled])
  useEffect(() => {
    autosaveHoldRef.current = !!pendingNavigation || !!nameDialog || csvPending || xlsx.busy || documentActionPending
    if (autosaveHoldRef.current) autosaveRef.current?.suspend()
    else autosaveRef.current?.resume()
  }, [pendingNavigation, nameDialog, csvPending, xlsx.busy, documentActionPending])

  // Pickers/reauthorization are entered only by a Save click, never by a timer.
  const save = useCallback((): Promise<boolean> => {
    if (manualRequestRef.current) return manualRequestRef.current
    const current = currentWorkbookRef.current, coordinator = autosaveRef.current
    if (!current || !coordinator || !readyRef.current) return Promise.resolve(false)
    coordinator.suspend(); fileInteractionRef.current = true
    manualRequestRef.current = (async () => {
      try {
        let handle = boundFileHandleRef.current
        if (!handle) {
          handle = await chooseNativeSaveFile(current.name)
          if (!handle) return false
          rememberBoundHandle(current.id, handle)
        }
        await ensureWritePermission(handle)
        return await coordinator.flush()
      } catch (error) {
        setLoadMessage(error instanceof Error ? error.message : '無法取得本機儲存權限。')
        setStatus(error instanceof NativeFileAccessUnsupportedError ? 'unsupported' : error instanceof NativeFilePermissionError ? 'permission-required' : 'external-failed')
        coordinator.block()
        return false
      } finally { fileInteractionRef.current = false; manualRequestRef.current = null; coordinator.resume() }
    })()
    return manualRequestRef.current
  }, [rememberBoundHandle])

  const isDirty = saveActive || status === 'saving' || status === 'unsaved' || status === 'failed' || status === 'conflict' || status === 'external-failed' || status === 'sync-failed' || status === 'permission-required' || status === 'unsupported'

  useEffect(() => {
    if (!isDirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [isDirty])

  const openWorkbook = useCallback(async (summary: WorkbookSummary) => {
    setHomeError('')
    setCsvNotice('')
    setCsvError('')
    setHomeLoading(true)
    try {
      const persisted = await loadWorkbook(summary.id)
      setStatus('loading')
      setCurrentWorkbook(persisted)
    } catch (error: unknown) {
      setHomeError(error instanceof Error ? error.message : '無法開啟活頁簿')
    } finally {
      setHomeLoading(false)
    }
  }, [])

  const openLocalFile = useCallback(async () => {
    setHomeError('')
    setLoadMessage('')
    setCsvNotice('')
    setCsvError('')
    let handle: NativeFileHandle | null = null
    try {
      handle = await chooseNativeOpenFile()
      if (!handle) return
      const document = await readNativeWorkbook(handle)
      const persisted = await importNativeWorkbook(
        workbookNameFromFilename(handle.name),
        document,
      )
      pendingExternalWriteRef.current = null
      rememberBoundHandle(persisted.id, handle)
      openingStatusRef.current = { workbookId: persisted.id, status: 'saved' }
      setStatus('loading')
      setCurrentWorkbook(persisted)
      setReloadToken((value) => value + 1)
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409 && handle) {
        try {
          const document = await readNativeWorkbook(handle)
          setNativeCollision({ handle, document })
          return
        } catch (validationError: unknown) {
          const message = validationError instanceof Error ? validationError.message : '本機檔案驗證失敗。'
          setLoadMessage(message)
          return
        }
      }
      const message = error instanceof Error ? error.message : '無法開啟本機檔案。'
      setLoadMessage(message)
    }
  }, [rememberBoundHandle])

  const importCsvFile = useCallback(async () => {
    setCsvNotice('')
    setCsvError('')
    setLoadMessage('')
    setCsvPending(true)
    try {
      const handle = await chooseCsvOpenFile()
      if (!handle) return
      const table = parseCsvText(await readCsvFile(handle))
      const workbookName = csvNameFromFilename(handle.name)
      setCsvPreview({
        filename: handle.name,
        workbookName,
        sheetName: sanitizeCsvSheetName(workbookName),
        table,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'CSV 匯入失敗。'
      if (currentWorkbookRef.current) setCsvError(message)
      else setLoadMessage(message)
    } finally {
      setCsvPending(false)
    }
  }, [])

  const confirmCsvImport = useCallback(async () => {
    if (!csvPreview || documentActionPending) return
    setDocumentActionPending(true)
    setCsvError('')
    try {
      const snapshot = createCsvWorkbookSnapshot(
        csvPreview.workbookName,
        csvPreview.sheetName,
        csvPreview.table.rows,
      )
      const created = await createWorkbook(csvPreview.workbookName, snapshot)
      pendingExternalWriteRef.current = null
      openingStatusRef.current = {
        workbookId: created.id,
        status: 'unsaved',
      }
      setCsvNotice('CSV 已以全文字模式匯入為新的 Tiger 活頁簿；請使用儲存建立 .tws.json。')
      setCsvPreview(null)
      setStatus('loading')
      setCurrentWorkbook(created)
      setReloadToken((value) => value + 1)
    } catch (error: unknown) {
      setCsvError(error instanceof Error ? error.message : '無法建立 CSV 匯入活頁簿。')
    } finally {
      setDocumentActionPending(false)
    }
  }, [csvPreview, documentActionPending])

  const exportCsvSheet = useCallback(async (target: { id: string; name: string }) => {
    setCsvNotice('')
    setCsvError('')
    setLoadMessage('')
    setCsvPending(true)
    try {
      const handle = await chooseCsvSaveFile(target.name)
      if (!handle) return

      const facadeWorkbook = apiRef.current?.getActiveWorkbook()
      const sheet = facadeWorkbook?.getSheetBySheetId(target.id)
      const snapshot = workbookRef.current?.save()
      const sheetSnapshot = snapshot?.sheets[target.id]
      if (!sheet || !sheetSnapshot) throw new Error('找不到要匯出的工作表。')
      const rows = csvRowsForWorksheet(sheet, sheetSnapshot.cellData)
      if (!rows) throw new Error('所選工作表沒有可匯出的資料。')
      await writeCsvFile(handle, serializeCsv(rows))
      setCsvNotice(`已匯出 ${target.name} 為 ${handle.name}；Tiger 活頁簿儲存狀態未變更。`)
    } catch (error: unknown) {
      setCsvError(error instanceof Error ? error.message : 'CSV 匯出失敗。')
    } finally {
      setCsvPending(false)
    }
  }, [])

  const requestCsvExport = useCallback(() => {
    const sheets = apiRef.current?.getActiveWorkbook()?.getSheets().map((sheet) => ({
      id: sheet.getSheetId(),
      name: sheet.getSheetName(),
    })) ?? []
    if (!sheets.length) {
      setCsvError('目前活頁簿沒有可匯出的工作表。')
    } else if (sheets.length === 1) {
      void exportCsvSheet(sheets[0])
    } else {
      setCsvExportSheets(sheets)
    }
  }, [exportCsvSheet])

  const openCollisionAsCopy = useCallback(async () => {
    if (!nativeCollision) return
    setDocumentActionPending(true)
    try {
      const name = `${workbookNameFromFilename(nativeCollision.handle.name)}-副本`
      const created = await createWorkbook(name, nativeCollision.document.snapshot)
      pendingExternalWriteRef.current = null
      rememberBoundHandle(created.id, nativeCollision.handle)
      openingStatusRef.current = {
        workbookId: created.id,
        status: 'unsaved',
        message: '已建立獨立副本；按儲存後才會以新的文件識別更新所選本機檔案。',
      }
      setNativeCollision(null)
      setStatus('loading')
      setCurrentWorkbook(created)
      setReloadToken((value) => value + 1)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '無法建立獨立副本。'
      if (currentWorkbookRef.current) setLoadMessage(message)
      else setHomeError(message)
    } finally {
      setDocumentActionPending(false)
    }
  }, [nativeCollision, rememberBoundHandle])

  const saveAs = useCallback(async () => {
    const workbook = workbookRef.current
    const current = currentWorkbookRef.current
    if (!workbook || !current || savingRef.current || fileInteractionRef.current) return
    fileInteractionRef.current = true
    autosaveRef.current?.suspend()
    setLoadMessage('')

    let handle: NativeFileHandle | null
    try {
      handle = await chooseNativeSaveFile(`${current.name}-備份`)
    } catch (error: unknown) {
      setLoadMessage(error instanceof Error ? error.message : '無法選擇另存新檔位置。')
      if (error instanceof NativeFileAccessUnsupportedError) setStatus('unsupported')
      fileInteractionRef.current = false
      autosaveRef.current?.resume()
      return
    }
    if (!handle) { fileInteractionRef.current = false; autosaveRef.current?.resume(); return }

    try {
      await ensureWritePermission(handle)
    } catch (error: unknown) {
      setLoadMessage(error instanceof Error ? error.message : '無法取得本機檔案寫入權限。')
      setStatus('permission-required')
      fileInteractionRef.current = false
      autosaveRef.current?.resume()
      return
    }

    savingRef.current = true
    setSaveActive(true)
    setLoadMessage('')
    setStatus('saving')
    const generationAtSnapshot = changeGenerationRef.current
    const installCopy = async (created: PersistedWorkbook, copyStatus: SaveStatus, message?: string) => {
      let latest: IWorkbookData | undefined
      if (changeGenerationRef.current !== generationAtSnapshot) {
        latest = structuredClone(workbook.save())
        try {
          await recoveryStore.write({ workbookId: created.id, baseRevision: created.revision, baseUpdatedAt: created.updated_at,
            timestamp: Date.now(), sessionId: sessionRef.current, generation: changeGenerationRef.current, snapshot: latest })
        } catch { message = `${message ?? ''} 最新編輯仍在畫面中，但本機復原寫入失敗，請立即儲存。` }
        // Capture edits made even while the IDB checkpoint was committing.
        latest = structuredClone(workbook.save())
      }
      openingStatusRef.current = { workbookId: created.id, status: latest ? 'unsaved' : copyStatus, snapshot: latest, message }
      rememberBoundHandle(created.id, handle)
      setCurrentWorkbook(created)
      setReloadToken((value) => value + 1)
    }
    try {
      const snapshot = structuredClone(workbook.save())
      const name = workbookNameFromFilename(handle.name)
      const { committed: created } = await commitThenWriteNativeFile(
        handle,
        () => createWorkbook(name, snapshot),
        (record) => loadNativeDocument(record.id),
        false,
      )
      pendingExternalWriteRef.current = null
      await installCopy(created, 'saved')
    } catch (error: unknown) {
      if (error instanceof NativePersistenceError && error.committed) {
        const created = error.committed as PersistedWorkbook
        if (error.stage === 'external' && error.document) {
          pendingExternalWriteRef.current = {
            workbookId: created.id,
            document: error.document,
            generation: 0,
          }
        }
        await installCopy(created, error.stage === 'external' ? 'external-failed' : 'sync-failed', error.message)
      } else {
        setStatus('sync-failed')
        setLoadMessage(error instanceof Error ? error.message : '另存新檔同步失敗。')
      }
    } finally {
      savingRef.current = false
      setSaveActive(false)
      fileInteractionRef.current = false
      autosaveRef.current?.resume()
    }
  }, [rememberBoundHandle])

  const performNavigation = useCallback((action: 'home' | 'new', discard = false) => {
    setSafeSortSelection(null)
    setSafeSortError('')
    setCsvNotice('')
    setCsvError('')
    if (action === 'home') {
      setHomeLoading(true)
      setHomeError('')
      setCurrentWorkbook(null)
      setHomeReloadToken((value) => value + 1)
    } else {
      if (discard) {
        setStatus('loading')
        setReloadToken((value) => value + 1)
      }
      setNameDialog({ mode: 'new' })
    }
  }, [])

  const requestNavigation = useCallback((action: 'home' | 'new') => {
    if (isDirty) setPendingNavigation(action)
    else performNavigation(action)
  }, [isDirty, performNavigation])

  const requestOpenLocal = useCallback(() => {
    if (isDirty) setPendingNavigation('open-local')
    else void openLocalFile()
  }, [isDirty, openLocalFile])

  const requestCsvImport = useCallback(() => {
    if (isDirty) setPendingNavigation('import-csv')
    else void importCsvFile()
  }, [importCsvFile, isDirty])

  const requestXlsxImport = () => {
    if (isDirty) setPendingNavigation('import-xlsx')
    else void xlsx.importFile()
  }

  const confirmName = useCallback(async (name: string) => {
    if (!nameDialog) return
    setDocumentActionPending(true)
    setHomeError('')
    setLoadMessage('')
    setCsvNotice('')
    setCsvError('')
    try {
      if (nameDialog.mode === 'new') {
        const snapshot = freshWorkbook(name)
        const created = await createWorkbook(name, snapshot)
        setNameDialog(null)
        setStatus('loading')
        setCurrentWorkbook(created)
      } else {
        const target = nameDialog.target ?? currentWorkbookRef.current
        if (!target) throw new Error('找不到要重新命名的活頁簿')
        const renamed = await renameWorkbook(target.id, name, target.revision)
        setWorkbooks((items) => newestFirst(
          items.map((item) => item.id === renamed.id ? renamed : item),
        ))
        if (currentWorkbookRef.current?.id === renamed.id) {
          revisionRef.current = renamed.revision
          baseUpdatedAtRef.current = renamed.updated_at
          currentWorkbookRef.current = { ...currentWorkbookRef.current, name: renamed.name, revision: renamed.revision, updated_at: renamed.updated_at }
          setCurrentWorkbook((current) => current ? { ...current, name: renamed.name, revision: renamed.revision, updated_at: renamed.updated_at } : current)
          setLoadMessage('Tiger 顯示名稱已更新；本機實體檔名不變。請儲存以同步檔案內容。')
          setStatus('unsaved')
          changeGenerationRef.current += 1
          autosaveRef.current?.mutation()
        }
        setNameDialog(null)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '文件操作失敗'
      if (currentWorkbookRef.current) setLoadMessage(message)
      else setHomeError(message)
    } finally {
      setDocumentActionPending(false)
    }
  }, [nameDialog])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDocumentActionPending(true)
    try {
      await deleteWorkbook(deleteTarget.id)
      await forgetNativeFileHandle(deleteTarget.id)
      try { await recoveryStore.remove(deleteTarget.id) } catch { setLoadMessage('文件已刪除，但本機復原記錄清理失敗；請清除瀏覽器的 Tiger 復原儲存區。') }
      setWorkbooks((items) => items.filter((item) => item.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (error: unknown) {
      setHomeError(error instanceof Error ? error.message : '刪除失敗')
    } finally {
      setDocumentActionPending(false)
    }
  }, [deleteTarget])

  const saveAndNavigate = useCallback(async () => {
    const action = pendingNavigation
    if (!action) return
    setDocumentActionPending(true)
    const saved = await save()
    setDocumentActionPending(false)
    if (saved) {
      setPendingNavigation(null)
      if (action === 'open-local' || action === 'import-csv' || action === 'import-xlsx') {
        setLoadMessage(
          action === 'open-local'
            ? '目前活頁簿已儲存。請再次按「開啟本機檔案」以顯示原生選擇器。'
            : `目前活頁簿已儲存。請再次按「匯入 ${action === 'import-xlsx' ? 'XLSX' : 'CSV'}」以顯示原生選擇器。`,
        )
      } else {
        performNavigation(action)
      }
    }
  }, [pendingNavigation, performNavigation, save])

  const canSave = status !== 'loading' && status !== 'load-error'

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

  const chooseRecovery = async (restore: boolean) => {
    if (!recoveryPrompt || documentActionPending) return
    setDocumentActionPending(true)
    try {
      if (!restore) await recoveryStore.acknowledge(recoveryPrompt.record.workbookId, recoveryPrompt.record.sessionId, recoveryPrompt.record.generation)
      recoveryDecisionRef.current = { workbookId: recoveryPrompt.committed.id, record: restore ? recoveryPrompt.record : null }
      setRecoveryPrompt(null)
      setStatus('loading')
      setReloadToken((value) => value + 1)
    } catch (error) { setRecoveryWarning(error instanceof Error ? error.message : '無法清理復原資料；尚未替換目前版本。') }
    finally { setDocumentActionPending(false) }
  }

  if (!currentWorkbook) {
    return (
      <>
        <WorkbookHome
          workbooks={workbooks}
          loading={homeLoading}
          error={homeError}
          notice={loadMessage}
          csvPending={csvPending}
          onNew={() => setNameDialog({ mode: 'new' })}
          onOpenLocal={() => void openLocalFile()}
          onImportCsv={() => void importCsvFile()}
          onImportXlsx={() => void xlsx.importFile()}
          onOpen={openWorkbook}
          onRename={(target) => setNameDialog({ mode: 'rename', target })}
          onDelete={setDeleteTarget}
          onRetry={() => {
            setHomeLoading(true)
            setHomeError('')
            setHomeReloadToken((value) => value + 1)
          }}
        />
        {nameDialog && <NameDialog key={`${nameDialog.mode}-${nameDialog.target?.id ?? ''}`}
          title={nameDialog.mode === 'new' ? '新增活頁簿' : '重新命名活頁簿'}
          initialName={nameDialog.mode === 'rename' ? nameDialog.target?.name : '未命名活頁簿'}
          confirmLabel={nameDialog.mode === 'new' ? '建立' : '重新命名'}
          pending={documentActionPending}
          onConfirm={confirmName}
          onCancel={() => setNameDialog(null)}
        />}
        {deleteTarget && <DeleteDialog
          name={deleteTarget.name}
          pending={documentActionPending}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />}
        {nativeCollision && <NativeCollisionDialog
          filename={nativeCollision.handle.name}
          pending={documentActionPending}
          onCopy={openCollisionAsCopy}
          onCancel={() => setNativeCollision(null)}
        />}
        {csvPreview && <CsvImportPreviewDialog
          filename={csvPreview.filename}
          table={csvPreview.table}
          error={csvError}
          pending={documentActionPending}
          onConfirm={confirmCsvImport}
          onCancel={() => setCsvPreview(null)}
        />}
        {xlsx.notice && <p role="status">{xlsx.notice}</p>}
        {xlsx.dialogs}
      </>
    )
  }

  const openRules = async (kind: 'validation' | 'conditional') => {
    setRuleError('')
    setRuleNotice('')
    try {
      if (!apiRef.current) throw new Error('活頁簿尚未就緒。')
      await openNativeRulePanel(apiRef.current, kind)
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : '無法開啟規則面板。')
    }
  }

  const formatCode = async () => {
    setRuleError('')
    setRuleNotice('')
    try {
      if (!apiRef.current) throw new Error('活頁簿尚未就緒。')
      await formatSelectedCodeAsText(apiRef.current)
      setRuleNotice('所選範圍已設為文字格式；請在此格式下輸入 00123 等代碼。既有數值不會自動補回遺失的零。')
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : '無法設定文字格式。')
    }
  }

  return (
    <><main className="app-shell">
      <header className="app-bar">
        <div className="document-identity">
          <h1>Tiger Web Sheets</h1>
          <strong data-testid="current-workbook-name">{currentWorkbook.name}</strong>
          <span className="bound-file-name" data-testid="bound-file-name">
            {boundFileName ? `本機檔案：${boundFileName}` : '本機檔案：尚未選擇'}
          </span>
        </div>
        <div className="app-actions">
          <button type="button" className="secondary-button compact-button" onClick={() => requestNavigation('home')}>回到文件列表</button>
          <button type="button" className="secondary-button compact-button" onClick={() => requestNavigation('new')}>新增活頁簿</button>
          <button type="button" className="secondary-button compact-button" onClick={requestOpenLocal}>開啟本機檔案</button>
          <button type="button" className="secondary-button compact-button" onClick={requestCsvImport} disabled={csvPending}>匯入 CSV</button>
          <button type="button" className="secondary-button compact-button" onClick={requestCsvExport} disabled={csvPending || !canSave || saveActive}>匯出 CSV</button>
          <button type="button" className="secondary-button compact-button" onClick={requestXlsxImport} disabled={xlsx.busy || csvPending || !canSave || saveActive}>匯入 XLSX</button>
          <button type="button" className="secondary-button compact-button" onClick={() => void xlsx.inspectExport()} disabled={xlsx.busy || csvPending || !canSave || saveActive}>匯出 XLSX</button>
          {xlsx.notice && <span role="status">{xlsx.notice}</span>}
          <button type="button" className="secondary-button compact-button" onClick={() => void saveAs()} disabled={!canSave || saveActive}>另存新檔</button>
          <button type="button" className="secondary-button compact-button" onClick={() => setNameDialog({ mode: 'rename', target: currentWorkbook })} disabled={saveActive}>重新命名</button>
          {safeSortNotice && <span className="safe-sort-notice" role="status">{safeSortNotice}</span>}
          {filterNotice && <span className="filter-notice" role="status">{filterNotice}</span>}
          {filterError && <span className="filter-error" role="alert">{filterError}</span>}
          {csvNotice && <span className="filter-notice" role="status">{csvNotice}</span>}
          {csvError && <span className="filter-error" role="alert">{csvError}</span>}
          {loadMessage && status !== 'load-error' && <span className="filter-error" role="alert">{loadMessage}</span>}
          {recoveryWarning && <span className="filter-error" role="alert">{recoveryWarning}</span>}
          <button type="button" className="secondary-button compact-button" disabled={!canSave} onClick={() => void openRules('validation')} data-testid="validation-button">資料驗證／下拉選單</button>
          <button type="button" className="secondary-button compact-button" disabled={!canSave} onClick={() => void openRules('conditional')} data-testid="conditional-format-button">條件式格式設定</button>
          <button type="button" className="secondary-button compact-button" disabled={!canSave} onClick={() => void formatCode()} title="輸入含前置零的代碼前，先將所選範圍設為文字">代碼設為文字</button>
          {ruleError && <span className="filter-error" role="alert">{ruleError}</span>}
          {ruleNotice && <span role="status">{ruleNotice}</span>}
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
            <label className="autosave-control"><input type="checkbox" checked={autosaveEnabled} onChange={(event) => setAutosaveEnabled(event.target.checked)} data-testid="autosave-setting" />自動儲存：{autosaveEnabled ? '開' : '關'}</label>
            {autosaveEnabled && !boundFileName && <span>請先儲存並選擇 .tws.json</span>}
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
    {nameDialog && <NameDialog key={nameDialog.mode}
      title={nameDialog.mode === 'new' ? '新增活頁簿' : '重新命名活頁簿'}
      initialName={nameDialog.mode === 'rename' ? currentWorkbook.name : '未命名活頁簿'}
      confirmLabel={nameDialog.mode === 'new' ? '建立' : '重新命名'}
      pending={documentActionPending}
      onConfirm={confirmName}
      onCancel={() => setNameDialog(null)}
    />}
    {pendingNavigation && <UnsavedDialog
      pending={documentActionPending || saveActive}
      onSave={saveAndNavigate}
      onDiscard={() => {
        const action = pendingNavigation
        autosaveRef.current?.dispose()
        autosaveRef.current = null
        if (currentWorkbookRef.current) void recoveryStore.remove(currentWorkbookRef.current.id).catch(() => setRecoveryWarning('復原資料清理失敗；請勿將舊復原資料誤認為新變更。'))
        setPendingNavigation(null)
        if (action === 'open-local') {
          void openLocalFile()
          setStatus('loading'); setReloadToken((value) => value + 1)
        } else if (action === 'import-csv') {
          void importCsvFile()
          setStatus('loading'); setReloadToken((value) => value + 1)
        } else if (action === 'import-xlsx') {
          void xlsx.importFile()
          setStatus('loading'); setReloadToken((value) => value + 1)
        } else {
          performNavigation(action, true)
        }
      }}
      onCancel={() => setPendingNavigation(null)}
    />}
    {nativeCollision && <NativeCollisionDialog
      filename={nativeCollision.handle.name}
      pending={documentActionPending}
      onCopy={openCollisionAsCopy}
      onCancel={() => setNativeCollision(null)}
    />}
    {csvPreview && <CsvImportPreviewDialog
      filename={csvPreview.filename}
      table={csvPreview.table}
      error={csvError}
      pending={documentActionPending}
      onConfirm={confirmCsvImport}
      onCancel={() => setCsvPreview(null)}
    />}
    {csvExportSheets && <CsvWorksheetDialog
      sheets={csvExportSheets}
      pending={csvPending}
      onConfirm={(sheetId) => {
        const sheet = csvExportSheets.find((candidate) => candidate.id === sheetId)
        if (!sheet) return
        setCsvExportSheets(null)
        void exportCsvSheet(sheet)
      }}
      onCancel={() => setCsvExportSheets(null)}
    />}
    {xlsx.dialogs}
    {recoveryPrompt && <RecoveryDialog conflict={recoveryPrompt.conflict} pending={documentActionPending}
      onRestore={() => void chooseRecovery(true)} onStored={() => void chooseRecovery(false)}
      onCancel={() => { setRecoveryPrompt(null); recoveryDecisionRef.current = null; openingStatusRef.current = null; setCurrentWorkbook(null); setHomeReloadToken((value) => value + 1) }} />}
    </>
  )
}

export default App

