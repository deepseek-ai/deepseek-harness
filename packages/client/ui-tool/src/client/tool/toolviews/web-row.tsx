import type { Context } from '@deepseek-ai/cordis'
import { IconBrowseOutlineRegular, IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { webCardModel, webFetchHref } from '../models/web-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type WebRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const WEB_TITLE_KEYS = {
  web_search: 'tool.title.webSearch',
  web_fetch: 'tool.title.webFetch',
} as const

/** Collapsed-row summaries for the transport failure codes of `dsh-web-fetch-http` (`src/transport-failure.ts`). */
const WEB_FETCH_FAILURE_KEYS = {
  WEB_FETCH_DNS_FAILED: 'tool.webFetch.failure.dns',
  WEB_FETCH_CONNECTION_REFUSED: 'tool.webFetch.failure.refused',
  WEB_FETCH_CONNECTION_TIMEOUT: 'tool.webFetch.failure.connectionTimeout',
  WEB_FETCH_CERTIFICATE_INVALID: 'tool.webFetch.failure.certificate',
  WEB_FETCH_CONNECTION_INTERRUPTED: 'tool.webFetch.failure.interrupted',
  WEB_FETCH_NETWORK_UNREACHABLE: 'tool.webFetch.failure.unreachable',
  WEB_FETCH_NETWORK_ERROR: 'tool.webFetch.failure.network',
} as const

/** Whether a recorded error code is a web_fetch transport failure code. */
function isFetchFailureCode(code: string): code is keyof typeof WEB_FETCH_FAILURE_KEYS {
  return Object.hasOwn(WEB_FETCH_FAILURE_KEYS, code)
}

/** Lets users expand a completed web search or fetch result. */
export function WebRow({ toolName, block, useContextMenu, sessionId, inspect, useDisclosure, t }: WebRowProps) {
  const { getTriggerProps } = useContextMenu()
  const href = webFetchHref(block)
  const model = toolRowModel(toolName, block)
  const web = webCardModel(block)
  // A classified transport failure leads with its localized summary; the expanded output keeps the code and detail.
  const code = 'kind' in block ? block.error?.code : undefined
  const failureKey = model.state === 'error' && toolName === 'web_fetch' && code !== undefined && isFetchFailureCode(code)
    ? WEB_FETCH_FAILURE_KEYS[code]
    : undefined
  const icon = toolName === 'web_fetch' ? <IconBrowseOutlineRegular size={14} /> : <IconGlobeOutlineRegular size={14} />
  return (
    <ToolRow
      urlContextMenuProps={getTriggerProps(href === undefined ? undefined : { kind: 'url', value: { sessionId, url: href } })}
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={icon}
      title={t(toolName === 'web_search'
        ? WEB_TITLE_KEYS.web_search
        : toolName === 'web_fetch' ? WEB_TITLE_KEYS.web_fetch : model.titleKey)}
      summary={model.summary}
      output={model.output}
      errorSummary={failureKey === undefined ? model.errorSummary : t(failureKey)}
      web={web}
      href={href}
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
