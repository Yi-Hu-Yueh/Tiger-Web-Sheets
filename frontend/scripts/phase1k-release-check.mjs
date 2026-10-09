import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const options = Object.fromEntries(process.argv.slice(2).filter((item) => item.startsWith('--')).map((item) => {
  const [key, ...rest] = item.slice(2).split('='); return [key, rest.join('=') || true]
}))
const results = {}
const test = async (name, action) => { await action(); results[name] = 'PASS'; console.log(`PASS: ${name}`) }

async function treeFingerprint(directories) {
  const files = []
  const walk = async (location) => {
    try {
      for (const entry of await fs.readdir(location, { withFileTypes: true })) {
        const target = path.join(location, entry.name)
        if (entry.isDirectory()) await walk(target); else files.push(target)
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  for (const directory of directories) await walk(directory)
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [
    path.relative(projectRoot, file).replaceAll('\\', '/'),
    createHash('sha256').update(await fs.readFile(file)).digest('hex'),
  ])))
}

const ownerBefore = await treeFingerprint([
  path.join(projectRoot, 'data'), path.join(projectRoot, 'workbooks'), path.join(projectRoot, 'history'),
])

await test('release version is single-source and exposed by backend/frontend', async () => {
  const version = (await fs.readFile(path.join(projectRoot, 'VERSION'), 'utf8')).trim()
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'frontend/package.json'), 'utf8'))
  const backend = await fs.readFile(path.join(projectRoot, 'backend/app/main.py'), 'utf8')
  const vite = await fs.readFile(path.join(projectRoot, 'frontend/vite.config.ts'), 'utf8')
  assert.equal(version, '1.0.0'); assert.equal(packageJson.version, version)
  assert.match(backend, /version=PRODUCT_VERSION/); assert.match(vite, /__TIGER_VERSION__/)
})

await test('normal launchers are fail-closed and process-local', async () => {
  const files = await Promise.all(['start_backend.cmd', 'start_frontend.cmd', 'start_dev.cmd'].map((name) => fs.readFile(path.join(projectRoot, 'scripts', name), 'utf8')))
  const combined = files.join('\n')
  for (const token of ['assert_ports_available.ps1', 'verify_manual_runtime.ps1', 'TIGER_WEB_SHEETS_DB', 'TIGER_WEB_SHEETS_WORKBOOK_ROOT', 'TIGER_WEB_SHEETS_HISTORY_ROOT', 'TIGER_WEB_SHEETS_INSTANCE_NONCE=manual']) assert.ok(combined.includes(token), token)
  assert.doesNotMatch(combined, /setx|Stop-Process|taskkill/i)
})

await test('main user-facing storage errors are localized and commercial packages remain absent', async () => {
  const api = await fs.readFile(path.join(projectRoot, 'frontend/src/workbookApi.ts'), 'utf8')
  const app = await fs.readFile(path.join(projectRoot, 'frontend/src/App.tsx'), 'utf8')
  const native = await fs.readFile(path.join(projectRoot, 'frontend/src/files/nativeFileAccess.ts'), 'utf8')
  const messages = `${api}\n${app}\n${native}`
  for (const text of ['無法連線至儲存服務', '儲存衝突', '版本還原失敗', '本機檔案']) assert.ok(messages.includes(text), text)
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'frontend/package.json'), 'utf8'))
  assert.ok(Object.keys(packageJson.dependencies).every((name) => !/univer.*pro/i.test(name)))
})

await test('V1 matrix and owner guide retain partials, backup, shutdown, and format boundaries', async () => {
  const matrix = await fs.readFile(path.join(projectRoot, 'docs/PHASE1K_V1_ACCEPTANCE.md'), 'utf8')
  const guide = await fs.readFile(path.join(projectRoot, 'docs/V1_USER_GUIDE.md'), 'utf8')
  for (const token of ['PASS', 'PARTIAL', 'NOT_TESTED', 'Owner status: **PASS.**', 'Structural reference rewriting remains PARTIAL']) assert.ok(matrix.includes(token), token)
  for (const token of ['data\\', 'workbooks\\', 'history\\', '已儲存', 'Chrome', 'Edge', 'CSV', 'XLSX', 'version history', 'shutdown']) assert.ok(guide.toLowerCase().includes(token.toLowerCase()), token)
})

