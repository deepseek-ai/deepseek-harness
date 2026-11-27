import type { Context } from '@deepseek-ai/cordis'
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { formatResultImage, toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type SourceCodeRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/** Shows a program call's source code and output; the program call's header row shows its description. */
export function SourceCodeRow({ toolName, block, inspect, useDisclosure, t }: SourceCodeRowProps) {
  const model = toolRowModel(toolName, block, undefined, undefined, image => formatResultImage(image, t))
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconCodeOutlineRegular size={14} />}
      title={t(model.titleKey)}
      summary=""
      bodyRaw={model.bodyRaw}
      output={model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      inspect={inspect}
    />
  )
}

/** Registers the source rows of the program tools. */
export const sourceCodeToolview = {
  name: 'source-code-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'run_code', locale: NS }, SourceCodeRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'cua_run_code', locale: NS }, SourceCodeRow)
    })
  },
}
