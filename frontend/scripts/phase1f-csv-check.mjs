import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function transpiledUrl(relativePath, replacements = new Map()) {
  let source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  for (const [from, to] of replacements) source = source.replaceAll(from, to)
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}

const nativeUrl = await transpiledUrl('../src/files/nativeFileAccess.ts')
const parserUrl = await transpiledUrl('../src/csv/csvParser.ts')
const coreUrl = import.meta.resolve('@univerjs/core')
const serializerUrl = await transpiledUrl('../src/csv/csvSerializer.ts', new Map([
  ["'@univerjs/core'", `'${coreUrl}'`],
]))
const csvFileUrl = await transpiledUrl('../src/files/csvFileAccess.ts', new Map([
  ["'./nativeFileAccess'", `'${nativeUrl}'`],
  ["'../csv/csvParser'", `'${parserUrl}'`],
  ["'../csv/csvSerializer'", `'${serializerUrl}'`],
]))

const native = await import(nativeUrl)
const parser = await import(parserUrl)
const serializer = await import(serializerUrl)
const csvFiles = await import(csvFileUrl)

assert.deepEqual(parser.parseCsvText('A,B,C').rows, [['A', 'B', 'C']])
assert.deepEqual(parser.parseCsvText('A,B\r\n甲,乙\r\n').rows, [['A', 'B'], ['甲', '乙']])
assert.deepEqual(parser.parseCsvText('A,B\n甲,乙\n').rows, [['A', 'B'], ['甲', '乙']])
assert.deepEqual(parser.parseCsvText('\uFEFFA,B\r\n王小明,台中').rows, [['A', 'B'], ['王小明', '台中']])
assert.deepEqual(parser.parseCsvText('"台中,西屯",100').rows, [['台中,西屯', '100']])
assert.deepEqual(parser.parseCsvText('"他說 ""您好""",200').rows, [['他說 "您好"', '200']])
assert.deepEqual(parser.parseCsvText('A,"multi\nline",C').rows, [['A', 'multi\nline', 'C']])
assert.deepEqual(parser.parseCsvText('A,,C\r\nA,B,\r\n"",B,C').rows, [
  ['A', '', 'C'],
  ['A', 'B', ''],
  ['', 'B', 'C'],
])
assert.deepEqual(parser.parseCsvText('電話\n0912345678\n01234567\n00123\n=1+1').rows, [
  ['電話'], ['0912345678'], ['01234567'], ['00123'], ['=1+1'],
])
assert.throws(() => parser.parseCsvText(''), parser.CsvParseError)
assert.throws(() => parser.parseCsvText('\r\n'), parser.CsvParseError)
assert.throws(() => parser.parseCsvText('"not closed'), parser.CsvParseError)
assert.throws(() => parser.parseCsvText('"closed"junk'), parser.CsvParseError)
assert.throws(() => parser.parseCsvText(`${'x,'.repeat(parser.MAX_CSV_CELLS)}x`), parser.CsvSizeError)

const representativeRows = [
  ['姓名', '電話', '金額', '城市', '備註', '空白'],
  ['王小明', '0912345678', '100', '台中', '一般資料', ''],
  ['李小華', '0223456789', '250.5', '台北', '含,逗號', ''],
  ['陳大同', '00123', '0', '高雄', '他說 "您好"', ''],
  ['林小美', '01234567', '300', '台南', 'multi-line\nnote', ''],
  ['', '', '', '', '', ''],
]
const serialized = serializer.serializeCsv(representativeRows)
assert.ok(serialized.startsWith('\uFEFF'))
assert.ok(serialized.endsWith('\r\n'))
assert.ok(serialized.includes('"含,逗號"'))
assert.ok(serialized.includes('"他說 ""您好"""'))
assert.ok(serialized.includes('"multi-line\nnote"'))
assert.deepEqual(parser.parseCsvText(serialized).rows, representativeRows)

