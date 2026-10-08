import { useEffect, useRef, useState } from 'react'
import type { IWorkbookData } from '@univerjs/core'
import { chooseXlsxOpenFile, chooseXlsxSaveFile, readXlsxFile, writeXlsxFile, xlsxName } from '../files/xlsxFileAccess'
import { runXlsxWorker } from './xlsxWorkerClient'
import { assertAllowed, type ImportResult, type ExportResult, type Summary } from './xlsxTypes'
import Modal from './XlsxModal'
export function useXlsx({ collect, commit }: {
  collect: (signal: AbortSignal) => Promise<IWorkbookData>
  commit: (name: string, snapshot: IWorkbookData) => Promise<void>
}) {
  const controller = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<{ filename: string; name: string; result: ImportResult } | null>(null)
  const [exportPreview, setExportPreview] = useState<{ snapshot: IWorkbookData; summary: Summary } | null>(null)
  const [committing, setCommitting] = useState(false)
  const busy = progress !== null || committing
  useEffect(() => () => { controller.current?.abort() }, [])
  const cancel = () => { controller.current?.abort(); setPreview(null); setExportPreview(null) }
  const begin = () => {
    const next = new AbortController(); controller.current = next
    setError(''); setNotice(''); setProgress('處理 XLSX 中…'); return next
  }
  const failed = (reason: unknown) => {
    if (reason instanceof DOMException && reason.name === 'AbortError') setNotice('XLSX 處理已取消；不宣告匯入 / 匯出成功。Tiger 儲存狀態未變更。')
    else setError(reason instanceof Error ? reason.message : 'XLSX 處理失敗。')
  }
  const importFile = async () => {
    if (controller.current || preview || exportPreview || committing) return
    const operation = begin()
    try {
      const handle = await chooseXlsxOpenFile()
      if (!handle) return
      const name = xlsxName(handle.name)
      const bytes = await readXlsxFile(handle, operation.signal)
      const { result } = await runXlsxWorker<ImportResult>({ operation: 'import', bytes, name }, operation.signal, setProgress)
      operation.signal.throwIfAborted()
      setPreview({ filename: handle.name, name, result })
    } catch (reason) { failed(reason) }
    finally { controller.current = null; setProgress(null) }
  }
  const inspectExport = async () => {
    if (controller.current || preview || exportPreview || committing) return
    const operation = begin()
    try {
      setProgress('等候 Tiger 公式重新計算…')
      const snapshot = await collect(operation.signal)
      const { result: summary } = await runXlsxWorker<Summary>({ operation: 'inspect', snapshot }, operation.signal, setProgress)
      operation.signal.throwIfAborted()
      setExportPreview({ snapshot, summary })
    } catch (reason) { failed(reason) }
    finally { controller.current = null; setProgress(null) }
  }
  const confirmImport = async () => {
    if (!preview || committing) return
    setCommitting(true); setError('')
    try {
      assertAllowed(preview.result.summary)
      await commit(preview.name, preview.result.snapshot)
      setPreview(null)
      setNotice('XLSX 已匯入新的 Tiger 活頁簿；請正常儲存為 .tws.json。')
    } catch (reason) { failed(reason) }
    finally { setCommitting(false) }
  }
  const confirmExport = async () => {
    if (!exportPreview || controller.current) return
    const operation = begin()
    try {
      assertAllowed(exportPreview.summary)
      // Picker starts directly in this confirmation gesture, before any await-heavy work.
      const handle = await chooseXlsxSaveFile(exportPreview.snapshot.name)
      if (!handle) return
      const { result } = await runXlsxWorker<ExportResult>({ operation: 'export', snapshot: exportPreview.snapshot }, operation.signal, setProgress)
      operation.signal.throwIfAborted()
      setProgress('寫入並核對 XLSX 檔案…')
      await writeXlsxFile(handle, result.bytes, operation.signal)
      setNotice(`已匯出並驗證 ${handle.name}；Tiger 活頁簿儲存狀態未變更。`)
    } catch (reason) { failed(reason) }
    finally { controller.current = null; setProgress(null); setExportPreview(null) }
  }
  const summary = preview?.result.summary ?? exportPreview?.summary
  const refused = summary?.findings.some((finding) => finding.level === 'UNSUPPORTED')
  const dialogs = <>
    {error && !summary && !progress && <Modal onCancel={() => setError('')}><h2>XLSX 處理失敗</h2><p role="alert">{error}</p><button onClick={() => setError('')}>關閉</button></Modal>}
    {progress && <Modal onCancel={cancel}><h2>XLSX 處理中</h2><p role="status">{progress}</p><button onClick={cancel}>取消處理</button></Modal>}
    {summary && !progress && <Modal onCancel={() => { if (!committing) cancel() }}>
      <h2>{preview ? 'XLSX 匯入相容性預覽' : 'XLSX 匯出相容性摘要'}</h2>
      {preview && <p>檔案：{preview.filename}；將建立新的活頁簿，不覆寫原文件。</p>}
      <p>{summary.sheets.length} 個工作表：{summary.sheets.join('、')}；約 {summary.cells.toLocaleString()} 個有內容或格式的儲存格。</p>
      <p>XLSX 是交換格式；.tws.json 才是 Tiger 原生格式。欄寬為近似值；不保證 Excel 外觀完全一致。</p>
      <ul>{summary.findings.map((finding) => <li key={finding.code}>{finding.level}：{finding.message}（{finding.count}）</li>)}</ul>
      {error && <p role="alert">{error}</p>}
      <p>WARNING 所列未支援內容會遺失；確認後才繼續。UNSUPPORTED 拒絕處理。</p>
      <button disabled={committing} onClick={cancel}>取消</button>
      <button disabled={committing || refused} onClick={() => void (preview ? confirmImport() : confirmExport())}>{committing ? '建立中…' : preview ? '繼續匯入' : '繼續匯出'}</button>
    </Modal>}
  </>
  return { busy, notice, dialogs, importFile, inspectExport }
}
