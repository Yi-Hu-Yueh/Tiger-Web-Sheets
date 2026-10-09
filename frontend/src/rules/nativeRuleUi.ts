import type { FUniver } from '@univerjs/core/facade'
import { CellValueType, DataValidationType, type IRange, type ICellData, type CommandType } from '@univerjs/core'
import { SetNumfmtCommand } from '@univerjs/sheets-numfmt'
import { isPersistedWorkbookMutation } from '../persistence/workbookMutation'

// Exact registered operations in the Apache-2.0 Univer 1.0.3 UI bundles.
// These open the native editors, not a Tiger validation/rendering engine.
export const RULE_PANEL_OPERATIONS = {
  validation: 'data-validation.operation.open-validation-panel',
  conditional: 'sheet.operation.open.conditional.formatting.panel',
} as const

export function createRuleMutationTracker(api: FUniver) {
  // 1.0.3 DropdownManager submits this single-cell payload even for the same
  // choice. Ignore only that exact semantic no-op in Tiger's dirty tracking.
  // Keep commands running normally, including the native dropdown close/undo path.
  // Never suppress formula/rich-text replacement, paste, formatting or rule edits.
  const skipped = new WeakSet<object>()
  const pending = new Map<object, { unitId: string; subUnitId: string; row: number; col: number; value: string }>()
  const listener = api.addEvent(api.Event.BeforeCommandExecute, (event) => {
    if (event.id === 'sheet.mutation.set-range-values' && event.params && typeof event.params === 'object') {
      const params = event.params as { unitId?: string; subUnitId?: string; trigger?: string; cellValue?: Record<number, Record<number, ICellData>> }
      if (params.trigger !== 'sheet.command.set-range-values' || !params.cellValue) return
      const rows = Object.entries(params.cellValue)
      if (rows.length !== 1) return
      const columns = Object.entries(rows[0][1])
      if (columns.length !== 1) return
      const incoming = columns[0][1]
      if (!incoming || incoming.f || incoming.p || incoming.si || incoming.t != null && incoming.t !== CellValueType.STRING) return
      for (const item of pending.values()) if (item.unitId === params.unitId && item.subUnitId === params.subUnitId
        && item.row === Number(rows[0][0]) && item.col === Number(columns[0][0]) && incoming.v === item.value) {
        const data = api.getActiveWorkbook()?.getSheetBySheetId(item.subUnitId)?.getRange(item.row, item.col, 1, 1).getCellData()
        if (data?.v === item.value && !data.f && !data.p && !data.si
          && (!('s' in incoming) || JSON.stringify(incoming.s ?? null) === JSON.stringify(data.s ?? null))) skipped.add(event.params)
      }
      return
    }
    if (event.id !== 'sheet.command.set-range-values' || !event.params || typeof event.params !== 'object') return
    const params = event.params as { unitId?: string; subUnitId?: string; range?: IRange; value?: Record<string, unknown> }
    const { range, value } = params
    if (!range || !value || typeof value.v !== 'string' || value.p !== null || value.f !== null || value.si !== null
      || Object.keys(value).some((key) => !['v', 'p', 'f', 'si'].includes(key))
      || range.startRow !== range.endRow || range.startColumn !== range.endColumn
      || !Number.isInteger(range.startRow) || !Number.isInteger(range.startColumn)) return
    const workbook = api.getActiveWorkbook()
    if (!workbook || params.unitId !== workbook.getId() || !params.subUnitId) return
    const sheet = workbook.getSheetBySheetId(params.subUnitId)
    if (!sheet || range.startRow < 0 || range.startColumn < 0 || range.startRow >= sheet.getMaxRows() || range.startColumn >= sheet.getMaxColumns()) return
    const cell = sheet.getRange(range.startRow, range.startColumn, 1, 1)
    if (cell.getDataValidation()?.getCriteriaType() !== DataValidationType.LIST) return
    const data = cell.getCellData()
    if (data?.v === value.v && !data.f && !data.p && !data.si && (data.t == null || data.t === CellValueType.STRING)) {
      skipped.add(event.params)
      // Only transient single-cell metadata; failed native commands cannot grow it unbounded.
      if (pending.size >= 32) pending.delete(pending.keys().next().value!)
      pending.set(event.params, { unitId: workbook.getId(), subUnitId: sheet.getSheetId(), row: range.startRow, col: range.startColumn, value: value.v })
    }
  })
  return { dispose() { listener.dispose(); pending.clear() }, isPersistent(event: { id: string; type: CommandType; params?: unknown }) {
    if (event.params && typeof event.params === 'object') {
      pending.delete(event.params)
      if (skipped.has(event.params)) return false
    }
    return isPersistedWorkbookMutation(event)
  } }
}

function selectedRange(api: FUniver) {
  const sheet = api.getActiveWorkbook()?.getActiveSheet()
  const range = sheet?.getActiveRange()
  if (!sheet || !range) throw new Error('請先選取要設定規則的儲存格範圍。')
  const bounds = range.getRange()
  if (![bounds.startRow, bounds.endRow, bounds.startColumn, bounds.endColumn].every(Number.isInteger)
    || bounds.startRow < 0 || bounds.startColumn < 0 || bounds.endRow < bounds.startRow
    || bounds.endColumn < bounds.startColumn || bounds.endRow >= sheet.getMaxRows()
    || bounds.endColumn >= sheet.getMaxColumns()) throw new Error('所選範圍無效或超出工作表。')
  return range
}

export async function openNativeRulePanel(api: FUniver, kind: keyof typeof RULE_PANEL_OPERATIONS) {
  selectedRange(api)
  const ok = await api.executeCommand(RULE_PANEL_OPERATIONS[kind], kind === 'validation' ? {} : { value: 2 })
  if (!ok) throw new Error('Univer 無法開啟規則面板，請重新選取範圍後再試。')
}

export async function formatSelectedCodeAsText(api: FUniver) {
  const range = selectedRange(api)
  // Native number-format command: protects FUTURE keyboard entry, not a lossy
  // conversion of existing values. Text-length validation alone is not a type.
  const bounds = range.getRange()
  if ((bounds.endRow - bounds.startRow + 1) * (bounds.endColumn - bounds.startColumn + 1) > 50_000) throw new Error('請一次選取不超過 50,000 個代碼儲存格。')
  const values = []
  for (let row = bounds.startRow; row <= bounds.endRow; row++) for (let col = bounds.startColumn; col <= bounds.endColumn; col++) values.push({ row, col, pattern: '@' })
  const workbook = api.getActiveWorkbook()!
  const ok = await api.executeCommand(SetNumfmtCommand.id, { unitId: workbook.getId(), subUnitId: workbook.getActiveSheet().getSheetId(), values })
  if (!ok) throw new Error('Univer 拒絕設定文字格式；請確認範圍可編輯。')
}
