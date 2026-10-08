import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  ICommandService,
  IUniverInstanceService,
  LocaleType,
  Univer,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import '@univerjs/sheets-filter/facade'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import {
  SortRangeCommand,
  SortType,
  UniverSheetsSortPlugin,
} from '@univerjs/sheets-sort'
import '@univerjs/sheets-sort/facade'

const fixtureUrl = new URL(
  '../../backend/tests/fixtures/phase1d_data_operations.json',
  import.meta.url,
)
const sourceSnapshot = JSON.parse(await fs.readFile(fixtureUrl, 'utf8'))

function createHeadlessUniver(snapshot) {
  const univer = new Univer({
    locale: LocaleType.ZH_TW,
    locales: { [LocaleType.ZH_TW]: {} },
  })
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsFormulaPlugin)
  univer.registerPlugin(UniverSheetsSortPlugin)
  univer.registerPlugin(UniverSheetsFilterPlugin)

  const api = FUniver.newAPI(univer)
  const workbook = api.createWorkbook(snapshot)
  univer.__getInjector().get(IUniverInstanceService).focusUnit(workbook.getId())
  const sheet = workbook.getSheetByName('資料整理測試')
  assert.ok(sheet, 'Phase 1D worksheet must exist')
  sheet.activate()

  return { univer, api, workbook, sheet }
}

const settleFormula = () => new Promise((resolve) => setTimeout(resolve, 250))
const originalIds = ['R003', 'R001', 'R004', 'R002']
const expectedById = {
  R001: ['李小華', '0922222222', 100, '台北'],
  R002: ['林小美', '0944444444', 200, '高雄'],
  R003: ['王小明', '0911111111', 300, '台中'],
  R004: ['陳大同', '0933333333', 400, '台中'],
}

const runtime = createHeadlessUniver(sourceSnapshot)
const { univer, api, workbook, sheet } = runtime
const commandIds = []
api.addEvent(api.Event.CommandExecuted, (event) => commandIds.push(event.id))

const recordRows = () => sheet.getRange('A2:F5').getValues()
const ids = () => recordRows().map((row) => row[0])
const assertRecordIntegrity = () => {
  for (const row of recordRows()) {
    const [id, name, phone, amount, city, afterTax] = row
    assert.deepEqual([name, phone, amount, city], expectedById[id])
    assert.equal(phone.startsWith('0'), true)
    assert.equal(afterTax, amount * 0.95)
  }
  assert.deepEqual(sheet.getRange('A1:E1').getValues()[0], [
    'ID',
    '姓名',
    '電話',
    '金額',
    '城市',
  ])
  assert.deepEqual(sheet.getRange('F2:F5').getFormulas().flat(), [
    '=D2*0.95',
    '=D3*0.95',
    '=D4*0.95',
    '=D5*0.95',
  ])
}

const sortRange = async (colIndex, type) => {
  const ok = await api.executeCommand(SortRangeCommand.id, {
    unitId: workbook.getId(),
    subUnitId: sheet.getSheetId(),
    range: {
      startRow: 0,
      startColumn: 0,
      endRow: 4,
      endColumn: 4,
    },
    orderRules: [{ colIndex, type }],
    hasTitle: true,
  })
  assert.equal(ok, true)
  await settleFormula()
  assertRecordIntegrity()
}

await sortRange(3, SortType.ASC)
assert.deepEqual(ids(), ['R001', 'R002', 'R003', 'R004'])
assert.equal(await api.undo(), true)
await settleFormula()
assert.deepEqual(ids(), originalIds)
assertRecordIntegrity()
assert.equal(await api.redo(), true)
await settleFormula()
assert.deepEqual(ids(), ['R001', 'R002', 'R003', 'R004'])
assertRecordIntegrity()

await sortRange(3, SortType.DESC)
assert.deepEqual(ids(), ['R004', 'R003', 'R002', 'R001'])

await sortRange(1, SortType.ASC)
const textSortNames = recordRows().map((row) => row[1])
assert.deepEqual(textSortNames, ['李小華', '林小美', '王小明', '陳大同'])

