import type { Context } from '@deepseek-ai/cordis'
import { IconBrowseOutline16, IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { webCardModel } from '../models/web-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type WebRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const WEB_TITLE_KEYS = {
  web_search: 'tool.title.webSearch',
  web_fetch: 'tool.title.webFetch',
} as const

/** Lets users expand a completed web search or fetch result. */
export function WebRow({ toolName, block, inspect, t }: WebRowProps) {
  const model = toolRowModel(toolName, block)
  const web = webCardModel(block)
  const icon = toolName === 'web_fetch' ? <IconBrowseOutline16 size={14} /> : <IconGlobeOutline14 size={14} />
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={icon}
      title={t(toolName === 'web_search'
        ? WEB_TITLE_KEYS.web_search
        : toolName === 'web_fetch' ? WEB_TITLE_KEYS.web_fetch : model.titleKey)}
      summary={model.summary}
      output={model.output}
      errorSummary={model.errorSummary}
      web={web}
      state={model.state}
      inspect={inspect}
    />
  )
}

/** Registers the web search and fetch conversation rows. */
export const webToolview = {
  name: 'web-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'web_search', locale: NS }, WebRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'web_fetch', locale: NS }, WebRow)
    })
  },
}
