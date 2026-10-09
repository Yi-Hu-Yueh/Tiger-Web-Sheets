import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { IDBFactory } from 'fake-indexeddb'
import { CommandType, CellValueType, DataValidationType, DataValidationOperator, DataValidationErrorStyle, DataValidationRenderMode, DataValidationStatus, IUniverInstanceService, LocaleType, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import '@univerjs/sheets-numfmt/facade'
import { DataValidatorRegistryService, UniverDataValidationPlugin } from '@univerjs/data-validation'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import '@univerjs/sheets-data-validation/facade'
import { ConditionalFormattingService, UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import '@univerjs/sheets-conditional-formatting/facade'

// Real OSS models/validators/render style composer, not a Tiger rule engine.
// This intentionally does NOT certify DOM dropdown/keyboard or visual browser UI.
const root = fileURLToPath(new URL('../../', import.meta.url))
const modules = new Map()
async function moduleUrl(filename) {
  const absolute = path.resolve(filename)
  if (modules.has(absolute)) return modules.get(absolute)
  let source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  source = source.replaceAll('import.meta.env', '({ VITE_TIGER_INSTANCE_NONCE: "phase1i-engine-test" })')
  for (const match of [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]) {
    const resolved = match[1].startsWith('.') ? await moduleUrl(path.resolve(path.dirname(absolute), `${match[1]}.ts`)) : import.meta.resolve(match[1])
    source = source.replace(match[0], `from '${resolved}'`)
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  modules.set(absolute, url); return url
}
const production = async (name) => import(await moduleUrl(path.join(root, 'frontend/src', name)))
const { inspectSnapshot } = await production('xlsx/xlsxCompatibility.ts')
const { csvRowsForWorksheet, serializeCsv, createCsvWorkbookSnapshot } = await production('csv/csvSerializer.ts')
const { isPersistedWorkbookMutation } = await production('persistence/workbookMutation.ts')
const { AutosaveCoordinator } = await production('persistence/autosaveCoordinator.ts')
const { RecoveryStore, recoveryDisposition } = await production('persistence/recoveryStore.ts')
const { openNativeRulePanel, formatSelectedCodeAsText, createRuleMutationTracker, RULE_PANEL_OPERATIONS } = await production('rules/nativeRuleUi.ts')
const ownerFingerprint = async () => {
  const files = [path.join(root, 'data/tiger_web_sheets.db'), ...(await fs.readdir(path.join(root, 'workbooks'))).map((f) => path.join(root, 'workbooks', f))]
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, createHash('sha256').update(await fs.readFile(f)).digest('hex')])))
}
const beforeOwner = await ownerFingerprint()
const results = {}, runtimes = []
const test = async (name, action) => { await action(); results[name] = 'PASS'; console.log(`PASS: ${name}`) }
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
function seed() {
  return { id: 'phase1i-model', name: '規則測試', appVersion: '1.0.3', locale: LocaleType.ZH_TW, styles: {}, sheetOrder: ['rules'], sheets: {
    rules: { id: 'rules', name: '規則測試', rowCount: 1100, columnCount: 26, cellData: {} },
  } }
}
async function create(snapshot = seed()) {
  const univer = new Univer({ locale: LocaleType.ZH_TW, locales: { [LocaleType.ZH_TW]: {} } })
  for (const plugin of [UniverFormulaEnginePlugin, UniverSheetsPlugin, UniverSheetsFormulaPlugin, UniverSheetsNumfmtPlugin, UniverDataValidationPlugin, UniverSheetsDataValidationPlugin, UniverSheetsConditionalFormattingPlugin]) univer.registerPlugin(plugin)
  const api = FUniver.newAPI(univer), workbook = api.createWorkbook(structuredClone(snapshot))
  univer.__getInjector().get(IUniverInstanceService).focusUnit(workbook.getId())
  const sheet = workbook.getActiveSheet(); sheet.activate()
  const service = univer.__getInjector().get(ConditionalFormattingService)
  const runtime = { univer, api, workbook, sheet, service, style(row, col) { return service.composeStyle(workbook.getId(), sheet.getSheetId(), row, col)?.style ?? null } }
  runtimes.push(runtime); await settle(); return runtime
}
const options = { allowBlank: true, showErrorMessage: true, errorStyle: DataValidationErrorStyle.WARNING, error: '資料不符合驗證規則' }
async function setValidation(rt) {
  const { api, sheet } = rt
  sheet.getRange('A1:D1').setValues([['狀態', '數量', '折扣', '代碼']])
  sheet.getRange('A2:A10').setDataValidation(api.newDataValidation().requireValueInList(['待處理', '處理中', '已完成'], false, true).setOptions({ ...options, renderMode: DataValidationRenderMode.ARROW }).build())
  sheet.getRange('B2:B20').setDataValidation(api.newDataValidation().requireNumberBetween(1, 100, true).setOptions(options).build())
  sheet.getRange('C2:C20').setDataValidation(api.newDataValidation().requireNumberBetween(0, 1).setOptions(options).build())
  const text = api.newDataValidation().build()
  text.setCriteria(DataValidationType.TEXT_LENGTH, [DataValidationOperator.LESS_THAN_OR_EQUAL, '8', '']).setOptions(options)
  sheet.getRange('D2:D20').setDataValidation(text).setNumberFormat('@')
  sheet.getRange('A2').setValue('處理中')
  sheet.getRange('B2').setValue(50); sheet.getRange('C2').setValue(0.25)
  sheet.getRange('D2').setValue({ v: '00123', t: CellValueType.STRING })
  await settle()
}
async function validationCases(rt) {
  for (const [range, cases] of [
    ['A2', [['待處理', true], ['處理中', true], ['已完成', true], ['不存在', false]]],
    ['B2', [[1, true], [50, true], [100, true], [0, false], [101, false], [1.5, false], ['文字', false]]],
    ['C2', [[0, true], [0.25, true], [1, true], [-0.1, false], [1.1, false], ['文字', false]]],
    ['D2', [['ABC123', true], ['ABCDEFGHI', false], ['00123', true]]],
  ]) {
    for (const [value, valid] of cases) {
      rt.sheet.getRange(range).setValue(typeof value === 'string' ? { v: value, t: CellValueType.STRING } : value)
      assert.equal((await rt.sheet.getRange(range).getValidatorStatus())[0][0], valid ? DataValidationStatus.VALID : DataValidationStatus.INVALID, `${range} ${value}`)
    }
  }
  assert.equal(rt.sheet.getRange('D2').getValue(), '00123')
  assert.equal(rt.sheet.getRange('A2').getValue(), '不存在', 'WARNING retains invalid data and reports INVALID; API is not a STOP keyboard test')
}
function addHighlight(rt, range, configure) {
  const builder = configure(rt.sheet.newConditionalFormattingRule()).setRanges([rt.sheet.getRange(range).getRange()])
  const rule = builder.setBackground('#FFCC00').setFontColor('#990000').setBold(true).build()
  rt.sheet.addConditionalFormattingRule(rule)
  return rule
}
async function styleMatches(rt, range, expected) {
  const bounds = rt.sheet.getRange(range).getRange()
  // Native computations are lazy/asynchronous (duplicates precompute on access).
  for (let attempt = 0; attempt < 15; attempt++) {
    const actual = []
    for (let row = bounds.startRow; row <= bounds.endRow; row++) actual.push(!!rt.style(row, bounds.startColumn)?.bg)
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      for (let i = 0; i < expected.length; i++) if (expected[i]) {
        const style = rt.style(bounds.startRow + i, bounds.startColumn)
        assert.ok(['#FFCC00', 'rgb(255,204,0)'].includes(style.bg.rgb)); assert.ok(['#990000', 'rgb(153,0,0)'].includes(style.cl.rgb)); assert.equal(style.bl, 1)
      }
      return
    }
    await settle()
  }
  throw new Error(`Native computed style mismatch for ${range}`)
}
try {
  await test('exact-version Apache-2.0 license / command / native UI / Traditional Chinese assets', async () => {
    for (const pkg of ['data-validation', 'sheets-data-validation', 'sheets-data-validation-ui', 'sheets-conditional-formatting', 'sheets-conditional-formatting-ui', 'preset-sheets-data-validation', 'preset-sheets-conditional-formatting']) {
      const dir = path.join(root, 'frontend/node_modules/@univerjs', pkg)
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
      assert.equal(meta.version, '1.0.3'); assert.equal(meta.license, 'Apache-2.0')
      assert.match(await fs.readFile(path.join(dir, 'lib/types/index.d.ts'), 'utf8'), /Licensed under the Apache License/)
    }
    for (const [pkg, kind] of [['sheets-data-validation-ui', 'validation'], ['sheets-conditional-formatting-ui', 'conditional']]) {
      assert.ok((await fs.readFile(path.join(root, `frontend/node_modules/@univerjs/${pkg}/lib/es/index.js`), 'utf8')).includes(RULE_PANEL_OPERATIONS[kind]))
      const preset = kind === 'validation' ? 'data-validation' : 'conditional-formatting'
      assert.match(await fs.readFile(path.join(root, `frontend/node_modules/@univerjs/preset-sheets-${preset}/lib/es/locales/zh-TW.js`), 'utf8'), /zh-TW/)
    }
  })
  const rt = await create()
  await test('explicit dropdown / whole / decimal / text length / invalid detection / leading-zero text', async () => { await setValidation(rt); await validationCases(rt) })
  await test('native empty dropdown / malformed numeric configuration rejection / text-code command', async () => {
    const registry = rt.univer.__getInjector().get(DataValidatorRegistryService)
    const list = rt.sheet.getRange('A2').getDataValidation().rule
    assert.equal(registry.getValidatorItem(DataValidationType.LIST).validatorFormula({ ...list, formula1: '' }, rt.workbook.getId(), rt.sheet.getSheetId()).success, false)
    const whole = rt.sheet.getRange('B2').getDataValidation().rule
    assert.equal(registry.getValidatorItem(DataValidationType.WHOLE).validatorFormula({ ...whole, formula1: 'not-a-number' }, rt.workbook.getId(), rt.sheet.getSheetId()).success, false)
    rt.sheet.getRange('D2:D20').activate(); await formatSelectedCodeAsText(rt.api)
    assert.equal(rt.sheet.getRange('D2').getValue(), '00123')
    const snap = rt.workbook.save(), cell = snap.sheets.rules.cellData[1][3], style = typeof cell.s === 'string' ? snap.styles[cell.s] : cell.s
    assert.equal(style.n.pattern, '@')
  })
  await test('validation remove / values retained / undo redo', async () => {
    const before = rt.sheet.getRange('A2').getValue()
    rt.sheet.getRange('A2:A10').setDataValidation(null)
    assert.equal(rt.sheet.getRange('A2').getDataValidation(), undefined)
    assert.equal(rt.sheet.getRange('A2').getValue(), before)
    await rt.api.undo(); assert.equal(rt.sheet.getRange('A2').getDataValidation().getCriteriaType(), DataValidationType.LIST)
    await rt.api.redo(); assert.equal(rt.sheet.getRange('A2').getDataValidation(), undefined)
    await setValidation(rt)
  })
  await test('native validation edit / changed bounds are enforced and snapshot preserved', async () => {
    const range = rt.sheet.getRange('B2'), rule = range.getDataValidation()
    rule.setCriteria(DataValidationType.WHOLE, [DataValidationOperator.BETWEEN, '2', '99'])
    range.setValue(1); assert.equal((await range.getValidatorStatus())[0][0], DataValidationStatus.INVALID)
    range.setValue(99); assert.equal((await range.getValidatorStatus())[0][0], DataValidationStatus.VALID)
    const reopened = await create(rt.workbook.save())
    reopened.sheet.getRange('B2').setValue(100); assert.equal((await reopened.sheet.getRange('B2').getValidatorStatus())[0][0], DataValidationStatus.INVALID)
    rule.setCriteria(DataValidationType.WHOLE, [DataValidationOperator.BETWEEN, '1', '100']); range.setValue(50)
  })
  await test('same native dropdown choice is non-dirty / changed choice persists / formula replacement not suppressed', async () => {
    const guard = createRuleMutationTracker(rt.api), dirty = []
    const listener = rt.api.addEvent(rt.api.Event.CommandExecuted, (event) => { if (guard.isPersistent(event)) dirty.push(event.id) })
    const payload = (value) => ({ unitId: rt.workbook.getId(), subUnitId: rt.sheet.getSheetId(), range: rt.sheet.getRange('A2').getRange(), value: { v: value, p: null, f: null, si: null } })
    assert.equal(await rt.api.executeCommand('sheet.command.set-range-values', payload('處理中')), true)
    assert.equal(rt.sheet.getRange('A2').getValue(), '處理中'); assert.equal(dirty.length, 0)
    assert.equal(await rt.api.executeCommand('sheet.command.set-range-values', payload('已完成')), true)
    assert.equal(rt.sheet.getRange('A2').getValue(), '已完成'); assert.ok(dirty.length > 0)
    rt.sheet.getRange('A2').setValue('="已完成"'); await settle()
    assert.equal(await rt.api.executeCommand('sheet.command.set-range-values', payload('已完成')), true)
    assert.equal(rt.sheet.getRange('A2').getFormulas()[0][0], '')
    guard.dispose(); listener.dispose(); await setValidation(rt)
  })
  rt.sheet.getRange('F1:H5').setValues([['金額', '公司', '編號'], [50, '台中公司', 'A001'], [100, '台北公司', 'A002'], [150, '台中門市', 'A001'], [200, '高雄公司', 'A003']])
  await test('greater / less / equal native computed styles and removal undo redo', async () => {
    for (const [method, expected] of [['whenNumberGreaterThan', [false, false, true, true]], ['whenNumberLessThan', [true, false, false, false]], ['whenNumberEqualTo', [false, true, false, false]]]) {
      const rule = addHighlight(rt, 'F2:F5', (b) => b[method](100))
      await styleMatches(rt, 'F2:F5', expected)
      rt.sheet.deleteConditionalFormattingRule(rule.cfId)
      await styleMatches(rt, 'F2:F5', [false, false, false, false])
      assert.deepEqual(rt.sheet.getRange('F2:F5').getValues().flat(), [50, 100, 150, 200])
      await rt.api.undo(); await styleMatches(rt, 'F2:F5', expected)
      await rt.api.redo(); await styleMatches(rt, 'F2:F5', [false, false, false, false])
    }
  })
  const numeric = addHighlight(rt, 'F2:F5', (b) => b.whenNumberGreaterThan(100))
  await test('Traditional Chinese text contains / duplicate values / fill text bold', async () => {
    addHighlight(rt, 'G2:G5', (b) => b.whenTextContains('台中'))
    addHighlight(rt, 'H2:H5', (b) => b.setDuplicateValues())
    await styleMatches(rt, 'G2:G5', [true, false, true, false]); await styleMatches(rt, 'H2:H5', [true, false, true, false])
  })
  await test('live numeric reevaluation / editing rule', async () => {
    rt.sheet.getRange('F2').setValue(150); await styleMatches(rt, 'F2:F5', [true, false, true, true])
    rt.sheet.getRange('F2').setValue(50); await styleMatches(rt, 'F2:F5', [false, false, true, true])
    const changed = structuredClone(numeric); changed.rule.value = 175
    rt.sheet.setConditionalFormattingRule(numeric.cfId, changed)
    await styleMatches(rt, 'F2:F5', [false, false, false, true])
    rt.sheet.setConditionalFormattingRule(numeric.cfId, numeric)
  })
  await test('formula-result numeric formatting updates with actual recalculation', async () => {
    rt.sheet.getRange('J1').setValue(50); rt.sheet.getRange('J2').setValue('=J1*2')
    addHighlight(rt, 'J2', (b) => b.whenNumberGreaterThan(120))
    await settle(); assert.equal(rt.sheet.getRange('J2').getValue(), 100); await styleMatches(rt, 'J2', [false])
    rt.sheet.getRange('J1').setValue(70); await settle(); assert.equal(rt.sheet.getRange('J2').getValue(), 140); await styleMatches(rt, 'J2', [true])
  })
  let representative = structuredClone(rt.workbook.save())
  await test('native resource snapshot reload / behavior re-tested', async () => {
    const reopened = await create(representative)
    await validationCases(reopened)
    await styleMatches(reopened, 'F2:F5', [false, false, true, true]); await styleMatches(reopened, 'G2:G5', [true, false, true, false]); await styleMatches(reopened, 'H2:H5', [true, false, true, false])
  })
  await test('Save As snapshot-copy isolation / independent rule modification', async () => {
    const original = JSON.stringify(rt.workbook.save().resources)
    const copy = await create({ ...structuredClone(representative), id: 'copy-model', name: '另存副本' })
    copy.sheet.getRange('A2:A10').setDataValidation(null)
    copy.sheet.clearConditionalFormatRules()
    assert.equal(JSON.stringify(rt.workbook.save().resources), original)
    assert.equal(copy.sheet.getRange('A2').getDataValidation(), undefined)
    assert.equal(copy.sheet.getConditionalFormattingRules().length, 0)
  })
  await test('XLSX explicit validation / conditional warnings; CSV value-only unchanged', async () => {
    const summary = inspectSnapshot(representative)
    assert.ok(summary.findings.some((f) => f.category === 'data-validation' || f.code === 'data-validation'))
    assert.ok(summary.findings.some((f) => f.category === 'conditional-formatting' || f.code === 'conditional-formatting'))
    const csv = serializeCsv(csvRowsForWorksheet(rt.sheet, representative.sheets.rules.cellData))
    assert.ok(csv.includes('台中公司')); assert.ok(!csv.includes('SHEET_DATA_VALIDATION_PLUGIN'))
    const imported = createCsvWorkbookSnapshot('CSV', '工作表1', [['00123', '台中']])
    assert.equal(imported.resources, undefined)
    const empty = structuredClone(representative); for (const r of empty.resources) if (/VALIDATION|CONDITIONAL/.test(r.name)) r.data = '{}'
    assert.ok(!inspectSnapshot(empty).findings.some((f) => ['data-validation', 'conditional-formatting'].includes(f.category ?? f.code)))
  })
  await test('native UI integration errors are explicit / opening panel is non-persistent', async () => {
    await assert.rejects(openNativeRulePanel({ getActiveWorkbook: () => null }, 'validation'), /請先選取/)
    const range = { getRange: () => ({ startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 }) }
    const sheet = { getActiveRange: () => range, getMaxRows: () => 10, getMaxColumns: () => 10 }
    const api = { getActiveWorkbook: () => ({ getActiveSheet: () => sheet }), executeCommand: async () => false }
    await assert.rejects(openNativeRulePanel(api, 'conditional'), /Univer 無法/)
    range.getRange = () => ({ startRow: -1, endRow: 1, startColumn: 0, endColumn: 0 })
    await assert.rejects(openNativeRulePanel(api, 'validation'), /範圍無效/)
    assert.equal(isPersistedWorkbookMutation({ id: RULE_PANEL_OPERATIONS.validation, type: CommandType.OPERATION }), false)
  })
  await test('actual rule mutations dirty / autosave coalesces / same recovery store restores rule', async () => {
    const isolated = await create(), store = new RecoveryStore('phase1i-recovery', new IDBFactory())
    let generation = 0, saves = 0, saved, checkpoints = 0
    const timers = new Map(); let now = 0, next = 0
    const clock = { set(fn, delay) { timers.set(++next, { at: now + delay, fn }); return next }, clear(id) { timers.delete(id) } }
    async function tick(ms) { const end = now + ms; while (true) { const t = [...timers].sort(([,a],[,b]) => a.at-b.at)[0]; if (!t || t[1].at > end) break; now = t[1].at; timers.delete(t[0]); t[1].fn(); await settle() } now = end; await settle() }
    const coordinator = new AutosaveCoordinator({ clock, generation: () => generation, eligible: () => true,
      save: async () => { saves++; saved = structuredClone(isolated.workbook.save()); await store.acknowledge('book-rules', 'rules-session', generation); return { ok: true, generation } },
      checkpoint: async () => { checkpoints++; await store.write({ workbookId: 'book-rules', baseRevision: 1, baseUpdatedAt: '2026-10-09T00:00:00Z', timestamp: Date.now(), sessionId: 'rules-session', generation, snapshot: structuredClone(isolated.workbook.save()) }) }, recoveryError: (e) => { throw e } })
    const events = []
    const tracker = createRuleMutationTracker(isolated.api)
    const listener = isolated.api.addEvent(isolated.api.Event.CommandExecuted, (e) => { if (tracker.isPersistent(e)) { events.push(e.id); generation++; coordinator.mutation() } })
    await setValidation(isolated); const conditional = addHighlight(isolated, 'F2:F5', (b) => b.whenNumberGreaterThan(100))
    isolated.sheet.getRange('B2').getDataValidation().setOptions({ error: '整數必須在 1 到 100 之間' })
    const changed = structuredClone(conditional); changed.rule.value = 101
    isolated.sheet.setConditionalFormattingRule(conditional.cfId, changed)
    await settle() // Native options command asynchronously delivers its mutation event.
    assert.ok(events.includes('data-validation.mutation.addRule')); assert.ok(events.includes('sheet.mutation.add-conditional-rule'))
    assert.ok(events.includes('data-validation.mutation.updateRule')); assert.ok(events.includes('sheet.mutation.set-conditional-rule'))
    await tick(500); assert.equal(checkpoints, 1); assert.equal(saves, 0)
    const record = await store.read('book-rules')
    assert.equal(recoveryDisposition(record, { id: 'book-rules', revision: 1, updated_at: '2026-10-09T00:00:00Z', snapshot: seed() }), 'restore')
    const recovered = await create(record.snapshot); await validationCases(recovered); assert.equal(recovered.sheet.getConditionalFormattingRules().length, 1)
    assert.equal(await store.read('other-workbook'), null)
    await tick(2500); assert.equal(saves, 1); assert.equal(await store.read('book-rules'), null)
    const reopened = await create(saved); await validationCases(reopened)
    events.length = 0; const stable = generation
    isolated.sheet.getRange('F2').activate(); isolated.style(1, 5); await settle(); assert.equal(generation, stable)
    isolated.sheet.getRange('A2:A10').setDataValidation(null); isolated.sheet.clearConditionalFormatRules()
    assert.ok(events.includes('data-validation.mutation.removeRule')); assert.ok(events.includes('sheet.mutation.delete-conditional-rule'))
    await tick(500); assert.ok(await store.read('book-rules')); await store.remove('book-rules'); assert.equal(await store.read('book-rules'), null)
    coordinator.dispose(); listener.dispose(); tracker.dispose()
  })
  await test('1000-cell dropdown / numeric validation / native conditional style calculations', async () => {
    const large = await create(), start = performance.now()
    large.sheet.getRange('A2:A1001').setValues(Array.from({ length: 1000 }, () => ['待處理']))
    large.sheet.getRange('A2:A1001').setDataValidation(large.api.newDataValidation().requireValueInList(['待處理', '處理中', '已完成']).setOptions(options).build())
    large.sheet.getRange('B2:B1001').setValues(Array.from({ length: 1000 }, (_, i) => [i % 100 + 1]))
    large.sheet.getRange('B2:B1001').setDataValidation(large.api.newDataValidation().requireNumberBetween(1, 100, true).setOptions(options).build())
    const statuses = (await large.sheet.getRange('B2:B1001').getValidatorStatus()).flat(); assert.equal(statuses.length, 1000); assert.ok(statuses.every((status) => status === DataValidationStatus.VALID))
    addHighlight(large, 'B2:B1001', (b) => b.whenNumberGreaterThan(50))
    for (let row = 1; row <= 1000; row++) assert.equal(!!large.style(row, 1)?.bg, (row - 1) % 100 + 1 > 50)
    for (let i = 0; i < 100; i++) large.sheet.getRange('B2').setValue(i % 100 + 1)
    console.log(JSON.stringify({ headless1000CellMilliseconds: Math.round(performance.now() - start), browserTypingLag: 'NOT_TESTED' }))
    assert.ok(large.workbook.save().resources.some((r) => r.name === 'SHEET_DATA_VALIDATION_PLUGIN'))
  })
  representative = structuredClone(rt.workbook.save())
  const runtimeMode = process.argv.includes('--runtime') || process.argv.includes('--reopen-runtime')
  if (runtimeMode) {
    const nonce = 'phase1i-20261009-a1', base = 'http://127.0.0.1:18302'
    const expectedDb = path.join(root, `.cache/isolated-runtimes/${nonce}/workbook.db`)
    const expectedRoot = path.join(root, `.cache/isolated-runtimes/${nonce}/workbooks`)
    const health = await (await fetch(`${base}/api/health`)).json()
    assert.equal(health.runtime_mode, 'isolated-test'); assert.equal(health.instance_nonce, nonce)
    assert.equal(path.resolve(health.database_path).toLowerCase(), expectedDb.toLowerCase()); assert.equal(path.resolve(health.workbook_root).toLowerCase(), expectedRoot.toLowerCase())
    assert.notEqual(path.resolve(health.database_path).toLowerCase(), path.join(root, 'data/tiger_web_sheets.db').toLowerCase())
    const memoPath = path.join(root, `.cache/isolated-runtimes/${nonce}/phase1i-evidence.json`)
    const request = async (url, method = 'GET', body) => { const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); assert.ok(response.ok, `${method} ${url} ${response.status}`); return response.json() }
    await test(process.argv.includes('--reopen-runtime') ? 'backend restart / native Tiger reopen / validators and computed styles active' : 'isolated real API / native mirror / copy / rename / complete-rule preservation', async () => {
      let record
      if (process.argv.includes('--reopen-runtime')) record = await request(`/api/workbooks/${JSON.parse(await fs.readFile(memoPath, 'utf8')).id}`)
      else {
        record = await request('/api/workbooks', 'POST', { name: 'Phase1I_Disposable_Rules', snapshot: representative })
        record = await request(`/api/workbooks/${record.id}`, 'PUT', { name: record.name, snapshot: representative, expected_revision: record.revision })
        const beforeRename = structuredClone(record.snapshot.resources)
        record = await request(`/api/workbooks/${record.id}`, 'PATCH', { name: 'Phase1I_Disposable_Renamed', expected_revision: record.revision })
        assert.deepEqual(record.snapshot.resources, beforeRename)
        const copy = await request('/api/workbooks', 'POST', { name: 'Phase1I_Disposable_Copy', snapshot: structuredClone(record.snapshot) })
        const modified = await create(copy.snapshot); modified.sheet.clearConditionalFormatRules(); modified.sheet.getRange('A2:A10').setDataValidation(null)
        await request(`/api/workbooks/${copy.id}`, 'PUT', { name: copy.name, snapshot: modified.workbook.save(), expected_revision: copy.revision })
        assert.deepEqual((await request(`/api/workbooks/${record.id}`)).snapshot, record.snapshot)
        const removed = await fetch(`${base}/api/workbooks/${copy.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: copy.revision + 1 }) })
        assert.equal(removed.status, 204)
        await fs.writeFile(memoPath, JSON.stringify({ id: record.id, revision: record.revision }))
      }
      const document = await request(`/api/workbooks/${record.id}/native`)
      assert.deepEqual(document.snapshot, record.snapshot)
      const reimported = await request('/api/native-files/import', 'POST', { name: record.name, document })
      assert.deepEqual(reimported.snapshot, record.snapshot)
      const reopened = await create(document.snapshot)
      await validationCases(reopened); await styleMatches(reopened, 'G2:G5', [true, false, true, false]); await styleMatches(reopened, 'F2:F5', [false, false, true, true])
    })
  }
  assert.deepEqual(await ownerFingerprint(), beforeOwner)
  console.log(JSON.stringify({ results, ownerStorage: 'UNCHANGED', browserUi: 'NOT_TESTED' }, null, 2))
} finally { for (const rt of runtimes.reverse()) rt.univer.dispose() }