await sortRange(0, SortType.ASC)
assert.deepEqual(ids(), ['R001', 'R002', 'R003', 'R004'])

const filter = sheet.getRange('A1:F5').createFilter()
assert.ok(filter, 'Filter must be created')
filter.setColumnFilterCriteria(4, {
  colId: 4,
  filters: { filters: ['台中'] },
})
assert.deepEqual(filter.getFilteredOutRows(), [1, 2])
const cityFilterResource = workbook
  .save()
  .resources.find((resource) => resource.name === 'SHEET_FILTER_PLUGIN')
assert.ok(cityFilterResource?.data.includes('台中'))

filter.removeFilterCriteria()
assert.deepEqual(filter.getFilteredOutRows(), [])
filter.setColumnFilterCriteria(3, {
  colId: 3,
  filters: { filters: ['100', '200'] },
})
assert.deepEqual(filter.getFilteredOutRows(), [3, 4])
filter.removeFilterCriteria()
assert.deepEqual(filter.getFilteredOutRows(), [])

filter.setColumnFilterCriteria(4, {
  colId: 4,
  filters: { filters: ['台中'] },
})
const persistedSnapshot = workbook.save()
assert.deepEqual(
  persistedSnapshot.sheets['regression-sheet'].cellData[0][0],
  { v: '00123', t: 1 },
)

univer.dispose()

const reloaded = createHeadlessUniver(persistedSnapshot)
await settleFormula()
const reloadedFilter = reloaded.sheet.getFilter()
assert.ok(reloadedFilter, 'Persisted filter must reload')
assert.deepEqual(reloadedFilter.getFilteredOutRows(), [1, 2])
assert.deepEqual(
  reloaded.sheet.getRange('A2:A5').getValues().flat(),
  ['R001', 'R002', 'R003', 'R004'],
)

let apiPersistence = null
const apiUrl = process.env.PHASE1D_API_URL
if (apiUrl) {
  const expectedDatabasePath = process.env.PHASE1D_EXPECTED_DB_PATH
  const expectedNonce = process.env.PHASE1D_INSTANCE_NONCE
  assert.ok(
    expectedDatabasePath && expectedNonce,
    'API persistence requires PHASE1D_EXPECTED_DB_PATH and PHASE1D_INSTANCE_NONCE',
  )
  const healthResponse = await fetch(`${apiUrl}/api/health`)
  assert.equal(healthResponse.ok, true)
  const health = await healthResponse.json()
  assert.equal(health.runtime_mode, 'isolated-test')
  assert.equal(health.instance_nonce, expectedNonce)
  assert.equal(
    health.database_path.replaceAll('\\', '/').toLowerCase(),
    expectedDatabasePath.replaceAll('\\', '/').toLowerCase(),
  )

  const current = await fetch(`${apiUrl}/api/workbooks/default`)
  assert.ok(current.ok || current.status === 404)
  const currentWorkbook = current.ok ? await current.json() : { revision: 0 }
  const saved = await fetch(`${apiUrl}/api/workbooks/default`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: persistedSnapshot.name,
      snapshot: persistedSnapshot,
      expected_revision: currentWorkbook.revision,
    }),
  })
  assert.equal(saved.ok, true)
  const savedWorkbook = await saved.json()
  const loaded = await fetch(`${apiUrl}/api/workbooks/default`)
  assert.equal(loaded.ok, true)
  const loadedWorkbook = await loaded.json()
  assert.deepEqual(loadedWorkbook.snapshot, persistedSnapshot)
  apiPersistence = { revision: savedWorkbook.revision }
}

reloaded.univer.dispose()

console.log(
  JSON.stringify(
    {
      result: 'PASS',
      numericAscending: ['R001', 'R002', 'R003', 'R004'],
      numericDescending: ['R004', 'R003', 'R002', 'R001'],
      textAscending: textSortNames,
      filterCityVisible: ['R003', 'R004'],
      filterNumericVisible: ['R001', 'R002'],
      filterPersisted: true,
      formulaColumn: 'kept outside sort range and recalculated per destination row',
      mutationCommands: [...new Set(commandIds)],
      apiPersistence,
    },
    null,
    2,
  ),
)
