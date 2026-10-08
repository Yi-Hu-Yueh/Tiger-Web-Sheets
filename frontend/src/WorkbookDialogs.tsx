import { useState } from 'react'
import { CSV_PREVIEW_ROWS, type CsvTable } from './csv/csvParser'

export function NameDialog({
  title,
  initialName = '',
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string
  initialName?: string
  confirmLabel: string
  pending: boolean
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  return (
    <div className="modal-backdrop">
      <form className="document-dialog" role="dialog" aria-modal="true" aria-labelledby="name-dialog-title" onSubmit={(event) => {
        event.preventDefault()
        const trimmed = name.trim()
        if (trimmed) onConfirm(trimmed)
      }}>
        <h2 id="name-dialog-title">{title}</h2>
        <label>活頁簿名稱<input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} /></label>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="submit" className="primary-button" disabled={pending || !name.trim()}>{pending ? '處理中…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  )
}

export function DeleteDialog({ name, pending, onConfirm, onCancel }: {
  name: string
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-backdrop">
      <div className="document-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-dialog-title">
        <h2 id="delete-dialog-title">確定要刪除「{name}」嗎？</h2>
        <p>此操作無法復原。</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={pending}>{pending ? '刪除中…' : '確認刪除'}</button>
        </div>
      </div>
    </div>
  )
}

export function UnsavedDialog({ pending, onSave, onDiscard, onCancel }: {
  pending: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-backdrop">
      <div className="document-dialog" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-dialog-title">
        <h2 id="unsaved-dialog-title">尚有未儲存的變更</h2>
        <p>離開前要儲存目前的活頁簿嗎？</p>
        <div className="dialog-actions dialog-actions--three">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="button" className="secondary-button" onClick={onDiscard} disabled={pending}>放棄變更</button>
          <button type="button" className="primary-button" onClick={onSave} disabled={pending}>{pending ? '儲存中…' : '儲存並繼續'}</button>
        </div>
      </div>
    </div>
  )
}

export function NativeCollisionDialog({ filename, pending, onCopy, onCancel }: {
  filename: string
  pending: boolean
  onCopy: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-backdrop">
      <div className="document-dialog" role="alertdialog" aria-modal="true" aria-labelledby="native-collision-title">
        <h2 id="native-collision-title">本機檔案識別衝突</h2>
        <p>「{filename}」的文件識別已存在，但內容或版本不同。Tiger 不會覆寫既有文件。</p>
        <p>選擇「以副本開啟」會建立新的 Tiger 文件識別；所選檔案要等您按下儲存後才會更新。</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="button" className="primary-button" onClick={onCopy} disabled={pending}>{pending ? '建立副本中…' : '以副本開啟'}</button>
        </div>
      </div>
    </div>
  )
}

export function CsvImportPreviewDialog({ filename, table, error, pending, onConfirm, onCancel }: {
  filename: string
  table: CsvTable
  error: string
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-backdrop">
      <div className="document-dialog csv-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="csv-preview-title">
        <h2 id="csv-preview-title">匯入 CSV 預覽</h2>
        <p><strong>{filename}</strong></p>
        <p>{table.rowCount.toLocaleString('zh-TW')} 列 × {table.columnCount.toLocaleString('zh-TW')} 欄</p>
        <p className="csv-warning">CSV 只包含單一表格，不保留公式與格式。所有欄位會以文字匯入。</p>
        {error && <p className="filter-error" role="alert">{error}</p>}
        <div className="csv-preview-scroll">
          <table className="csv-preview-table">
            <tbody>
              {table.rows.slice(0, CSV_PREVIEW_ROWS).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((value, columnIndex) => <td key={columnIndex}>{value}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {table.rowCount > CSV_PREVIEW_ROWS && <p>僅顯示前 {CSV_PREVIEW_ROWS} 列。</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="button" className="primary-button" onClick={onConfirm} disabled={pending}>{pending ? '匯入中…' : '確認匯入'}</button>
        </div>
      </div>
    </div>
  )
}

export function CsvWorksheetDialog({ sheets, pending, onConfirm, onCancel }: {
  sheets: Array<{ id: string; name: string }>
  pending: boolean
  onConfirm: (sheetId: string) => void
  onCancel: () => void
}) {
  const [sheetId, setSheetId] = useState(sheets[0]?.id ?? '')
  return (
    <div className="modal-backdrop">
      <form className="document-dialog" role="dialog" aria-modal="true" aria-labelledby="csv-sheet-title" onSubmit={(event) => {
        event.preventDefault()
        if (sheetId) onConfirm(sheetId)
      }}>
        <h2 id="csv-sheet-title">匯出 CSV</h2>
        <p className="csv-warning">CSV 只匯出一個工作表的顯示值，不保留公式與格式。</p>
        <label>要匯出的工作表：
          <select autoFocus value={sheetId} onChange={(event) => setSheetId(event.target.value)}>
            {sheets.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="submit" className="primary-button" disabled={pending || !sheetId}>{pending ? '匯出中…' : '選擇儲存位置'}</button>
        </div>
      </form>
    </div>
  )
}