const importedSnapshot = serializer.createCsvWorkbookSnapshot('客戶清單', '客戶/清單', representativeRows)
const secondImportedSnapshot = serializer.createCsvWorkbookSnapshot('客戶清單', '客戶/清單', representativeRows)
const importedCells = importedSnapshot.sheets['sheet-01'].cellData
assert.notEqual(importedSnapshot.id, secondImportedSnapshot.id)
assert.equal(importedSnapshot.sheets['sheet-01'].name, '客戶 清單')
assert.equal(importedCells[1][1].v, '0912345678')
assert.equal(importedCells[3][1].v, '00123')
assert.equal(importedCells[1][1].t, 1)
assert.equal(importedCells[1][1].f, undefined)
importedCells[1][1].v = 'CHANGED_COPY'
assert.equal(representativeRows[1][1], '0912345678')

assert.deepEqual(serializer.meaningfulCsvRange({
  0: { 0: { v: 'A' }, 5: { v: '' } },
  4: { 2: { f: '=SUM(A1:A2)', v: 30 } },
  9: { 9: { s: 'style-only', v: null } },
}), { rowCount: 5, columnCount: 6 })
let requestedRange
const formulaRows = serializer.csvRowsForWorksheet({
  getRange(row, column, rowCount, columnCount) {
    requestedRange = { row, column, rowCount, columnCount }
    return { getDisplayValues: () => [['10'], ['20'], ['30']] }
  },
}, { 0: { 0: { v: 10 } }, 1: { 0: { v: 20 } }, 2: { 0: { f: '=SUM(A1:A2)', v: 30 } } })
assert.deepEqual(requestedRange, { row: 0, column: 0, rowCount: 3, columnCount: 1 })
assert.deepEqual(formulaRows, [['10'], ['20'], ['30']])

function fakeHandle({ name = 'fixture.csv', bytes = new TextEncoder().encode(serialized), failWrite = false } = {}) {
  let content = bytes
  let writes = 0
  return {
    kind: 'file',
    name,
    async getFile() { return new File([content], name, { type: 'text/csv' }) },
    async queryPermission() { return 'granted' },
    async requestPermission() { return 'granted' },
    async createWritable() {
      if (failWrite) throw new Error('controlled CSV write failure')
      let pending = content
      return {
        async write(value) { writes += 1; pending = new TextEncoder().encode(value) },
        async close() { content = pending },
      }
    },
    stats() { return { content, writes } },
  }
}

globalThis.window = {}
let openOptions
let saveOptions
const openHandle = fakeHandle()
const saveHandle = fakeHandle({ name: '工作表1.csv' })
window.showOpenFilePicker = async (options) => { openOptions = options; return [openHandle] }
window.showSaveFilePicker = async (options) => { saveOptions = options; return saveHandle }
assert.equal(await csvFiles.chooseCsvOpenFile(), openHandle)
assert.equal(await csvFiles.chooseCsvSaveFile('工作表1'), saveHandle)
assert.deepEqual(openOptions.types[0].accept['text/csv'], ['.csv'])
assert.equal(saveOptions.suggestedName, '工作表1.csv')
window.showOpenFilePicker = async () => { throw new DOMException('cancel', 'AbortError') }
window.showSaveFilePicker = async () => { throw new DOMException('cancel', 'AbortError') }
assert.equal(await csvFiles.chooseCsvOpenFile(), null)
assert.equal(await csvFiles.chooseCsvSaveFile('cancel'), null)

assert.equal(await csvFiles.readCsvFile(openHandle), serialized.slice(1))
await assert.rejects(
  csvFiles.readCsvFile(fakeHandle({ bytes: new Uint8Array([0xc3, 0x28]) })),
  csvFiles.CsvEncodingError,
)
await assert.rejects(
  csvFiles.readCsvFile(fakeHandle({ bytes: new Uint8Array(parser.MAX_CSV_FILE_BYTES + 1) })),
  csvFiles.CsvFileSizeError,
)
await csvFiles.writeCsvFile(saveHandle, serialized)
assert.equal(saveHandle.stats().writes, 1)
assert.deepEqual(parser.parseCsvText(new TextDecoder().decode(saveHandle.stats().content)).rows, representativeRows)
await assert.rejects(csvFiles.writeCsvFile(fakeHandle({ failWrite: true }), serialized), native.NativeFileAccessError)

console.log(JSON.stringify({
  result: 'PASS',
  parserCases: true,
  utf8AndBom: true,
  malformedAndLimits: true,
  allTextAndFormulaSafety: true,
  calculatedDisplayValues: true,
  pickerAndCancel: true,
  writeFailure: true,
  representativeRoundTrip: true,
}, null, 2))
