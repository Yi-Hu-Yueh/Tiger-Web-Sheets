import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { IDBFactory } from 'fake-indexeddb'
import { CommandType } from '@univerjs/core'

const root = fileURLToPath(new URL('../../', import.meta.url))
const modules = new Map()
async function moduleUrl(filename) {
  const absolute = path.resolve(filename)
  if (modules.has(absolute)) return modules.get(absolute)
  let source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  source = source.replaceAll('import.meta.env', '({ VITE_TIGER_INSTANCE_NONCE: "phase1h-unit-test" })')
  for (const match of [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]) {
    const resolved = match[1].startsWith('.') ? await moduleUrl(path.resolve(path.dirname(absolute), `${match[1]}.ts`)) : import.meta.resolve(match[1])
    source = source.replace(match[0], `from '${resolved}'`)
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  modules.set(absolute, url); return url
}
const production = async (name) => import(await moduleUrl(path.join(root, 'frontend/src', name)))
const { AutosaveCoordinator } = await production('persistence/autosaveCoordinator.ts')
const { RecoveryStore, RECOVERY_LIMITS, recoveryDisposition } = await production('persistence/recoveryStore.ts')
const { isPersistedWorkbookMutation } = await production('persistence/workbookMutation.ts')
const native = await production('files/nativeFileAccess.ts')
const ownerFingerprint = async () => {
  const files = [path.join(root, 'data/tiger_web_sheets.db'), ...(await fs.readdir(path.join(root, 'workbooks'))).map((file) => path.join(root, 'workbooks', file))]
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
}
const ownerBefore = await ownerFingerprint()
const results = {}
const test = async (name, action) => { await action(); results[name] = 'PASS' }
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate) }
function fakeClock() {
  let time = 0, id = 0
  const timers = new Map()
  return { set(callback, delay) { timers.set(++id, { at: time + delay, callback }); return id }, clear(timer) { timers.delete(timer) },
    async tick(delay) {
      const end = time + delay
      while (true) {
        const next = [...timers].sort(([, a], [, b]) => a.at - b.at)[0]
        if (!next || next[1].at > end) break
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await settle()
      }
      time = end; await settle()
    } }
}
const snapshot = (value = '未完成儲存') => ({ id: 'model-A', name: '復原測試', appVersion: '1.0.0', locale: 'zhTW', styles: {}, sheetOrder: ['s'], sheets: { s: { id: 's', name: '工作表1', rowCount: 100, columnCount: 26, cellData: { 0: { 0: { v: value } } } } } })
const committed = { id: 'book-A', revision: 8, updated_at: '2026-10-09T00:00:00Z', snapshot: snapshot('已儲存') }
const checkpoint = (options = {}) => ({ workbookId: committed.id, baseRevision: 8, baseUpdatedAt: committed.updated_at, timestamp: Date.now(), sessionId: 'session-A', generation: 1, snapshot: snapshot(), ...options })
function scheduler(options = {}) {
  const clock = fakeClock(), state = { generation: 0, writes: 0, checkpoints: 0, errors: [], enabled: true, bound: true }
  const coordinator = new AutosaveCoordinator({ clock, generation: () => state.generation, eligible: () => state.enabled && state.bound,
    save: async () => { state.writes++; return { ok: true, generation: state.generation } }, checkpoint: async () => { state.checkpoints++ }, recoveryError: (error) => state.errors.push(error), ...options })
  return { clock, state, coordinator, edit() { state.generation++; coordinator.mutation() } }
}
await test('debounce / four edits coalesce / selection does not save', async () => {
  const h = scheduler()
  await h.clock.tick(4000); assert.equal(h.state.writes, 0)
  for (let i = 0; i < 4; i++) { h.edit(); await h.clock.tick(200) }
  await h.clock.tick(2799); assert.equal(h.state.writes, 0)
  await h.clock.tick(1); assert.equal(h.state.writes, 1); assert.equal(h.state.checkpoints, 1)
  h.coordinator.dispose()
})
await test('autosave OFF and first-file-binding gate / manual independent', async () => {
  const h = scheduler(); h.state.enabled = false; h.edit(); await h.clock.tick(4000)
  assert.equal(h.state.writes, 0); assert.equal(h.state.checkpoints, 1)
  assert.equal(await h.coordinator.flush(), true); assert.equal(h.state.writes, 1)
  h.state.enabled = true; h.state.bound = false; h.edit(); await h.clock.tick(4000); assert.equal(h.state.writes, 1)
  h.state.bound = true; h.coordinator.resume(); await h.clock.tick(3000); assert.equal(h.state.writes, 2)
})
await test('manual Save flushes pending autosave / no duplicate write', async () => {
  const h = scheduler(); h.edit(); await h.clock.tick(1000); assert.equal(await h.coordinator.flush(), true)
  await h.clock.tick(5000); assert.equal(h.state.writes, 1)
})
await test('edit during active autosave / manual joins and drains latest', async () => {
  let release, h
  h = scheduler({ save: async () => {
    const generation = h.state.generation; h.state.writes++
    if (h.state.writes === 1) await new Promise((resolve) => { release = resolve })
    return { ok: true, generation }
  } })
  h.edit(); await h.clock.tick(3000); h.edit()
  const manual = h.coordinator.flush(); release()
  assert.equal(await manual, true); assert.equal(h.state.writes, 2)
  await h.clock.tick(4000); assert.equal(h.state.writes, 2)
})
await test('edit during active save schedules subsequent automatic save', async () => {
  let release, h
  h = scheduler({ save: async () => { const generation = h.state.generation; h.state.writes++; if (h.state.writes === 1) await new Promise((resolve) => { release = resolve }); return { ok: true, generation } } })
  h.edit(); await h.clock.tick(3000); h.edit(); release(); await settle()
  await h.clock.tick(2999); assert.equal(h.state.writes, 1)
  await h.clock.tick(1); assert.equal(h.state.writes, 2)
})
await test('failure pauses automatic retries / edit retained / explicit retry', async () => {
  let failed = true, h
  h = scheduler({ save: async () => { h.state.writes++; return { ok: !failed, generation: h.state.generation } } })
  h.edit(); await h.clock.tick(3000); h.edit(); await h.clock.tick(9000)
  assert.equal(h.state.writes, 1); assert.ok(h.state.checkpoints > 0)
  failed = false; assert.equal(await h.coordinator.flush(), true); assert.equal(h.state.writes, 2)
})
await test('switch cancels pending save / failed final save prevents continuation', async () => {
  const h = scheduler(); h.edit(); h.coordinator.dispose(); await h.clock.tick(4000); assert.equal(h.state.writes, 0)
  const failed = scheduler({ save: async () => ({ ok: false, generation: 1 }) }); failed.edit()
  let switched = false; if (await failed.coordinator.flush()) switched = true
  assert.equal(switched, false)
})
await test('continuous editing has bounded recovery max-wait', async () => {
  const h = scheduler()
  for (let i = 0; i < 12; i++) { h.edit(); await h.clock.tick(200) }
  assert.ok(h.state.checkpoints >= 1); assert.equal(h.state.writes, 0); h.coordinator.dispose()
})
await test('formula-result / selection / hydration exclusions retained', async () => {
  for (const event of [{ id: 'sheet.operation.set-selections', type: CommandType.OPERATION }, { id: 'formula.mutation.set-formula-calculation-result', type: CommandType.MUTATION }, { id: 'sheet.mutation.set-range-values', type: CommandType.MUTATION }, { id: 'doc.mutation.rich-text-editing', type: CommandType.MUTATION }]) assert.equal(isPersistedWorkbookMutation(event), false)
  for (const event of [{ id: 'sheet.command.replace', type: CommandType.COMMAND }, { id: 'sheet.command.set-range-values', type: CommandType.COMMAND }, { id: 'sheet.mutation.set-range-values', type: CommandType.MUTATION, params: { trigger: 'user' } }, { id: 'sheet.mutation.set-style', type: CommandType.MUTATION }, { id: 'sheet.mutation.set-name', type: CommandType.MUTATION }]) assert.equal(isPersistedWorkbookMutation(event), true)
})

