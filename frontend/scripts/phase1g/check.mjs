import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { Univer, LocaleType, IUniverInstanceService } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import '@univerjs/sheets-formula/facade'
import { baselineSnapshot, normalizedFeatures, fromExcelJS, toExcelJS, fromSheetJS, toSheetJS, LIMITS } from './adapters.mjs'
import { inspectXlsx, ZIP_LIMITS } from './security.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const deps = path.join(root, '.cache/phase1g-deps/node_modules')
const output = path.join(root, '.cache/phase1g-results')
await fs.mkdir(output, { recursive: true })
const ExcelJS = (await import(pathToFileURL(path.join(deps, 'exceljs/excel.js')))).default
const XLSX = await import(pathToFileURL(path.join(deps, 'xlsx/xlsx.mjs')))
const JSZip = (await import(pathToFileURL(path.join(deps, 'jszip/lib/index.js')))).default
const excelPackage = JSON.parse(await fs.readFile(path.join(deps, 'exceljs/package.json')))
assert.equal(excelPackage.version, '4.4.0')
assert.equal(XLSX.version, '0.20.3')
const ownerFiles = [path.join(root, 'data/tiger_web_sheets.db'), ...(await fs.readdir(path.join(root, 'workbooks'))).map((name) => path.join(root, 'workbooks', name))]
const fingerprint = async () => Object.fromEntries(await Promise.all(ownerFiles.map(async (filename) => [path.relative(root, filename), createHash('sha256').update(await fs.readFile(filename)).digest('hex')])))
const before = await fingerprint()
const expected = baselineSnapshot()
const features = normalizedFeatures(expected)

async function readExcel(bytes) {
  inspectXlsx(bytes)
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes)
  return fromExcelJS(book)
}
function readSheet(bytes) {
  inspectXlsx(bytes)
  return fromSheetJS(XLSX, XLSX.read(bytes, { type: 'buffer', cellStyles: true, cellNF: true, cellFormula: true, cellDates: false, xlfn: true, WTF: true }))
}
const writeExcel = async (snapshot) => Buffer.from(await toExcelJS(ExcelJS, snapshot).xlsx.writeBuffer())
const writeSheet = (snapshot) => Buffer.from(XLSX.write(toSheetJS(XLSX, snapshot), { type: 'buffer', bookType: 'xlsx', compression: true, cellStyles: true }))
const matrix = (actual) => Object.fromEntries(Object.keys(features).map((key) => [key, isDeepStrictEqual(normalizedFeatures(actual)[key], features[key]) ? 'PASS' : 'FAIL']))

