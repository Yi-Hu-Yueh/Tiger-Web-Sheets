import {
  chooseFileForOpen,
  chooseFileForSave,
  ensureWritePermission,
  NativeFileAccessError,
  type NativeFileHandle,
  type NativeFileWritable,
  type NativePickerType,
} from './nativeFileAccess'
import { MAX_CSV_FILE_BYTES } from '../csv/csvParser'
import { suggestedCsvFilename } from '../csv/csvSerializer'

const CSV_PICKER_TYPES: NativePickerType[] = [{
  description: 'CSV File',
  accept: { 'text/csv': ['.csv'] },
}]

export class CsvEncodingError extends NativeFileAccessError {}
export class CsvFileSizeError extends NativeFileAccessError {}

export function chooseCsvOpenFile(): Promise<NativeFileHandle | null> {
  return chooseFileForOpen(CSV_PICKER_TYPES)
}

export function chooseCsvSaveFile(sheetName: string): Promise<NativeFileHandle | null> {
  return chooseFileForSave(suggestedCsvFilename(sheetName), CSV_PICKER_TYPES)
}

export async function readCsvFile(handle: NativeFileHandle): Promise<string> {
  let file: File
  try {
    file = await handle.getFile()
  } catch (error: unknown) {
    throw new NativeFileAccessError('無法讀取 CSV 檔案。', { cause: error })
  }
  if (file.size > MAX_CSV_FILE_BYTES) {
    throw new CsvFileSizeError('CSV 檔案超過 5 MiB 的安全限制。')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  } catch (error: unknown) {
    throw new CsvEncodingError('目前僅支援 UTF-8 CSV。', { cause: error })
  }
}

export async function writeCsvFile(handle: NativeFileHandle, content: string): Promise<void> {
  await ensureWritePermission(handle)
  let writable: NativeFileWritable | null = null
  try {
    writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
    writable = null
    const actual = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    const expected = new TextEncoder().encode(content)
    if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) {
      throw new NativeFileAccessError('CSV 寫入後驗證失敗。')
    }
  } catch (error: unknown) {
    if (writable?.abort) {
      try { await writable.abort() } catch { /* Preserve the original error. */ }
    }
    if (error instanceof NativeFileAccessError) throw error
    throw new NativeFileAccessError('CSV 檔案寫入失敗。', { cause: error })
  }
}
