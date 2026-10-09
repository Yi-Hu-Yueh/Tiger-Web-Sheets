import { useState } from 'react'
import type { WorkbookVersion } from '../workbookApi'

const sourceLabels: Record<WorkbookVersion['source_type'], string> = {
  manual: '手動版本',
  autosave: '自動版本',
  pre_restore: '還原前備份',
  restore: '還原版本',
}

function time(value: string) {
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function VersionLabelDialog({ dirty, pending, onConfirm, onCancel }: {
  dirty: boolean
  pending: boolean
  onConfirm: (label: string | null) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  return <div className="modal-backdrop">
    <form className="document-dialog" role="dialog" aria-modal="true" aria-labelledby="version-label-title" onSubmit={(event) => {
      event.preventDefault(); onConfirm(label.trim() || null)
    }}>
      <h2 id="version-label-title">建立版本</h2>
      <p>建立目前已提交活頁簿的永久版本。名稱可留空。</p>
      {dirty && <p className="history-warning">目前有未儲存變更；將先儲存，再建立版本。</p>}
      <label>版本名稱（選填）<input autoFocus maxLength={200} value={label} placeholder="例如：送客戶前" onChange={(event) => setLabel(event.target.value)} /></label>
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>取消</button>
        <button type="submit" className="primary-button" disabled={pending}>{pending ? '建立中…' : dirty ? '先儲存並建立版本' : '建立版本'}</button>
      </div>
    </form>
  </div>
}

export function VersionHistoryDialog({ versions, loading, pending, error, onRefresh, onCreate, onRestore, onClose }: {
  versions: WorkbookVersion[]
  loading: boolean
  pending: boolean
  error: string
  onRefresh: () => void
  onCreate: () => void
  onRestore: (version: WorkbookVersion) => void
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = versions.find((item) => item.version_id === selectedId) ?? null
  return <div className="modal-backdrop">
    <div className="document-dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <div className="history-heading"><div><h2 id="history-title">版本紀錄</h2><p>永久提交紀錄；與暫時的當機復原資料不同。</p></div><button type="button" className="safe-sort-close" aria-label="關閉版本紀錄" onClick={onClose}>×</button></div>
      <div className="history-toolbar"><button type="button" className="primary-button" disabled={pending} onClick={onCreate}>建立版本</button><button type="button" className="secondary-button" disabled={loading || pending} onClick={onRefresh}>重新整理</button></div>
      {error && <p className="filter-error" role="alert">{error}</p>}
      {loading ? <p>正在載入版本紀錄…</p> : <div className="history-layout">
        <div className="history-list" role="list" aria-label="活頁簿版本">
          {!versions.length && <p>尚無版本紀錄。</p>}
          {versions.map((version) => <button type="button" role="listitem" key={version.version_id} className={`history-item${selectedId === version.version_id ? ' history-item--selected' : ''}`} onClick={() => setSelectedId(version.version_id)}>
            <strong>{version.label ? `「${version.label}」` : sourceLabels[version.source_type]}</strong>
            <span>{time(version.created_at)} · {sourceLabels[version.source_type]}</span>
            <span>來源版本 {version.source_revision}{version.integrity === 'corrupt' ? ' · 版本資料損毀' : ''}</span>
          </button>)}
        </div>
        <div className="history-preview">
          {selected ? <>
            <h3>{selected.label || sourceLabels[selected.source_type]}</h3>
            <dl><dt>建立時間</dt><dd>{time(selected.created_at)}</dd><dt>來源</dt><dd>{sourceLabels[selected.source_type]} · 版本 {selected.source_revision}</dd><dt>工作表</dt><dd>{selected.worksheet_count} 個：{selected.worksheet_names.join('、') || '無法讀取'}</dd><dt>已填儲存格</dt><dd>{selected.populated_cell_count.toLocaleString('zh-TW')}</dd></dl>
            {selected.integrity === 'corrupt' && <p className="filter-error" role="alert">版本資料損毀，已禁止還原。</p>}
            <button type="button" className="danger-button" disabled={pending || selected.integrity !== 'ok'} onClick={() => onRestore(selected)}>還原此版本</button>
          </> : <p>選取一個版本以查看還原前預覽。</p>}
        </div>
      </div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={pending} onClick={onClose}>關閉</button></div>
    </div>
  </div>
}

export function RestoreVersionDialog({ version, pending, onConfirm, onCancel }: {
  version: WorkbookVersion
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return <div className="modal-backdrop history-confirm-backdrop">
    <div className="document-dialog" role="alertdialog" aria-modal="true" aria-labelledby="restore-version-title">
      <h2 id="restore-version-title">確定要還原到此版本嗎？</h2>
      <p>{version.label ? `「${version.label}」` : sourceLabels[version.source_type]} · {time(version.created_at)}</p>
      <p className="history-warning">目前版本會先建立安全備份。還原會建立新的目前版本，不會倒退版本編號。</p>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>取消</button><button type="button" className="danger-button" disabled={pending} onClick={onConfirm}>{pending ? '還原中…' : '確認還原'}</button></div>
    </div>
  </div>
}
