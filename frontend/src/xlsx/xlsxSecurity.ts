import { Inflate } from 'fflate'
import { SaxesParser } from 'saxes'
import { addFinding, assertAllowed, XLSX_LIMITS as L, type Finding } from './xlsxTypes'

const decoder = new TextDecoder('utf-8', { fatal: true })
const fail = (reason: string): never => { throw new Error(`XLSX 驗證失敗：${reason}`) }
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i
  for (let b = 0; b < 8; b++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
export function decodeRange(address: string) {
  const decode = (at: string) => {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(at)
    if (!match) return fail('無效儲存格座標')
    let c = 0
    for (const letter of match[1]) c = c * 26 + letter.charCodeAt(0) - 64
    const r = Number(match[2])
    if (r > 1_048_576 || c > 16_384) fail('座標超過 Excel 範圍')
    return { r: r - 1, c: c - 1 }
  }
  const parts = address.split(':')
  if (parts.length > 2) fail('無效範圍')
  const start = decode(parts[0]), end = decode(parts[1] ?? parts[0])
  if (start.r > end.r || start.c > end.c) fail('倒置範圍')
  return { startRow: start.r, startColumn: start.c, endRow: end.r, endColumn: end.c }
}

/** Bounded, CRC-checked inflation BEFORE ExcelJS/JSZip allocates workbook objects. */
export function securityPreflight(buffer: ArrayBuffer, progress: (message: string) => void = () => {}) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  if (bytes.length > L.compressed) fail('壓縮檔超過 10 MiB')
  if (bytes.length < 22 || u32(0) !== 0x04034b50) fail('不是支援的 ZIP / XLSX（加密檔不支援）')
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { eocd = at; break }
  }
  if (eocd < 0) fail('ZIP 結尾損毀')
  const count = u16(eocd + 10), central = u32(eocd + 16), centralSize = u32(eocd + 12)
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== count) fail('多磁碟 ZIP 不支援')
  if (!count || count > L.entries) fail('ZIP 項目超過 2,048 或為空')
  if (central + centralSize !== eocd) fail('ZIP 中央目錄 / ZIP64 不支援')
  const entries = new Map<string, Uint8Array>(), findings: Finding[] = []
  let cursor = central, total = 0, sheets = 0, cells = 0
  const occupied: Array<[number, number]> = []
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || u32(cursor) !== 0x02014b50) fail('ZIP 中央目錄損毀')
    const flags = u16(cursor + 8), method = u16(cursor + 10), compressed = u32(cursor + 20), expanded = u32(cursor + 24)
    const nameLength = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32), local = u32(cursor + 42)
    if (cursor + 46 + nameLength + extra + comment > eocd) fail('ZIP 目錄越界')
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.split('/').some((part) => part === '..' || part === '.') || entries.has(name)) fail('危險 / 重複 ZIP 路徑')
    if (flags & ~0x0808 || ![0, 8].includes(method) || u16(cursor + 34)) fail('加密 / 不支援的 ZIP 壓縮')
    if (expanded > L.entry || expanded / Math.max(1, compressed) > L.ratio) fail('項目超過 16 MiB 或 200:1 展開比例')
    total += expanded
    if (total > L.expanded) fail('展開總量超過 64 MiB')
    if (local + 30 > central || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) fail('ZIP 本機標頭不一致')
    const localNameLength = u16(local + 26), dataStart = local + 30 + localNameLength + u16(local + 28)
    if (dataStart + compressed > central || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) fail('ZIP 資料越界 / 名稱不一致')
    if (!(flags & 8) && (u32(local + 14) !== u32(cursor + 16) || u32(local + 18) !== compressed || u32(local + 22) !== expanded)) fail('ZIP 大小標頭不一致')
    occupied.push([local, dataStart + compressed])
    const output = new Uint8Array(expanded)
    let written = 0
    const receive = (chunk: Uint8Array) => {
      if (written + chunk.length > expanded || written + chunk.length > L.entry) fail('實際展開大小超過限制')
      output.set(chunk, written); written += chunk.length
    }
    const input = bytes.subarray(dataStart, dataStart + compressed)
    if (method === 0) receive(input)
    else {
      const inflater = new Inflate(receive)
      for (let at = 0; at < input.length; at += 4096) inflater.push(input.subarray(at, at + 4096), at + 4096 >= input.length)
    }
    if (written !== expanded || crc32(output) !== u32(cursor + 16)) fail('ZIP 大小 / CRC 不一致')
    entries.set(name, output)
    if (/vbaProject|externalLinks|embeddings|activeX|customUI/i.test(name)) addFinding(findings, 'unsafe-package', '巨集、外部連結、嵌入物件或主動內容不支援', 'UNSUPPORTED')
    for (const [pattern, code, message] of [
      [/^xl\/charts\/[^/]+\.xml$/, 'charts', '圖表不會保留'],
      [/^xl\/pivot[^/]*\/[^/]+\.xml$/, 'pivots', '樞紐分析不會保留'],
      [/^xl\/tables\/[^/]+\.xml$/, 'tables', 'Excel 表格物件不會保留（一般儲存格保留）'],
      [/^xl\/media\//, 'images', '圖片不會保留'],
      [/^xl\/(?:comments|threadedComments)/, 'comments', '註解 / 執行緒註解不會保留'],
    ] as const) if (pattern.test(name)) addFinding(findings, code, message)
    if (/\.(xml|rels)$/i.test(name)) {
      const xml = decoder.decode(output)
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('DTD / 實體宣告不支援')
      const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name)
      if (worksheet && ++sheets > L.sheets) fail('工作表超過 32')
      let maxRow = 0, maxColumn = 0, rootElement = ''
      const parser = new SaxesParser({ xmlns: true })
      parser.on('error', (error) => fail(`XML 損毀 (${name})：${error.message}`))
      parser.on('opentag', (tag) => {
        if (!rootElement) rootElement = tag.local
        const attr = (key: string) => Object.values(tag.attributes).find((value) => value.local === key)?.value
        if (worksheet && tag.local === 'c') {
          if (++cells > L.cells) fail('有內容或格式的儲存格超過 250,000')
          const range = decodeRange(attr('r') ?? '')
          maxRow = Math.max(maxRow, range.endRow + 1); maxColumn = Math.max(maxColumn, range.endColumn + 1)
        }
        if (worksheet && tag.local === 'row') {
          const row = Number(attr('r'))
          if (!Number.isInteger(row) || row < 1 || row > 1_048_576) fail('無效資料列座標')
          maxRow = Math.max(maxRow, row)
        }
        if (worksheet && tag.local === 'col') {
          const min = Number(attr('min')), max = Number(attr('max'))
          if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 16384) fail('無效欄座標')
          maxColumn = Math.max(maxColumn, max)
        }
        if (worksheet && tag.local === 'mergeCell') {
          const range = decodeRange(attr('ref') ?? '')
          maxRow = Math.max(maxRow, range.endRow + 1); maxColumn = Math.max(maxColumn, range.endColumn + 1)
        }
        if (tag.local === 'Relationship' && (attr('TargetMode')?.toLowerCase() === 'external' || /^(?:[a-z]+:|\/\/)/i.test(attr('Target') ?? ''))) addFinding(findings, 'external', '外部關聯（含外部超連結）不支援', 'UNSUPPORTED')
        if (tag.local === 'Override' && /macroEnabled|vba|binary/i.test(attr('ContentType') ?? '')) addFinding(findings, 'macro', '巨集 / 二進位活頁簿不支援', 'UNSUPPORTED')
        const warningTags: Record<string, string> = {
          conditionalFormatting: '條件式格式不會保留', definedName: '命名範圍不會保留',
          sheetProtection: '工作表保護不會保留', workbookProtection: '活頁簿保護不會保留',
          dataValidation: '資料驗證不會保留', gradientFill: '漸層填色不會保留',
          pageSetup: '列印設定不會保留', headerFooter: '頁首頁尾不會保留',
          extLst: '延伸中繼資料不會保留', autoFilter: '篩選狀態不會保留',
          pane: '凍結 / 分割窗格不會保留', hyperlink: '超連結不會保留',
        }
        if (warningTags[tag.local]) addFinding(findings, tag.local, warningTags[tag.local])
        if (tag.local === 'color' && (attr('theme') || attr('indexed'))) addFinding(findings, 'theme', '佈景 / 索引色不保證一致，未映射的色彩不會保留')
      })
      parser.write(xml).close()
      if (worksheet && rootElement !== 'worksheet' || name === 'xl/workbook.xml' && rootElement !== 'workbook' || name.endsWith('.rels') && rootElement !== 'Relationships') fail('XML 必要根元素不正確')
      // ExcelJS uses sparse arrays. Extremely sparse coordinates are deliberately refused.
      if (maxRow > 250_000 || maxColumn > 1024 || maxRow * maxColumn > 1_000_000) fail('稀疏工作表範圍超過安全配置（250k 列 / 1024 欄 / 1m 範圍）')
    }
    progress(`檢查 ZIP / XML ${index + 1}/${count}`)
    cursor += 46 + nameLength + extra + comment
  }
  occupied.sort((a, b) => a[0] - b[0])
  if (occupied.some((range, i) => i && range[0] < occupied[i - 1][1])) fail('ZIP 項目重疊')
  if (cursor !== eocd || !entries.has('[Content_Types].xml') || !entries.has('_rels/.rels') || !entries.has('xl/workbook.xml') || !entries.has('xl/_rels/workbook.xml.rels') || !sheets) fail('缺少有效 XLSX 必要項目')
  assertAllowed({ sheets: [], cells, findings })
  return { findings, cells }
}