function snapshot(marker, rows = 40, columns = 12) {
  const cellData = {
    0: { 0: { v: '代碼' }, 1: { v: '數量' }, 2: { v: '金額' }, 3: { v: '合計' }, 4: { v: '城市' } },
    1: { 0: { v: '00123', t: 1 }, 1: { v: 2 }, 2: { v: 25.5, s: 'currency' }, 3: { f: '=B2*C2' }, 4: { v: '台中' } },
    2: { 0: { v: marker }, 1: { v: 4 }, 2: { v: 0.5, s: 'percent' }, 3: { f: '=SUM(B2:B3)' }, 4: { v: '台北' } },
  }
  return {
    id: `release-${marker}`, name: `Release ${marker}`, appVersion: '1.0.0', locale: 'zhTW',
    styles: { currency: { n: { pattern: 'NT$#,##0.00' } }, percent: { n: { pattern: '0.00%' } } },
    sheetOrder: ['data', 'summary'],
    sheets: {
      data: { id: 'data', name: '資料', rowCount: rows, columnCount: columns, cellData,
        mergeData: [{ startRow: 5, endRow: 5, startColumn: 0, endColumn: 1 }],
        freeze: { startRow: 1, startColumn: 1, xSplit: 1, ySplit: 1 },
        dataValidations: { city: { type: 'list', formula1: '"台北,台中,高雄"' }, amount: { type: 'whole', operator: 'between', formula1: '1', formula2: '10' } },
        conditionalFormatting: { positive: { type: 'highlightCell', operator: 'greaterThan', value: 0 } },
      },
      summary: { id: 'summary', name: '摘要', rowCount: 40, columnCount: 12, cellData: { 0: { 0: { v: '跨表公式' }, 1: { f: '=資料!D2' } } } },
    },
  }
}

function largeSnapshot(marker, rowCount, columnCount) {
  const value = snapshot(marker, rowCount, columnCount)
  const cells = {}
  for (let row = 0; row < rowCount; row++) {
    const line = {}; for (let column = 0; column < columnCount; column++) line[column] = { v: row * columnCount + column }
    cells[row] = line
  }
  value.sheets.data.cellData = cells
  return value
}