async function runtime(snapshot, verify = true) {
  const univer = new Univer({ locale: LocaleType.ZH_TW, locales: { [LocaleType.ZH_TW]: {} } })
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsFormulaPlugin)
  const api = FUniver.newAPI(univer)
  const workbook = api.createWorkbook(snapshot)
  univer.__getInjector().get(IUniverInstanceService).focusUnit(workbook.getId())
  const sheet = workbook.getSheetByName('工作表1')
  if (verify) {
    api.getFormula().executeCalculation()
    for (let i = 0; i < 80; i++) {
      if (sheet.getRange('A3').getValue() === 30 && sheet.getRange('I1').getValue() === 100) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(sheet.getRange('A3').getValue(), 30, 'stale SUM cache must recalculate')
    assert.equal(sheet.getRange('I1').getValue(), 100, 'stale cross-sheet cache must recalculate')
    assert.deepEqual(sheet.getRange('C1:C3').getValues().flat(), ['00123', '0912345678', '01234567'])
    assert.equal(sheet.getRange('B5').getValue(), '=1+1')
    const saved = workbook.save()
    assert.equal(saved.sheets[saved.sheetOrder[0]].cellData[2][0].f, '=SUM(A1:A2)')
    sheet.getRange('A1').setValue(15)
    for (let i = 0; i < 80 && sheet.getRange('A3').getValue() !== 35; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(sheet.getRange('A3').getValue(), 35, 'supported formula must respond to an edit')
    sheet.getRange('A1').setValue(10)
    for (let i = 0; i < 80 && sheet.getRange('A3').getValue() !== 30; i++) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const saved = workbook.save()
  const result = { snapshot: saved, calculated: verify ? { sum: sheet.getRange('A3').getValue(), crossSheet: sheet.getRange('I1').getValue() } : null }
  univer.dispose()
  return result
}

// One controlled source fixture, read by both candidates. Add a real date cell.
const fixtureBook = toExcelJS(ExcelJS, expected)
fixtureBook.getWorksheet('工作表1').getCell('F1').value = new Date('2026-10-08T00:00:00Z')
const fixture = Buffer.from(await fixtureBook.xlsx.writeBuffer())
await fs.writeFile(path.join(output, 'baseline.xlsx'), fixture)
const evidence = {
  result: null, versions: { sheetjs: XLSX.version, exceljs: excelPackage.version, univer: '1.0.3', node: process.version },
  sourceSha256: createHash('sha256').update(fixture).digest('hex'), fixtureSecurity: inspectXlsx(fixture), candidates: {}, performance: [], security: {},
}

for (const [name, read, write, independent] of [['ExcelJS', readExcel, writeExcel, readSheet], ['SheetJS CE', readSheet, writeSheet, readExcel]]) {
  const imported = await read(fixture)
  const loaded = await runtime(imported.snapshot)
  const exported = await write(loaded.snapshot)
  await fs.writeFile(path.join(output, `${name === 'ExcelJS' ? 'exceljs' : 'sheetjs'}-roundtrip.xlsx`), exported)
  const reopened = await read(exported)
  const checked = await independent(exported)
  const direct = await read(await write(expected))
  evidence.candidates[name] = {
    import: matrix(imported.snapshot), afterUniver: matrix(loaded.snapshot), export: matrix(direct.snapshot),
    roundTrip: matrix(reopened.snapshot), actualImport: normalizedFeatures(imported.snapshot), actualRoundTrip: normalizedFeatures(reopened.snapshot),
    independent: matrix(checked.snapshot), warnings: imported.warnings, formulas: loaded.calculated,
  }
}

// Unsupported formula keeps source text and never trusts the fabricated source cache.
const unknown = baselineSnapshot()
unknown.sheets[unknown.sheetOrder[0]].cellData[3] = { 0: { f: '=TIGER_UNSUPPORTED(A1)', v: 123456, t: 2 } }
const unknownImport = await readExcel(await writeExcel(unknown))
assert.ok(unknownImport.warnings.some((message) => message.includes('TIGER_UNSUPPORTED')))
assert.equal(unknownImport.snapshot.sheets['sheet-1'].cellData[3][0].v, null)
const unknownRuntime = await runtime(unknownImport.snapshot)
const unknownCell = unknownRuntime.snapshot.sheets['sheet-1'].cellData[3][0]
assert.equal(unknownCell.f, '=TIGER_UNSUPPORTED(A1)')
assert.equal(unknownCell.v, '#NAME?')
const unknownReadback = await readExcel(await writeExcel(unknownRuntime.snapshot))
assert.equal(unknownReadback.snapshot.sheets['sheet-1'].cellData[3][0].f, '=TIGER_UNSUPPORTED(A1)')
evidence.unsupportedFormula = { formula: unknownCell.f, result: unknownCell.v, staleCacheDiscarded: true, warning: unknownImport.warnings }

const timed = async (operation) => {
  const start = performance.now()
  const result = await operation()
  return { result, ms: Math.round(performance.now() - start) }
}
for (const rowCount of [1000, 10000]) {
  const large = baselineSnapshot()
  large.sheetOrder = [large.sheetOrder[0]]
  const sheet = large.sheets[large.sheetOrder[0]]
  sheet.name = '工作表1'; sheet.rowCount = rowCount; sheet.columnCount = 26
  sheet.cellData = {}; sheet.mergeData = []; sheet.rowData = {}; sheet.columnData = {}
  for (let r = 0; r < rowCount; r++) {
    sheet.cellData[r] = {}
    for (let c = 0; c < 20; c++) sheet.cellData[r][c] = c === 1 ? { v: `00${r}`, t: 1 } : { v: r * 20 + c, t: 2 }
  }
  const bytes = await writeExcel(large)
  for (const [name, read, write] of [['ExcelJS', readExcel, writeExcel], ['SheetJS CE', readSheet, writeSheet]]) {
    if (global.gc) global.gc()
    const heapBefore = process.memoryUsage().heapUsed
    const imported = await timed(() => read(bytes))
    const model = await timed(() => runtime(imported.result.snapshot, false))
    const exported = await timed(() => write(model.result.snapshot))
    const reopened = await read(exported.result)
    const last = reopened.snapshot.sheets[reopened.snapshot.sheetOrder[0]].cellData[rowCount - 1]
    assert.equal(last[19].v, rowCount * 20 - 1)
    assert.equal(last[1].v, `00${rowCount - 1}`)
    evidence.performance.push({ candidate: name, rows: rowCount, columns: 20, importMs: imported.ms, univerCreateSaveMs: model.ms, exportMs: exported.ms, inputBytes: bytes.length, outputBytes: exported.result.length, heapBeforeMiB: Math.round(heapBefore / 1024 ** 2), heapAfterMiB: Math.round(process.memoryUsage().heapUsed / 1024 ** 2), rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2), stability: 'PASS' })
  }
}

for (const bytes of [Buffer.from('not xlsx'), fixture.subarray(0, 100), Buffer.alloc(LIMITS.fileBytes + 1)]) assert.throws(() => inspectXlsx(bytes))
const archive = await JSZip.loadAsync(fixture)
archive.file('bomb.xml', 'A'.repeat(1024 * 1024))
const bomb = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
assert.throws(() => inspectXlsx(bomb), /expansion/)
const external = await JSZip.loadAsync(fixture)
external.file('xl/externalLinks/externalLink1.xml', '<externalLink/>')
const externalBytes = await external.generateAsync({ type: 'nodebuffer' })
assert.throws(() => inspectXlsx(externalBytes), /external link/)
const broken = await JSZip.loadAsync(fixture)
broken.file('xl/workbook.xml', '<broken')
const brokenBytes = await broken.generateAsync({ type: 'nodebuffer' })
await assert.rejects(readExcel(brokenBytes))
assert.throws(() => readSheet(brokenBytes))
const oversize = await JSZip.loadAsync(fixture)
const sheetXml = await oversize.file('xl/worksheets/sheet1.xml').async('string')
oversize.file('xl/worksheets/sheet1.xml', sheetXml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:XFD1048576"/>'))
await assert.rejects(readExcel(await oversize.generateAsync({ type: 'nodebuffer' })), /cell limit/)
evidence.security = { signature: 'PASS', truncatedArchive: 'PASS', compressedSize: 'PASS', expansionRatio: 'PASS', externalLinks: 'PASS', malformedWorkbookBothCandidates: 'PASS', cellLimit: 'PASS', limits: { ...LIMITS, zip: ZIP_LIMITS }, productionWorkerTimeout: 'REQUIRED_BEFORE_PRODUCTION' }

evidence.browserBundles = {}
for (const [name, bundle] of [['ExcelJS', 'exceljs/dist/exceljs.min.js'], ['SheetJS CE', 'xlsx/dist/xlsx.full.min.js']]) {
  const bytes = await fs.readFile(path.join(deps, bundle))
  evidence.browserBundles[name] = { bytes: bytes.length, gzipBytes: gzipSync(bytes).length }
}
evidence.ownerFilesUnchanged = isDeepStrictEqual(before, await fingerprint())
assert.equal(evidence.ownerFilesUnchanged, true)
evidence.ownerFingerprints = before
assert.ok(Object.values(evidence.candidates.ExcelJS.import).every((status) => status === 'PASS'))
assert.ok(Object.values(evidence.candidates.ExcelJS.export).every((status) => status === 'PASS'))
assert.ok(Object.values(evidence.candidates.ExcelJS.roundTrip).every((status) => status === 'PASS'))
evidence.result = 'PASS'
evidence.recommendation = 'SELECT_EXCELJS'
await fs.writeFile(path.join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(JSON.stringify(evidence, null, 2))
