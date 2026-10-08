import { chooseFileForOpen, chooseFileForSave, ensureWritePermission, type NativeFileHandle, type NativeFileWritable } from './nativeFileAccess'
import { XLSX_LIMITS } from '../xlsx/xlsxTypes'

const types = [{ description: 'Excel XLSX（認證基本交換格式）', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]
export const chooseXlsxOpenFile = () => chooseFileForOpen(types)
export const chooseXlsxSaveFile = (name: string) => chooseFileForSave(`${name.replace(/[\\/:*?"<>|]/g, '_') || '未命名活頁簿'}.xlsx`, types)
export const xlsxName = (filename: string) => filename.replace(/\.xlsx$/i, '').trim().slice(0, 120) || '匯入的活頁簿'
export async function readXlsxFile(handle: NativeFileHandle, signal: AbortSignal) {
  const file = await handle.getFile()
  signal.throwIfAborted()
  if (file.size > XLSX_LIMITS.compressed) throw new Error('XLSX 檔案超過 10 MiB，拒絕匯入。')
  const bytes = await file.arrayBuffer()
  signal.throwIfAborted()
  return bytes
}
export async function writeXlsxFile(handle: NativeFileHandle, bytes: ArrayBuffer, signal: AbortSignal) {
  signal.throwIfAborted()
  await ensureWritePermission(handle)
  signal.throwIfAborted()
  let writable: NativeFileWritable | null = null
  const abort = () => { void writable?.abort?.().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    writable = await handle.createWritable()
    signal.throwIfAborted()
    await writable.write(bytes)
    signal.throwIfAborted()
    await writable.close()
    writable = null
    const actual = new Uint8Array(await (await handle.getFile()).arrayBuffer()), expected = new Uint8Array(bytes)
    if (actual.length !== expected.length || actual.some((byte, i) => byte !== expected[i])) throw new Error('XLSX 寫入後位元組驗證失敗；不宣告成功。')
    signal.throwIfAborted()
  } catch (error: unknown) {
    await writable?.abort?.().catch(() => {})
    throw error
  } finally { signal.removeEventListener('abort', abort) }
}
