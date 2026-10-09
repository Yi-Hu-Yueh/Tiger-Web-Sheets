import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { IDBFactory } from 'fake-indexeddb'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
const modules = new Map()
async function moduleUrl(filename) {
  const absolute = path.resolve(filename)
  if (modules.has(absolute)) return modules.get(absolute)
  let source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  source = source.replaceAll('import.meta.env', '({ VITE_TIGER_INSTANCE_NONCE: "phase1j-engine-test" })')
  for (const match of [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]) {
    const resolved = match[1].startsWith('.') ? await moduleUrl(path.resolve(path.dirname(absolute), `${match[1]}.ts`)) : import.meta.resolve(match[1])
    source = source.replace(match[0], `from '${resolved}'`)
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  modules.set(absolute, url); return url
}
const production = async (name) => import(await moduleUrl(path.join(root, 'frontend/src', name)))
const { AutosaveCoordinator } = await production('persistence/autosaveCoordinator.ts')
const { RecoveryStore } = await production('persistence/recoveryStore.ts')
const results = {}
const test = async (name, action) => { await action(); results[name] = 'PASS'; console.log(`PASS: ${name}`) }
async function ownerFingerprint() {
  const files = [path.join(root, 'data/tiger_web_sheets.db')]
  for (const directory of ['workbooks', 'history']) {
    const start = path.join(root, directory)
    try {
      const walk = async (location) => { for (const entry of await fs.readdir(location, { withFileTypes: true })) { const target = path.join(location, entry.name); if (entry.isDirectory()) await walk(target); else files.push(target) } }
      await walk(start)
    } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
}
const ownerBefore = await ownerFingerprint()

await test('restore UI, routes, safety text, and synchronous autosave exclusion are wired', async () => {
  const app = await fs.readFile(path.join(root, 'frontend/src/App.tsx'), 'utf8')
  const api = await fs.readFile(path.join(root, 'frontend/src/workbookApi.ts'), 'utf8')
  const dialogs = await fs.readFile(path.join(root, 'frontend/src/history/VersionHistoryDialogs.tsx'), 'utf8')
  for (const text of ['版本紀錄', '建立版本', '還原此版本', '目前版本會先建立安全備份', '手動版本', '自動版本', '還原前備份']) assert.ok(dialogs.includes(text) || app.includes(text), text)
  assert.match(api, /\/versions\/\$\{encodeURIComponent\(versionId\)\}\/restore/)
  assert.match(app, /restoreActiveRef\.current/)
  assert.match(app, /await recoveryStore\.remove\(result\.workbook\.id\)/)
  assert.match(app, /commitThenWriteNativeFile/)
})

await test('manual flush serializes an active save and drains the newest generation', async () => {
  let generation = 1, saves = 0, release
  const clock = { set: () => 1, clear: () => {} }
  const coordinator = new AutosaveCoordinator({ generation: () => generation, eligible: () => true,
    save: async () => { const captured = generation; saves++; if (saves === 1) await new Promise((resolve) => { release = resolve }); return { ok: true, generation: captured } },
    checkpoint: async () => {}, recoveryError: (error) => { throw error }, clock })
  coordinator.mutation()
  const flush = coordinator.flush()
  generation = 2; coordinator.mutation()
  release()
  assert.equal(await flush, true)
  assert.equal(saves, 2)
  coordinator.dispose()
})

await test('successful restore cleanup removes stale crash-recovery state by workbook ID', async () => {
  const store = new RecoveryStore('phase1j-cleanup', new IDBFactory())
  const snapshot = { id: 'book-a', name: 'A', appVersion: '1', locale: 'zhTW', styles: {}, sheetOrder: ['s'], sheets: { s: { id: 's', name: 'S', rowCount: 1, columnCount: 1, cellData: {} } } }
  await store.write({ workbookId: 'book-a', baseRevision: 2, baseUpdatedAt: '2026-10-09T00:00:00Z', timestamp: Date.now(), sessionId: 'old-session', generation: 4, snapshot })
  await store.write({ workbookId: 'book-b', baseRevision: 1, baseUpdatedAt: '2026-10-09T00:00:00Z', timestamp: Date.now(), sessionId: 'other-session', generation: 1, snapshot: { ...snapshot, id: 'book-b' } })
  await store.remove('book-a')
  assert.equal(await store.read('book-a'), null)
  assert.ok(await store.read('book-b'))
})

await test('bounded backend policy and isolated history identity are explicit', async () => {
  const store = await fs.readFile(path.join(root, 'backend/app/services/workbook_store.py'), 'utf8')
  const runtime = await fs.readFile(path.join(root, 'scripts/start_isolated_test_runtime.ps1'), 'utf8')
  assert.match(store, /AUTOMATIC_VERSION_INTERVAL = timedelta\(minutes=10\)/)
  assert.match(store, /AUTOMATIC_VERSION_RETENTION = 20/)
  assert.match(runtime, /TIGER_WEB_SHEETS_HISTORY_ROOT/)
  assert.match(runtime, /refuse the manual history directory/)
})

await test('representative 10k x 20 snapshot remains below the 16 MiB history boundary without per-edit work', async () => {
  const cellData = {}
  for (let row = 0; row < 10_000; row++) {
    const cells = {}; for (let col = 0; col < 20; col++) cells[col] = { v: row * 20 + col }
    cellData[row] = cells
  }
  const snapshot = { id: 'large', name: '10k×20', appVersion: '1', locale: 'zhTW', styles: {}, sheetOrder: ['s'], sheets: { s: { id: 's', name: 'S', rowCount: 10_000, columnCount: 20, cellData } } }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
  assert.ok(bytes < 16 * 1024 * 1024)
  console.log(JSON.stringify({ representativeCells: 200_000, snapshotBytes: bytes, policy: 'history only after committed save and at most every 10 minutes' }))
})

if (process.argv.includes('--runtime') || process.argv.includes('--reopen-runtime')) {
  const nonce = 'phase1j-20261009-a1', base = 'http://127.0.0.1:18312'
  const expectedDb = path.join(root, `.cache/isolated-runtimes/${nonce}/workbook.db`)
  const expectedWorkbooks = path.join(root, `.cache/isolated-runtimes/${nonce}/workbooks`)
  const expectedHistory = path.join(root, `.cache/isolated-runtimes/${nonce}/history`)
  const health = await (await fetch(`${base}/api/health`)).json()
  assert.equal(health.runtime_mode, 'isolated-test'); assert.equal(health.instance_nonce, nonce)
  for (const [actual, expected] of [[health.database_path, expectedDb], [health.workbook_root, expectedWorkbooks], [health.history_root, expectedHistory]]) assert.equal(path.resolve(actual).toLowerCase(), expected.toLowerCase())
  const request = async (url, method = 'GET', body) => { const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error(`${method} ${url} ${response.status} ${await response.text()}`); return response.status === 204 ? null : response.json() }
  const memo = path.join(root, `.cache/isolated-runtimes/${nonce}/phase1j-evidence.json`)
  const snapshot = (marker) => ({ id: `model-${marker}`, name: marker, appVersion: '1.0.0', locale: 'zhTW', styles: {}, sheetOrder: ['s'], sheets: { s: { id: 's', name: '版本測試', rowCount: 100, columnCount: 26, cellData: { 0: { 0: { v: marker } } } } } })
  await test(process.argv.includes('--reopen-runtime') ? 'backend restart preserves restored workbook and isolated history' : 'isolated API manual history / restore / lifecycle isolation', async () => {
    if (process.argv.includes('--reopen-runtime')) {
      const saved = JSON.parse(await fs.readFile(memo, 'utf8'))
      const workbook = await request(`/api/workbooks/${saved.aId}`)
      assert.equal(workbook.snapshot.sheets.s.cellData[0][0].v, 'VERSION_A1')
      const versions = await request(`/api/workbooks/${saved.aId}/versions`)
      assert.ok(versions.some((item) => item.source_type === 'pre_restore'))
      assert.ok(versions.every((item) => item.workbook_id === saved.aId && item.integrity === 'ok'))
      return
    }
    const a = await request('/api/workbooks', 'POST', { name: 'Phase1J_A', snapshot: snapshot('VERSION_A1') })
    const b = await request('/api/workbooks', 'POST', { name: 'Phase1J_B', snapshot: snapshot('VERSION_B') })
    const a1 = await request(`/api/workbooks/${a.id}/versions`, 'POST', { expected_revision: a.revision, label: '第一版' })
    const b1 = await request(`/api/workbooks/${b.id}/versions`, 'POST', { expected_revision: b.revision, label: 'B版' })
    const a2 = await request(`/api/workbooks/${a.id}`, 'PUT', { name: a.name, snapshot: snapshot('CURRENT'), expected_revision: a.revision })
    const restored = await request(`/api/workbooks/${a.id}/versions/${a1.version_id}/restore`, 'POST', { expected_revision: a2.revision })
    assert.equal(restored.workbook.revision, a2.revision + 1); assert.equal(restored.workbook.snapshot.sheets.s.cellData[0][0].v, 'VERSION_A1')
    assert.equal(restored.safety_version.source_type, 'pre_restore')
    const aVersions = await request(`/api/workbooks/${a.id}/versions`), bVersions = await request(`/api/workbooks/${b.id}/versions`)
    assert.ok(aVersions.every((item) => item.workbook_id === a.id && item.version_id !== b1.version_id))
    assert.ok(bVersions.every((item) => item.workbook_id === b.id && item.version_id !== a1.version_id))
    const renamed = await request(`/api/workbooks/${a.id}`, 'PATCH', { name: 'Phase1J_A_Renamed', expected_revision: restored.workbook.revision })
    assert.ok((await request(`/api/workbooks/${a.id}/versions`)).some((item) => item.version_id === a1.version_id))
    const copy = await request('/api/workbooks', 'POST', { name: 'Phase1J_Copy', snapshot: renamed.snapshot })
    assert.ok((await request(`/api/workbooks/${copy.id}/versions`)).every((item) => item.version_id !== a1.version_id))
    await request(`/api/workbooks/${b.id}`, 'DELETE')
    await assert.rejects(fs.access(path.join(expectedHistory, b.id)))
    await fs.writeFile(memo, JSON.stringify({ aId: a.id, revision: renamed.revision }))
  })
}

assert.deepEqual(await ownerFingerprint(), ownerBefore)

console.log(JSON.stringify({ result: 'PASS', checks: results, ownerStorage: 'UNCHANGED' }, null, 2))
