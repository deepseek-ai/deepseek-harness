import type { Context } from '@deepseek-ai/cordis'
import { IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { diffCardModel } from '../models/diff-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type FileMutationRowProps = ToolCallViewProps & PropsLocale<'conversation'>
const FILE_MUTATION_ICON = <IconEditOutlineRegular size={14} />

const CONTENT_FIELDS = ['content', 'old_string', 'new_string']
const KILOBYTE = 1024

/** Kilobytes of decoded input at every stage; null before any content field arrives. */
function contentKilobytes(block: FileMutationRowProps['block']): number | null {
  const { args } = block
  const open = CONTENT_FIELDS.find(key => args.has(key) && !args.complete(key))
  const completed = CONTENT_FIELDS.reduce((total, key) => key !== open && args.complete(key)
    ? total + (args.stringLength(key, { step: KILOBYTE }) ?? 0) : total, 0)
  if (open === undefined) {
    return CONTENT_FIELDS.some(key => args.has(key)) ? Math.ceil(completed / KILOBYTE) : null
  }
  const chars = completed + (args.stringLength(open, { step: KILOBYTE, offset: completed }) ?? 0)
  return Math.ceil(chars / KILOBYTE)
}

/**
 * Shows the path and decoded input size through preparation, execution, and
 * settlement, with the applied diff available once the call settles.
 */
export function FileMutationRow({ toolName, block, cwd, home, openFile, inspect, useDisclosure, t }: FileMutationRowProps) {
  const model = toolRowModel(toolName, block, cwd, home)
  const diff = diffCardModel(block)
  const kilobytes = contentKilobytes(block)
  const size = kilobytes === null ? null : t('tool.preparing.content', { kilobytes })
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={FILE_MUTATION_ICON}
      title={t(model.titleKey)}
      summary={model.summary}
      summarySuffix={size !== null && model.summary !== '' ? size : undefined}
      output={model.output}
      errorSummary={model.errorSummary}
      diff={diff}
      state={model.state}
      filePath={model.filePath}
      onOpenFile={openFile}
      inspect={inspect}
    />
  )
}

/** Registers the edit and write conversation rows. */
export const fileMutationToolview = {
  name: 'file-mutation-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'edit', locale: NS }, FileMutationRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write', locale: NS }, FileMutationRow)
    })
  },
}
