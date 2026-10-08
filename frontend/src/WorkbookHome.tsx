import type { WorkbookSummary } from './workbookApi'

function modifiedTime(value: string): string {
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default function WorkbookHome({ workbooks, loading, error, notice, csvPending, onNew, onOpenLocal, onImportCsv, onOpen, onRename, onDelete, onRetry }: {
  workbooks: WorkbookSummary[]
  loading: boolean
  error: string
  notice: string
  csvPending: boolean
  onNew: () => void
  onOpenLocal: () => void
  onImportCsv: () => void
  onOpen: (workbook: WorkbookSummary) => void
  onRename: (workbook: WorkbookSummary) => void
  onDelete: (workbook: WorkbookSummary) => void
  onRetry: () => void
}) {
  return (
    <main className="home-shell">
      <header className="home-header">
        <div><h1>Tiger Web Sheets</h1><p>本機活頁簿</p></div>
        <div className="home-actions">
          <button type="button" className="secondary-button" onClick={onOpenLocal}>開啟本機檔案</button>
          <button type="button" className="secondary-button" onClick={onImportCsv} disabled={csvPending}>匯入 CSV</button>
          <button type="button" className="primary-button" onClick={onNew}>新增活頁簿</button>
        </div>
      </header>
      {error && <div className="home-message home-message--error" role="alert">{error}<button type="button" onClick={onRetry}>重試</button></div>}
      {notice && !error && <div className="home-message home-message--error" role="alert">{notice}</div>}
      {loading ? <div className="home-message">正在載入活頁簿…</div> : (
        <section className="workbook-list" aria-label="已儲存的活頁簿">
          {workbooks.length === 0 && <div className="empty-list"><strong>尚無活頁簿</strong><span>選擇「新增活頁簿」開始建立文件。</span></div>}
          {workbooks.map((workbook) => (
            <article className="workbook-card" key={workbook.id} data-workbook-id={workbook.id}>
              <div><h2>{workbook.name}</h2><p>修改時間 {modifiedTime(workbook.updated_at)} · 文件 {workbook.id.slice(0, 8)}</p></div>
              <div className="card-actions">
                <button type="button" className="primary-button" onClick={() => onOpen(workbook)}>開啟</button>
                <button type="button" className="secondary-button" onClick={() => onRename(workbook)}>重新命名</button>
                <button type="button" className="danger-link" onClick={() => onDelete(workbook)}>刪除</button>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
