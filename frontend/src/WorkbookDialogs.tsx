import { useState } from 'react'

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
