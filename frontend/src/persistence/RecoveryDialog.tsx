import { useEffect, useRef } from 'react'

export default function RecoveryDialog({ conflict, pending, onRestore, onStored, onCancel }: {
  conflict: boolean; pending: boolean; onRestore: () => void; onStored: () => void; onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="xlsx-dialog" onCancel={(event) => { event.preventDefault(); if (!pending) onCancel() }} aria-labelledby="recovery-title">
    <h2 id="recovery-title">偵測到未完成儲存的復原資料</h2>
    <p>復原只載入未儲存的本機變更，不會直接覆寫已儲存版本。</p>
    {conflict && <p role="alert">已儲存版本已變更。復原後保留原始基礎版本，儲存會受到衝突保護；請另存新檔保留兩個版本。</p>}
    <button disabled={pending} onClick={onRestore}>復原</button>
    <button disabled={pending} onClick={onStored}>使用已儲存版本</button>
    <button disabled={pending} onClick={onCancel}>取消</button>
  </dialog>
}