const factory = new IDBFactory(), store = new RecoveryStore('isolated-unit', factory)
await test('IndexedDB checkpoint commits / survives new store instance / snapshot cloned', async () => {
  const source = checkpoint(); const pending = store.write(source); source.snapshot.sheets.s.cellData[0][0].v = 'MUTATED_AFTER_QUEUE'; await pending
  const record = await new RecoveryStore('isolated-unit', factory).read('book-A')
  assert.equal(record.snapshot.sheets.s.cellData[0][0].v, '未完成儲存')
  assert.equal(recoveryDisposition(record, committed), 'restore')
  const legacyFactory = new IDBFactory()
  const legacy = await new Promise((resolve, reject) => {
    const request = legacyFactory.open('tiger-web-sheets-recovery-legacy-test', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('checkpoints', { keyPath: 'workbookId' })
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result)
  })
  await new Promise((resolve, reject) => {
    const transaction = legacy.transaction('checkpoints', 'readwrite'); transaction.objectStore('checkpoints').put(record)
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error)
  })
  legacy.close()
  const upgraded = new RecoveryStore('legacy-test', legacyFactory)
  assert.deepEqual(await upgraded.read('book-A'), record)
  await upgraded.write(checkpoint({ workbookId: 'upgrade-B' })); assert.ok(await upgraded.read('upgrade-B'))
})
await test('recovery apply/discard/cancel / stale revision stays conflict', async () => {
  const record = await store.read('book-A'), restored = structuredClone(record.snapshot)
  assert.equal(restored.sheets.s.cellData[0][0].v, '未完成儲存'); assert.equal(record.baseRevision, 8)
  assert.equal(recoveryDisposition(record, { ...committed, revision: 9 }), 'conflict')
  assert.equal(recoveryDisposition(record, { ...committed, snapshot: record.snapshot }), 'none')
  assert.equal((await store.read('book-A')).generation, 1, 'cancel leaves checkpoint untouched')
  await store.acknowledge(record.workbookId, record.sessionId, record.generation)
  assert.equal(await store.read('book-A'), null)
})
await test('workbook and runtime namespace isolation / Save As identity', async () => {
  await store.write(checkpoint()); await store.write(checkpoint({ workbookId: 'book-B', snapshot: snapshot('ONLY_B') }))
  assert.equal((await store.read('book-A')).snapshot.sheets.s.cellData[0][0].v, '未完成儲存')
  assert.equal((await store.read('book-B')).snapshot.sheets.s.cellData[0][0].v, 'ONLY_B')
  assert.equal(await store.read('save-as-copy'), null)
  assert.equal(await new RecoveryStore('different-test-nonce', factory).read('book-A'), null)
})
await test('ordered save cleanup never removes newer edit or another session', async () => {
  await store.write(checkpoint({ generation: 2 })); await store.acknowledge('book-A', 'session-A', 1)
  assert.equal((await store.read('book-A')).generation, 2)
  await store.acknowledge('book-A', 'other-session', 99); assert.ok(await store.read('book-A'))
  await store.acknowledge('book-A', 'session-A', 2); assert.equal(await store.read('book-A'), null)
  await store.remove('book-B'); assert.equal(await store.read('book-B'), null)
})
await test('recovery capacity / expiry / unavailable storage fails visibly', async () => {
  await assert.rejects(store.write(checkpoint({ snapshot: snapshot('x'.repeat(RECOVERY_LIMITS.bytes)) })))
  const bounded = new RecoveryStore('bounded', factory)
  for (let i = 0; i < 32; i++) await bounded.write(checkpoint({ workbookId: `limit-${i}` }))
  await assert.rejects(bounded.write(checkpoint({ workbookId: 'limit-33' })))
  assert.ok(await bounded.read('limit-0'), 'live checkpoints are not silently evicted')
  const payloadBudget = new RecoveryStore('total-payload-limit', factory)
  const eightMiB = snapshot('x'.repeat(8 * 1024 * 1024))
  for (let i = 0; i < 7; i++) await payloadBudget.write(checkpoint({ workbookId: `payload-${i}`, snapshot: eightMiB }))
  await assert.rejects(payloadBudget.write(checkpoint({ workbookId: 'payload-overflow', snapshot: eightMiB })))
  assert.equal(await payloadBudget.read('payload-overflow'), null)
  assert.ok(await payloadBudget.read('payload-0'))
  await store.write(checkpoint({ timestamp: Date.now() - RECOVERY_LIMITS.age - 1 }))
  await store.write(checkpoint({ workbookId: 'new' })); assert.equal(await store.read('book-A'), null)
  await assert.rejects(new RecoveryStore('unavailable', undefined).write(checkpoint()))
})
await test('reload before autosave debounce / recovery already durable', async () => {
  let h
  h = scheduler({ checkpoint: async () => store.write(checkpoint({ workbookId: 'crash', generation: h.state.generation })) })
  h.edit(); await h.clock.tick(500); h.coordinator.dispose()
  const record = await new RecoveryStore('isolated-unit', factory).read('crash')
  assert.ok(record); assert.equal(h.state.writes, 0)
})
function fileHandle() {
  const state = { permission: 'granted', prompts: 0, writes: 0, text: '', fail: false }
  const handle = { kind: 'file', name: 'test-only.tws.json', queryPermission: async () => state.permission,
    requestPermission: async () => { state.prompts++; state.permission = 'granted'; return 'granted' },
    getFile: async () => new File([state.text], 'test-only.tws.json'),
    createWritable: async () => { if (state.fail) throw new Error('disk failure'); return { write: async (text) => { state.writes++; state.text = text }, close: async () => {} } } }
  return { state, handle }
}
const documentFor = async (revision, snapshot) => ({ format: native.NATIVE_FORMAT, format_version: 1, workbook_id: 'book-A', revision, saved_at: '2026-10-09T00:00:00Z', snapshot_sha256: await native.snapshotSha256(snapshot), snapshot })
await test('native autosave verifies all targets / external permission never prompts', async () => {
  const h = fileHandle(); let revision = 8
  const doc = await documentFor(9, snapshot())
  await native.commitThenWriteNativeFile(h.handle, async () => ({ revision: ++revision }), async () => doc, false)
  assert.equal(revision, 9); assert.equal(h.state.writes, 1); assert.equal(h.state.prompts, 0)
  h.state.permission = 'prompt'
  await assert.rejects(native.commitThenWriteNativeFile(h.handle, async () => ({ revision: ++revision }), async () => doc, false), (error) => error.cause instanceof native.NativeFilePermissionError)
  assert.equal(revision, 9); assert.equal(h.state.prompts, 0)
  await native.ensureWritePermission(h.handle); assert.equal(h.state.prompts, 1)
})
await test('backend/SQLite/managed-mirror failure never writes external / conflict is preserved', async () => {
  for (const failure of ['backend unavailable', 'SQLite failure', 'managed mirror failure', '409 stale revision']) {
    const h = fileHandle()
    await assert.rejects(native.commitThenWriteNativeFile(h.handle, async () => { throw new Error(failure) }, async () => { throw new Error('must not load') }, false), (error) => error.stage === 'internal' && error.cause.message === failure)
    assert.equal(h.state.writes, 0)
  }
})
await test('external disk failure retains committed recovery copy without claiming success', async () => {
  const h = fileHandle(); h.state.fail = true
  const doc = await documentFor(9, snapshot())
  await assert.rejects(native.commitThenWriteNativeFile(h.handle, async () => ({ revision: 9 }), async () => doc, false), (error) => error.stage === 'external' && error.committed.revision === 9 && error.document === doc)
})
await test('10k×20 checkpoint / rapid edits do not capture per keypress', async () => {
  const large = snapshot(); large.sheets.s.rowCount = 10000; large.sheets.s.cellData = {}
  for (let r = 0; r < 10000; r++) { large.sheets.s.cellData[r] = {}; for (let c = 0; c < 20; c++) large.sheets.s.cellData[r][c] = { v: r * 20 + c } }
  let captures = 0, h
  h = scheduler({ checkpoint: async () => { captures++; await store.write(checkpoint({ workbookId: 'large', snapshot: large })) } })
  for (let i = 0; i < 100; i++) h.edit()
  assert.equal(captures, 0); await h.clock.tick(500)
  assert.equal((await store.read('large')).snapshot.sheets.s.cellData[9999][19].v, 199999); assert.equal(captures, 1)
  h.coordinator.dispose()
})
assert.deepEqual(await ownerFingerprint(), ownerBefore)
console.log(JSON.stringify({ result: 'PASS', scope: 'Deterministic production coordinator/native pipeline and IndexedDB API simulation; not browser UI evidence', checks: results, ownerFilesUnchanged: true }, null, 2))
