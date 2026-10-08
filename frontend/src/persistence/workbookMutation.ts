import { CommandType } from '@univerjs/core'

const NON_PERSISTENT_MUTATIONS = new Set(['doc.mutation.rich-text-editing'])
const PERSISTED_COMMANDS = new Set(['sheet.command.replace', 'sheet.command.set-range-values'])
export function isPersistedWorkbookMutation(event: { id: string; type: CommandType; params?: unknown }): boolean {
  if (event.type === CommandType.COMMAND && PERSISTED_COMMANDS.has(event.id)) return true
  if (event.type !== CommandType.MUTATION || NON_PERSISTENT_MUTATIONS.has(event.id) || event.id.startsWith('formula.mutation.')) return false
  if (event.id === 'sheet.mutation.set-range-values') return typeof event.params === 'object' && event.params !== null && 'trigger' in event.params
  return true
}
