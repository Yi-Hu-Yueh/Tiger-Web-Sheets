import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  IUniverInstanceService,
  LocaleType,
  Univer,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import {
  SortRangeCommand,
  SortType,
  UniverSheetsSortPlugin,
} from '@univerjs/sheets-sort'

const fixtureUrl = new URL(
  '../../backend/tests/fixtures/phase1d_data_operations.json',
  import.meta.url,
)
const sourceSnapshot = JSON.parse(await fs.readFile(fixtureUrl, 'utf8'))

function createRuntime(snapshot) {
  const univer = new Univer({
    locale: LocaleType.ZH_TW,
    locales: { [LocaleType.ZH_TW]: {} },
  })
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsSortPlugin)

  const api = FUniver.newAPI(univer)
  const workbook = api.createWorkbook(snapshot)
  univer.__getInjector().get(IUniverInstanceService).focusUnit(workbook.getId())
  const sheet = workbook.getSheetByName('資料整理測試')
  assert.ok(sheet, 'Phase 1D worksheet must exist')
  sheet.activate()
  return { univer, api, workbook, sheet }
}

const expectedTuples = {
  R001: ['R001', '李小華', '0922222222', 100, '台北'],
  R002: ['R002', '林小美', '0944444444', 200, '高雄'],
  R003: ['R003', '王小明', '0911111111', 300, '台中'],
  R004: ['R004', '陳大同', '0933333333', 400, '台中'],
}
const header = ['ID', '姓名', '電話', '金額', '城市']
const originalOrder = ['R003', 'R001', 'R004', 'R002']
const ascendingOrder = ['R001', 'R002', 'R003', 'R004']
const descendingOrder = [...ascendingOrder].reverse()
const ascendingTuples = ascendingOrder.map((id) => expectedTuples[id])
const descendingTuples = descendingOrder.map((id) => expectedTuples[id])

const runtime = createRuntime(sourceSnapshot)
const { univer, api, workbook, sheet } = runtime
const observedCommands = []
api.addEvent(api.Event.CommandExecuted, (event) => observedCommands.push(event.id))

const rows = () => sheet.getRange('A2:E5').getValues()
const ids = () => rows().map((row) => row[0])
const assertWholeRecords = () => {
  assert.deepEqual(sheet.getRange('A1:E1').getValues()[0], header)
  for (const row of rows()) {
    assert.deepEqual(row, expectedTuples[row[0]])
    assert.match(row[2], /^0\d{9}$/)
  }
}

async function safeSort(colIndex, type) {
  const result = await api.executeCommand(SortRangeCommand.id, {
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
  assert.equal(result, true)
  assertWholeRecords()
}

assert.deepEqual(ids(), originalOrder)
assertWholeRecords()

await safeSort(3, SortType.ASC)
assert.deepEqual(ids(), ascendingOrder)
assert.deepEqual(rows(), ascendingTuples)

assert.equal(await api.undo(), true)
assert.deepEqual(ids(), originalOrder)
assertWholeRecords()

assert.equal(await api.redo(), true)
assert.deepEqual(ids(), ascendingOrder)
assertWholeRecords()

await safeSort(3, SortType.DESC)
assert.deepEqual(ids(), descendingOrder)
assert.deepEqual(rows(), descendingTuples)

const savedSnapshot = workbook.save()
univer.dispose()

const reloaded = createRuntime(savedSnapshot)
assert.deepEqual(reloaded.sheet.getRange('A1:E1').getValues()[0], header)
assert.deepEqual(
  reloaded.sheet.getRange('A2:A5').getValues().flat(),
  descendingOrder,
)
for (const row of reloaded.sheet.getRange('A2:E5').getValues()) {
  assert.deepEqual(row, expectedTuples[row[0]])
}
reloaded.univer.dispose()

assert.ok(observedCommands.includes(SortRangeCommand.id))
assert.ok(observedCommands.includes('sheet.mutation.reorder-range'))

console.log(JSON.stringify({
  result: 'PASS',
  range: '資料整理測試!A1:E5',
  headerPreserved: true,
  fullTupleIntegrity: true,
  leadingZeroStringsPreserved: true,
  ascendingOrder,
  descendingOrder,
  ascendingTuples,
  descendingTuples,
  undoRedo: true,
  snapshotReload: true,
  nativeCommand: SortRangeCommand.id,
}, null, 2))
