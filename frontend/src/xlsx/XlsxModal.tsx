import { useEffect, useRef, type ReactNode } from 'react'

export default function XlsxModal({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="xlsx-dialog" onCancel={(event) => { event.preventDefault(); onCancel() }}>{children}</dialog>
}
