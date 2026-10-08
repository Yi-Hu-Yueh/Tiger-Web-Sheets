import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import ExcelJS from 'exceljs'
import { zipSync, unzipSync, strToU8 } from 'fflate'
import { Univer, LocaleType, IUniverInstanceService } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import '@univerjs/sheets-formula/facade'
import { baselineSnapshot, normalizedFeatures } from './phase1g/adapters.mjs'

process.on('uncaughtException', (error) => { console.error(error.message); process.exit(1) })

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = path.join(root, '.cache/phase1gr1-results')
await fs.mkdir(output, { recursive: true })
const modules = new Map()
async function moduleUrl(filename) {
  const absolute = path.resolve(filename)
  if (modules.has(absolute)) return modules.get(absolute)
  let source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  for (const match of [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]) {
    const resolved = match[1].startsWith('.') ? await moduleUrl(path.resolve(path.dirname(absolute), `${match[1]}.ts`)) : import.meta.resolve(match[1])
    source = source.replace(match[0], `from '${resolved}'`)
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  modules.set(absolute, url); return url
}
const production = async (name) => import(await moduleUrl(path.join(root, 'frontend/src', name)))
const { securityPreflight, decodeRange } = await production('xlsx/xlsxSecurity.ts')
const { fromExcelJS } = await production('xlsx/xlsxImport.ts')
const { toExcelJS, verifyExport } = await production('xlsx/xlsxExport.ts')
const { inspectSnapshot } = await production('xlsx/xlsxCompatibility.ts')
const { recalculateXlsx } = await production('xlsx/xlsxRecalculation.ts')
const { assertAllowed } = await production('xlsx/xlsxTypes.ts')
let workerSource = ts.transpileModule(await fs.readFile(path.join(root, 'frontend/src/xlsx/xlsxWorkerClient.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
workerSource = workerSource.replace("new URL('./xlsxWorker.ts', import.meta.url)", "new URL('file:///isolated-test/xlsxWorker.ts')")
const { runXlsxWorker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`)
const files = await production('files/xlsxFileAccess.ts')
const ownerPaths = [path.join(root, 'data/tiger_web_sheets.db'), ...(await fs.readdir(path.join(root, 'workbooks'))).map((name) => path.join(root, 'workbooks', name))]
const fingerprint = async () => Object.fromEntries(await Promise.all(ownerPaths.map(async (name) => [path.relative(root, name), createHash('sha256').update(await fs.readFile(name)).digest('hex')])))
const before = await fingerprint()
const arrayBuffer = (bytes) => Uint8Array.from(bytes).buffer
const expected = baselineSnapshot()
expected.sheets[expected.sheetOrder[0]].cellData[0][0].s.cl = { rgb: '#2244AA' }
const fixtureBook = toExcelJS(new ExcelJS.Workbook(), expected)
fixtureBook.getWorksheet('工作表1').getCell('F1').value = new Date('2026-10-08T00:00:00Z')
const fixture = arrayBuffer(await fixtureBook.xlsx.writeBuffer())
await fs.writeFile(path.join(output, 'Phase1G-Representative.xlsx'), Buffer.from(fixture))
const preflight = securityPreflight(fixture)
const readBook = new ExcelJS.Workbook()
await readBook.xlsx.load(fixture)
const imported = fromExcelJS(readBook, 'Phase1G-Representative', preflight.findings)
const cell = (snapshot, r, c) => snapshot.sheets[snapshot.sheetOrder[0]].cellData[r]?.[c]
assert.equal(cell(imported.snapshot, 2, 0).v, null)
assert.equal(cell(imported.snapshot, 0, 8).v, null)
const scalarsBook = new ExcelJS.Workbook()
const scalarsSheet = scalarsBook.addWorksheet('型別')
scalarsSheet.getCell('A1').value = true
scalarsSheet.getCell('A2').value = false
scalarsSheet.getCell('A3').value = { error: '#DIV/0!' }
scalarsSheet.getCell('A4').value = ''
scalarsSheet.getCell('B1').value = new Date('2026-10-08T00:00:00Z')
scalarsSheet.getCell('B1').numFmt = 'yyyy-mm-dd'
scalarsSheet.getCell('B2').value = { formula: 'B1', result: new Date('2026-10-08T00:00:00Z') }
scalarsSheet.getCell('B2').numFmt = 'yyyy-mm-dd'
const typed = fromExcelJS(scalarsBook, 'types')
assert.deepEqual([0, 1, 2].map((r) => [cell(typed.snapshot, r, 0).v, cell(typed.snapshot, r, 0).t]), [[true, 3], [false, 3], ['#DIV/0!', 4]])
const typedExpected = toExcelJS(new ExcelJS.Workbook(), typed.snapshot)
const typedReread = new ExcelJS.Workbook()
await typedReread.xlsx.load(await typedExpected.xlsx.writeBuffer())
verifyExport(typedExpected, typedReread)
assert.deepEqual([0, 1, 2].map((r) => cell(imported.snapshot, r, 2).v), ['00123', '0912345678', '01234567'])
const univer = new Univer({ locale: LocaleType.ZH_TW, locales: { [LocaleType.ZH_TW]: {} } })
univer.registerPlugin(UniverFormulaEnginePlugin)
univer.registerPlugin(UniverSheetsPlugin)
univer.registerPlugin(UniverSheetsFormulaPlugin)
const api = FUniver.newAPI(univer)
const workbook = api.createWorkbook(structuredClone(imported.snapshot))
univer.__getInjector().get(IUniverInstanceService).focusUnit(workbook.getId())
await recalculateXlsx(api, imported.snapshot)
const sheet = workbook.getSheetByName('工作表1')
assert.equal(sheet.getRange('A3').getValue(), 30)
assert.equal(sheet.getRange('I1').getValue(), 100)
sheet.getRange('A1').setValue(15)
await recalculateXlsx(api, workbook.save())
assert.equal(sheet.getRange('A3').getValue(), 35)
sheet.getRange('A1').setValue(10)
await recalculateXlsx(api, workbook.save())
const calculated = workbook.save()
const generatedBook = toExcelJS(new ExcelJS.Workbook(), calculated)
const generated = arrayBuffer(await generatedBook.xlsx.writeBuffer())
securityPreflight(generated)
const reread = new ExcelJS.Workbook()
await reread.xlsx.load(generated)
verifyExport(generatedBook, reread)
await fs.writeFile(path.join(output, 'Tiger-XLSX-Roundtrip.xlsx'), Buffer.from(generated))
const roundtrip = fromExcelJS(reread, 'roundtrip')
const baseline = normalizedFeatures(expected)
const matrix = Object.fromEntries(Object.keys(baseline).map((key) => [key, isDeepStrictEqual(normalizedFeatures(roundtrip.snapshot)[key], baseline[key]) ? 'PASS' : 'FAIL']))
const roundStyle = (r, c) => { const data = cell(roundtrip.snapshot, r, c); return typeof data.s === 'string' ? roundtrip.snapshot.styles[data.s] : data.s }
matrix.traditionalChinese = cell(roundtrip.snapshot, 0, 1).v === '台中公司' ? 'PASS' : 'FAIL'
matrix.percentage = roundStyle(0, 3).n.pattern === '0.00%' ? 'PASS' : 'FAIL'
matrix.currency = roundStyle(0, 4).n.pattern === '"NT$"#,##0.00' ? 'PASS' : 'FAIL'
matrix.dateFormat = roundStyle(0, 5).n.pattern === 'yyyy-mm-dd' ? 'PASS' : 'FAIL'
matrix.RGBfontColor = roundStyle(0, 0).cl.rgb === '#2244AA' ? 'PASS' : 'FAIL'
matrix.wrap = roundStyle(0, 6).tb === 3 ? 'PASS' : 'FAIL'
assert.ok(Object.values(matrix).every((value) => value === 'PASS'), JSON.stringify(matrix))
// A second, independent OOXML verification is run with Python xml_check.py.
const unsupportedBook = new ExcelJS.Workbook()
await unsupportedBook.xlsx.load(fixture)
unsupportedBook.getWorksheet('工作表1').getCell('J1').value = { formula: 'TIGER_UNSUPPORTED(A1)', result: 123456 }
const unsupported = fromExcelJS(unsupportedBook, 'unsupported')
assert.equal(cell(unsupported.snapshot, 0, 9).v, null)
assert.ok(unsupported.summary.findings.some((finding) => finding.code === 'formula'))
const namedFormula = structuredClone(imported.snapshot)
cell(namedFormula, 0, 0).f = '=NamedRevenue'
assert.ok(inspectSnapshot(namedFormula).findings.some((finding) => finding.code === 'formula'))
sheet.getRange('J1').setValue({ f: '=TIGER_UNSUPPORTED(A1)', v: null })
await recalculateXlsx(api, workbook.save())
assert.equal(sheet.getRange('J1').getValue(), '#NAME?')
assert.ok(inspectSnapshot(workbook.save()).findings.some((finding) => finding.code === 'formula'))
univer.dispose()

const security = {}
function rejected(name, callback) { assert.throws(callback, undefined, name); security[name] = 'PASS' }
rejected('invalid signature', () => securityPreflight(new ArrayBuffer(22)))
rejected('compressed 10MiB', () => securityPreflight(new ArrayBuffer(10 * 1024 * 1024 + 1)))
rejected('truncated archive', () => securityPreflight(fixture.slice(0, -12)))
rejected('invalid coordinates', () => decodeRange('XFE1048577'))
const sourceZip = unzipSync(new Uint8Array(fixture))
const modified = (name, content) => arrayBuffer(zipSync({ ...sourceZip, [name]: typeof content === 'string' ? strToU8(content) : content }, { level: 6 }))
rejected('malformed XML', () => securityPreflight(modified('xl/workbook.xml', '<workbook><bad></workbook>')))
rejected('DTD', () => securityPreflight(modified('xl/workbook.xml', '<!DOCTYPE workbook [<!ENTITY x "attack">]><workbook/>')))
rejected('path traversal', () => securityPreflight(modified('../attack', 'x')))
rejected('macro', () => securityPreflight(modified('xl/vbaProject.bin', new Uint8Array([1, 2, 3]))))
rejected('external links', () => securityPreflight(modified('xl/externalLinks/externalLink1.xml', '<externalLink/>')))
rejected('external relationship', () => securityPreflight(modified('xl/_rels/workbook.xml.rels', '<Relationships><Relationship TargetMode="External" Target="https://example.com"/></Relationships>')))
rejected('bomb ratio', () => securityPreflight(modified('bomb', new Uint8Array(1_000_000))))
const entryLimit = new Uint8Array(fixture.slice(0))
const centralAt = entryLimit.findIndex((_, i) => entryLimit[i] === 0x50 && entryLimit[i + 1] === 0x4b && entryLimit[i + 2] === 1 && entryLimit[i + 3] === 2)
new DataView(entryLimit.buffer).setUint32(centralAt + 24, 16 * 1024 * 1024 + 1, true)
rejected('entry 16MiB', () => securityPreflight(entryLimit.buffer))
let randomState = 17
const pattern = Uint8Array.from({ length: 10_000 }, () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState >>> 24 })
const expandedEntry = new Uint8Array(14 * 1024 * 1024)
for (let at = 0; at < expandedEntry.length; at += pattern.length) expandedEntry.set(pattern.subarray(0, Math.min(pattern.length, expandedEntry.length - at)), at)
const expansionZip = arrayBuffer(zipSync(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`expanded-${i}`, expandedEntry])), { level: 6 }))
rejected('total expansion 64MiB', () => securityPreflight(expansionZip))
const huge = {}
for (let i = 0; i < 2049; i++) huge[`entry-${i}`] = strToU8('x')
rejected('entries 2048', () => securityPreflight(arrayBuffer(zipSync(huge))))
const manySheets = { ...sourceZip }
for (let i = 2; i <= 34; i++) manySheets[`xl/worksheets/sheet${i}.xml`] = strToU8('<worksheet/>')
rejected('sheets 32', () => securityPreflight(arrayBuffer(zipSync(manySheets))))
rejected('sparse coordinates', () => securityPreflight(modified('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="999999"><c r="A999999"><v>1</v></c></row></sheetData></worksheet>')))
let hugeCells = '<worksheet><sheetData>'
for (let r = 1; r <= 12501; r++) {
  hugeCells += `<row r="${r}">`
  for (let c = 0; c < 20; c++) hugeCells += `<c r="${String.fromCharCode(65 + c)}${r}"><v>${r * 20 + c}</v></c>`
  hugeCells += '</row>'
}
hugeCells += '</sheetData></worksheet>'
rejected('cells 250000', () => securityPreflight(modified('xl/worksheets/sheet1.xml', hugeCells)))
const warning = securityPreflight(modified('xl/charts/chart1.xml', '<chartSpace/>'))
assert.ok(warning.findings.some((finding) => finding.code === 'charts' && finding.level === 'WARNING'))
const fake = structuredClone(calculated)
cell(fake, 0, 0).f = '=AVERAGE(A1:A2)'
assert.ok(inspectSnapshot(fake).findings.some((finding) => finding.code === 'formula'))
cell(fake, 0, 0).f = '=WEBSERVICE("https://example.com")'
rejected('active connection formula', () => assertAllowed(inspectSnapshot(fake)))
cell(fake, 0, 0).f = "='[external.xlsx]Sheet1'!A1"
rejected('unsafe export formula', () => assertAllowed(inspectSnapshot(fake)))
const broken = new ExcelJS.Workbook()
await broken.xlsx.load(generated)
broken.getWorksheet('工作表1').getCell('C1').value = 123
rejected('export reread mismatch', () => verifyExport(generatedBook, broken))

// Protocol-level cancellation/termination tests. Real browser worker checks remain separate.
const workers = []
globalThis.Worker = class {
  terminated = false
  constructor() { workers.push(this) }
  postMessage(request) { this.request = request }
  terminate() { this.terminated = true }
}
const workerCancelled = new AbortController()
const pending = runXlsxWorker({ operation: 'import', bytes: fixture.slice(0), name: 'cancel' }, workerCancelled.signal)
workerCancelled.abort()
await assert.rejects(pending, { name: 'AbortError' })
assert.ok(workers.at(-1).terminated)
const messages = []
const completing = runXlsxWorker({ operation: 'inspect', snapshot: calculated }, new AbortController().signal, (message) => messages.push(message))
workers.at(-1).onmessage({ data: { type: 'progress', message: 'progress' } })
workers.at(-1).onmessage({ data: { type: 'result', result: imported.summary, elapsedMs: 1 } })
assert.equal((await completing).elapsedMs, 1)
assert.deepEqual(messages, ['progress'])
assert.ok(workers.at(-1).terminated)
const failedWorker = runXlsxWorker({ operation: 'inspect', snapshot: calculated }, new AbortController().signal)
workers.at(-1).onerror()
await assert.rejects(failedWorker, /Worker/)
assert.ok(workers.at(-1).terminated)
const badMessage = runXlsxWorker({ operation: 'inspect', snapshot: calculated }, new AbortController().signal)
workers.at(-1).onmessageerror()
await assert.rejects(badMessage, /傳輸/)
assert.ok(workers.at(-1).terminated)

let writes = 0, committedBytes = new ArrayBuffer(0), aborted = 0
const handle = {
  kind: 'file', name: 'fixture.xlsx', queryPermission: async () => 'granted',
  getFile: async () => new File([committedBytes], 'fixture.xlsx'),
  createWritable: async () => ({ write: async (bytes) => { committedBytes = bytes; writes++ }, close: async () => {}, abort: async () => { aborted++ } }),
}
globalThis.window = {
  showOpenFilePicker: async () => { throw new DOMException('cancel', 'AbortError') },
  showSaveFilePicker: async () => { throw new DOMException('cancel', 'AbortError') },
}
assert.equal(await files.chooseXlsxOpenFile(), null)
assert.equal(await files.chooseXlsxSaveFile('fixture'), null)
assert.equal(writes, 0)
await files.writeXlsxFile(handle, generated, new AbortController().signal)
assert.equal(writes, 1)
const cancelled = new AbortController(); cancelled.abort()
await assert.rejects(files.writeXlsxFile(handle, generated, cancelled.signal), { name: 'AbortError' })
assert.equal(writes, 1)
await assert.rejects(files.writeXlsxFile({ ...handle, queryPermission: async () => 'denied', requestPermission: async () => 'denied' }, generated, new AbortController().signal))
await assert.rejects(files.writeXlsxFile({ ...handle, createWritable: async () => ({ write: async () => { throw new Error('disk full') }, close: async () => {}, abort: async () => { aborted++ } }) }, generated, new AbortController().signal))
assert.ok(aborted > 0)
await assert.rejects(files.writeXlsxFile({ ...handle, getFile: async () => new File(['wrong'], 'fixture.xlsx') }, generated, new AbortController().signal))
assert.deepEqual(await fingerprint(), before, 'Owner DB and managed files must remain unchanged')
const evidence = { result: 'PASS', scope: 'Deterministic non-browser regression', matrix, security, formula: { sum: 30, editedSum: 35, crossSheet: 100, unsupported: '#NAME?', allCachesDiscarded: true }, workerProtocol: { cancellationTerminates: 'PASS', completionTerminates: 'PASS', errorTerminates: 'PASS', messageErrorTerminates: 'PASS', realBrowser: 'NOT_RUN_BY_THIS_SUITE' }, files: { pickerCancel: 'PASS', binaryWriteReadback: 'PASS', cancelledWrite: 'PASS', permissionFailure: 'PASS', writeFailure: 'PASS', readbackFailure: 'PASS' }, ownerFilesUnchanged: true, browser: 'Separate owner runtime acceptance is recorded in docs/PHASE1G_XLSX.md; this suite does not automate a browser' }
await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify(evidence, null, 2))
