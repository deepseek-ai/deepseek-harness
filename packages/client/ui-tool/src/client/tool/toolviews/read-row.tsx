import type { ToolFileInjected } from '../file-menu.ts'
import { toolFileInject } from '../file-menu.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { readCallLine, readCardModel } from '../models/read-card-model.ts'
import { readFamilyRow } from './read-family-row.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type ReadRowProps = ToolCallViewProps & ToolFileInjected & PropsLocale<'conversation'>

/**
 * Lets users expand a completed read result and open its reported path at the
 * line the call started from.
 */
export function ReadRow(props: ReadRowProps) {
  const { block, cwd, home } = props
  const { getTriggerProps } = props.useContextMenu()
  return readFamilyRow(props, {
    read: readCardModel(block, cwd, home),
    filePathLine: readCallLine(block),
  }, getTriggerProps)
}

/** Registers the read tool's conversation row. */
export const readToolview = {
  name: 'read-toolview',
  inject: ['slots', 'sessions'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'read', locale: NS, inject: toolFileInject(ctx) }, ReadRow))
  },
}
