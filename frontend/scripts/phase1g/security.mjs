// Node-only spike preflight. Production needs equivalent bounded worker controls.
import { inflateRawSync } from 'node:zlib'
import { LIMITS } from './adapters.mjs'

export const ZIP_LIMITS = Object.freeze({ entries: 2048, expanded: 64 * 1024 * 1024, entry: 16 * 1024 * 1024, ratio: 200 })

export function inspectXlsx(input) {
  const bytes = Buffer.from(input)
  const refuse = (reason) => { throw new Error(`XLSX refused: ${reason}`) }
  if (bytes.length > LIMITS.fileBytes) refuse('compressed file size limit')
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) refuse('ZIP signature')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0) refuse('missing ZIP directory')
  const count = bytes.readUInt16LE(end + 10)
  const size = bytes.readUInt32LE(end + 12)
  const start = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8)) refuse('multi-disk archive')
  if (count === 0xffff || start === 0xffffffff || size === 0xffffffff) refuse('ZIP64 unsupported')
  if (count > ZIP_LIMITS.entries || start + size !== end) refuse('directory bounds/count')
  const names = new Set()
  let offset = start
  let totalExpanded = 0
  let totalCompressed = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) refuse('malformed directory entry')
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressed = bytes.readUInt32LE(offset + 20)
    const expanded = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    if (offset + 46 + nameLength + extraLength + commentLength > end) refuse('entry bounds')
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (names.has(name) || name.includes('..') || name.startsWith('/') || /[\\:\u0000]/.test(name)) refuse('unsafe/duplicate path')
    if (/vbaProject|externalLinks/i.test(name)) refuse('macro/external link content')
    names.add(name)
    if (flags & 1 || ![0, 8].includes(method)) refuse('encrypted/unsupported compression')
    if (expanded > ZIP_LIMITS.entry || expanded / Math.max(1, compressed) > ZIP_LIMITS.ratio) refuse('entry expansion limit/ratio')
    totalExpanded += expanded
    totalCompressed += compressed
    if (totalExpanded > ZIP_LIMITS.expanded) refuse('total expansion limit')
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) refuse('local entry')
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) refuse('inconsistent local header')
    const localNameLength = bytes.readUInt16LE(local + 26)
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28)
    if (bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name || dataStart + compressed > start) refuse('local bounds/name')
    const data = bytes.subarray(dataStart, dataStart + compressed)
    let decoded
    try {
      decoded = method === 0 ? data : inflateRawSync(data, { maxOutputLength: ZIP_LIMITS.entry })
    } catch { refuse('bounded decompression failed') }
    if (decoded.length !== expanded) refuse('actual expansion differs from metadata')
    if (/\.xml$|\.rels$/i.test(name)) {
      const xml = decoded.toString('utf8')
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) refuse('DTD/entity content')
      if (/TargetMode\s*=\s*["']External["']/i.test(xml)) refuse('external relationship')
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
        const range = /<dimension\b[^>]*\bref="(?:[A-Z]+\d+:)?([A-Z]+)(\d+)"/.exec(xml)
        if (range) {
          let columns = 0
          for (const letter of range[1]) columns = columns * 26 + letter.charCodeAt(0) - 64
          if (Number(range[2]) * columns > LIMITS.cells) refuse('worksheet cell limit')
        }
      }
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (offset !== end) refuse('directory size mismatch')
  for (const required of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) if (!names.has(required)) refuse('missing OOXML workbook parts')
  return { entries: count, compressedBytes: bytes.length, totalCompressed, expandedBytes: totalExpanded }
}
