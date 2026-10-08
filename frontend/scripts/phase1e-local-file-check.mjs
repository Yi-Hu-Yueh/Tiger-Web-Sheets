import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import ts from 'typescript'

const source = await readFile(new URL('../src/files/nativeFileAccess.ts', import.meta.url), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
const native = await import(moduleUrl)

const snapshot = {
  id: 'sheet-book',
  name: 'Local file fixture',
  appVersion: '1.0.0',
  locale: 'zhTW',
  styles: {},
  sheetOrder: ['sheet-01'],
  sheets: {
    'sheet-01': {
      id: 'sheet-01',
      name: '工作表1',
      rowCount: 100,
      columnCount: 26,
      cellData: { 0: { 0: { v: 'FIRST_SAVE' } } },
    },
  },
}

const document = {
  format: native.NATIVE_FORMAT,
  format_version: native.NATIVE_FORMAT_VERSION,
  workbook_id: 'fixture-id',
  revision: 3,
  saved_at: '2026-10-08T00:00:00+00:00',
  snapshot_sha256: await native.snapshotSha256(snapshot),
  snapshot,
}
assert.equal(document.snapshot_sha256, 'a9d1178fae391c8b702251cc2cf2e434b6c3fcda1c907a5bf03d0f50916492b2')

function fakeHandle({
  name = 'fixture.tws.json',
  initial = JSON.stringify(document),
  query = 'granted',
  requested = 'granted',
  failWrite = false,
} = {}) {
  let content = initial
  let requestCount = 0
  let writeCount = 0
  return {
    kind: 'file',
    name,
    async getFile() {
      return new File([content], name, { type: 'application/json' })
    },
    async queryPermission() {
      return query
    },
    async requestPermission() {
      requestCount += 1
      return requested
    },
    async createWritable() {
      if (failWrite) throw new Error('controlled external write failure')
      let pending = content
      return {
        async write(value) {
          writeCount += 1
          pending = value
        },
        async close() {
          content = pending
        },
      }
    },
    stats() {
      return { content, requestCount, writeCount }
    },
  }
}

globalThis.window = {}
assert.equal(native.supportsNativeFilePickers(), false)
await assert.rejects(native.chooseNativeOpenFile(), native.NativeFileAccessUnsupportedError)

let openOptions
let saveOptions
const opened = fakeHandle()
const saved = fakeHandle({ name: '客戶名單.tws.json' })
window.showOpenFilePicker = async (options) => {
  openOptions = options
  return [opened]
}
window.showSaveFilePicker = async (options) => {
  saveOptions = options
  return saved
}
assert.equal(native.supportsNativeFilePickers(), true)
assert.equal(await native.chooseNativeOpenFile(), opened)
assert.equal(await native.chooseNativeSaveFile('客戶名單'), saved)
assert.deepEqual(openOptions.types[0].accept['application/json'], ['.tws.json'])
assert.equal(saveOptions.suggestedName, '客戶名單.tws.json')

window.showOpenFilePicker = async () => {
  throw new DOMException('cancel', 'AbortError')
}
window.showSaveFilePicker = async () => {
  throw new DOMException('cancel', 'AbortError')
}
assert.equal(await native.chooseNativeOpenFile(), null)
assert.equal(await native.chooseNativeSaveFile('cancel'), null)

window.showSaveFilePicker = async () => {
  throw new DOMException('activation lost', 'SecurityError')
}
await assert.rejects(
  native.chooseNativeSaveFile('activation'),
  (error) => error instanceof native.NativeFileAccessError && error.message.includes('SecurityError'),
)

assert.deepEqual(await native.parseNativeWorkbookText(JSON.stringify(document)), document)
await assert.rejects(native.parseNativeWorkbookText('{bad json'), native.NativeFileValidationError)
await assert.rejects(native.parseNativeWorkbookText(JSON.stringify({ ...document, format: 'wrong' })), native.NativeFileValidationError)
await assert.rejects(native.parseNativeWorkbookText(JSON.stringify({ ...document, format_version: 99 })), native.NativeFileValidationError)
await assert.rejects(native.parseNativeWorkbookText(JSON.stringify({ ...document, saved_at: '2026-10-08T00:00:00' })), native.NativeFileValidationError)
await assert.rejects(native.parseNativeWorkbookText(JSON.stringify({ ...document, snapshot_sha256: '0'.repeat(64) })), native.NativeFileValidationError)

const bound = fakeHandle()
let pickerCalls = 0
window.showSaveFilePicker = async () => {
  pickerCalls += 1
  return bound
}
await native.writeNativeWorkbook(bound, document)
assert.equal(bound.stats().writeCount, 1)
assert.equal(pickerCalls, 0)
await native.bindNativeFileHandle('session-workbook', bound)
assert.equal(await native.restoreNativeFileHandle('session-workbook'), bound)
await native.forgetNativeFileHandle('session-workbook')
assert.equal(await native.restoreNativeFileHandle('session-workbook'), null)

const reauthorize = fakeHandle({ query: 'prompt', requested: 'granted' })
await native.writeNativeWorkbook(reauthorize, document)
assert.equal(reauthorize.stats().requestCount, 1)

const denied = fakeHandle({ query: 'denied', requested: 'denied' })
await assert.rejects(native.writeNativeWorkbook(denied, document), native.NativeFilePermissionError)
assert.equal(denied.stats().writeCount, 0)
let deniedCommitCalls = 0
await assert.rejects(
  native.commitThenWriteNativeFile(
    denied,
    async () => { deniedCommitCalls += 1; return { id: 'must-not-commit' } },
    async () => document,
  ),
  (error) => error instanceof native.NativePersistenceError && error.committed === undefined,
)
assert.equal(deniedCommitCalls, 0)

const backendFailureHandle = fakeHandle()
await assert.rejects(
  native.commitThenWriteNativeFile(
    backendFailureHandle,
    async () => { throw new Error('controlled backend failure') },
    async () => document,
  ),
  (error) => error instanceof native.NativePersistenceError && error.stage === 'internal',
)
assert.equal(backendFailureHandle.stats().writeCount, 0)

const externalFailureHandle = fakeHandle({ failWrite: true })
await assert.rejects(
  native.commitThenWriteNativeFile(
    externalFailureHandle,
    async () => ({ id: 'committed' }),
    async () => document,
  ),
  (error) => (
    error instanceof native.NativePersistenceError &&
    error.stage === 'external' &&
    error.committed.id === 'committed'
  ),
)

console.log(JSON.stringify({
  result: 'PASS',
  pickerSupportDetection: true,
  openAndSavePickerTypes: true,
  cancelSafe: true,
  schemaAndHashValidation: true,
  boundHandleSaveWithoutPicker: true,
  sessionHandleFallback: true,
  permissionDeniedAndReauthorization: true,
  backendAndExternalFailureSeparation: true,
}, null, 2))