if (options.base) {
  const base = String(options.base).replace(/\/$/, '')
  const runtimeRoot = path.resolve(String(options.root))
  const nonce = String(options.nonce)
  const request = async (route, method = 'GET', body, expected = 200) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text(); const data = text ? JSON.parse(text) : null
    assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${text}`)
    return data
  }
  const health = await request('/api/health')
  assert.equal(health.product_version, '1.0.0')
  assert.equal(health.runtime_mode, 'isolated-test'); assert.equal(health.instance_nonce, nonce)
  for (const [actual, expected] of [
    [health.database_path, path.join(runtimeRoot, 'workbook.db')],
    [health.workbook_root, path.join(runtimeRoot, 'workbooks')],
    [health.history_root, path.join(runtimeRoot, 'history')],
  ]) assert.equal(path.resolve(actual).toLowerCase(), path.resolve(expected).toLowerCase())

  const evidencePath = path.join(runtimeRoot, 'phase1k-evidence.json')
  if (options.reopen) {
    await test('backend restart reopens current state, history, and copies', async () => {
      const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'))
      const original = await request(`/api/workbooks/${evidence.originalId}`)
      assert.equal(original.revision, evidence.originalRevision)
      assert.equal(original.snapshot.sheets.data.cellData[1][0].v, '00123')
      assert.ok((await request(`/api/workbooks/${original.id}/versions`)).some((item) => item.source_type === 'pre_restore'))
      const copy = await request(`/api/workbooks/${evidence.copyId}`)
      assert.equal(copy.snapshot.sheets.data.cellData[1][0].v, '00123')
      assert.equal((await request(`/api/workbooks/${evidence.largeId}`)).snapshot.sheets.data.rowCount, 10000)
    })
  } else if (options.soak) {
    const seconds = Number(options.soak)
    await test(`bounded ${seconds}-second repeated-operation session`, async () => {
      const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'))
      let current = await request(`/api/workbooks/${evidence.originalId}`)
      const startedAt = Date.now()
      const deadline = startedAt + seconds * 1000
      let operations = 0
      while (Date.now() < deadline) {
        const next = structuredClone(current.snapshot)
        next.sheets.data.cellData[2][0] = { v: `SOAK-${operations}` }
        current = await request(`/api/workbooks/${current.id}`, 'PUT', { name: current.name, snapshot: next, expected_revision: current.revision })
        await request('/api/workbooks')
        if (operations % 12 === 0) await request(`/api/workbooks/${current.id}`)
        if (operations % 60 === 0) await request(`/api/workbooks/${current.id}/versions`, 'POST', { expected_revision: current.revision, label: `soak-${operations}` }, 201)
        operations++
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      const elapsedMilliseconds = Date.now() - startedAt
      assert.ok(elapsedMilliseconds >= seconds * 1000)
      assert.ok(operations >= Math.max(1, Math.floor(seconds / 10)))
      const versions = await request(`/api/workbooks/${current.id}/versions`)
      assert.ok(versions.filter((item) => item.source_type === 'autosave').length <= 20)
      evidence.originalRevision = current.revision
      evidence.soakOperations = operations
      await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2))
      console.log(JSON.stringify({ soakSeconds: seconds, elapsedMilliseconds, operations, revision: current.revision }))
    })
  } else {
    await test('fresh isolated runtime and cross-feature persistence flow', async () => {
      assert.deepEqual(await request('/api/workbooks'), [])
      let original = await request('/api/workbooks', 'POST', { name: 'V1 綜合測試', snapshot: snapshot('BASELINE') }, 201)
      const firstSave = structuredClone(original.snapshot); firstSave.sheets.data.cellData[2][0] = { v: 'FIRST-SAVE' }
      original = await request(`/api/workbooks/${original.id}`, 'PUT', { name: original.name, snapshot: firstSave, expected_revision: original.revision })
      const named = await request(`/api/workbooks/${original.id}/versions`, 'POST', { expected_revision: original.revision, label: 'V1 基準版本' }, 201)
      const namedSnapshot = structuredClone(original.snapshot)
      for (let index = 0; index < 5; index++) {
        const changed = structuredClone(original.snapshot); changed.sheets.data.cellData[2][0] = { v: `RAPID-${index}` }
        original = await request(`/api/workbooks/${original.id}`, 'PUT', { name: original.name, snapshot: changed, expected_revision: original.revision })
      }
      const beforeRestoreRevision = original.revision
      const restored = await request(`/api/workbooks/${original.id}/versions/${named.version_id}/restore`, 'POST', { expected_revision: original.revision })
      original = restored.workbook
      assert.equal(original.revision, beforeRestoreRevision + 1); assert.deepEqual(original.snapshot, namedSnapshot)
      assert.equal(restored.safety_version.source_type, 'pre_restore')
      const versions = await request(`/api/workbooks/${original.id}/versions`)
      assert.ok(versions.some((item) => item.version_id === named.version_id)); assert.ok(versions.some((item) => item.source_type === 'pre_restore'))
      assert.ok(versions.filter((item) => item.source_type === 'autosave').length <= 2)

      const copy = await request('/api/workbooks', 'POST', { name: 'V1 另存副本', snapshot: original.snapshot }, 201)
      const originalVersionIds = new Set(versions.map((item) => item.version_id))
      assert.ok((await request(`/api/workbooks/${copy.id}/versions`)).every((item) => !originalVersionIds.has(item.version_id)))
      const second = await request('/api/workbooks', 'POST', { name: '隔離 B', snapshot: snapshot('B') }, 201)
      const disposable = await request('/api/workbooks', 'POST', { name: '隔離 C', snapshot: snapshot('C') }, 201)
      const renamed = await request(`/api/workbooks/${original.id}`, 'PATCH', { name: 'V1 綜合測試（重新命名）', expected_revision: original.revision })
      assert.ok((await request(`/api/workbooks/${renamed.id}/versions`)).some((item) => item.version_id === named.version_id))
      await request(`/api/workbooks/${disposable.id}`, 'DELETE', undefined, 204)
      await assert.rejects(fs.access(path.join(runtimeRoot, 'history', disposable.id)))

      const stale = await fetch(`${base}/api/workbooks/${renamed.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: renamed.name, snapshot: snapshot('STALE'), expected_revision: 1 }) })
      assert.equal(stale.status, 409); assert.equal((await request(`/api/workbooks/${renamed.id}`)).revision, renamed.revision)
      await request('/api/native-files/import', 'POST', { name: 'Malformed', document: { format: 'wrong' } }, 422)

      const missing = await request(`/api/workbooks/${second.id}/versions`, 'POST', { expected_revision: second.revision, label: 'missing-test' }, 201)
      await fs.unlink(path.join(runtimeRoot, 'history', second.id, `${missing.version_id}.tws.json`))
      assert.equal((await request(`/api/workbooks/${second.id}/versions`)).find((item) => item.version_id === missing.version_id).integrity, 'corrupt')
      await request(`/api/workbooks/${second.id}/versions/${missing.version_id}/restore`, 'POST', { expected_revision: second.revision }, 422)
      await request(`/api/workbooks/${second.id}`, 'DELETE', undefined, 204)

      const timings = {}
      for (const [label, rows] of [['1000x20', 1000], ['10000x20', 10000]]) {
        const started = performance.now()
        const created = await request('/api/workbooks', 'POST', { name: `效能 ${label}`, snapshot: largeSnapshot(label, rows, 20) }, 201)
        const savedMs = Math.round(performance.now() - started)
        const openStarted = performance.now(); await request(`/api/workbooks/${created.id}`)
        timings[label] = { saveMilliseconds: savedMs, reopenMilliseconds: Math.round(performance.now() - openStarted) }
        if (rows === 10000) options.largeId = created.id
      }
      console.log(JSON.stringify({ performanceSmoke: timings }))
      await fs.writeFile(evidencePath, JSON.stringify({ originalId: renamed.id, originalRevision: renamed.revision, copyId: copy.id, largeId: options.largeId }, null, 2))
    })
  }

  await test('isolated runtime has no uncontrolled temporary residue', async () => {
    const residue = []
    const walk = async (location) => {
      try { for (const entry of await fs.readdir(location, { withFileTypes: true })) { const target = path.join(location, entry.name); if (entry.isDirectory()) await walk(target); else if (/\.(tmp|bak)$/i.test(entry.name) || /delete\.bak|prune\.bak/i.test(entry.name)) residue.push(target) } }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    await walk(runtimeRoot); assert.deepEqual(residue, [])
  })
}

assert.deepEqual(await treeFingerprint([
  path.join(projectRoot, 'data'), path.join(projectRoot, 'workbooks'), path.join(projectRoot, 'history'),
]), ownerBefore)

console.log(JSON.stringify({ result: 'PASS', checks: results, ownerStorage: 'UNCHANGED' }, null, 2))
