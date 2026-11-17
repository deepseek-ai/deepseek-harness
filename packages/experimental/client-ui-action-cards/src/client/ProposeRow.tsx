/** One-line process row for a `propose_action` call: the card title and whether the card was shown. */
import { useState } from 'react'
import { DisclosureRow, IconAppsAddOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ProposeRow.module.css'

type ProposeRowProps = ToolCallViewProps & PropsLocale<'actionCards'>

/** Call states with row copy; a preparing call has no complete arguments yet. */
type RowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

function stateOf(props: ProposeRowProps): RowState {
  if (props.phase === 'preparing') return 'preparing'
  if (props.phase === 'start') return 'running'
  if (props.block.error?.code === 'interrupted') return 'stopped'
  return props.block.isError ? 'error' : 'ok'
}

/**
 * Render a `propose_action` call from its recorded arguments and result. Only a refused call expands, to show
 * why no card followed the answer.
 * @param props - tool call and localized status copy.
 * @returns the status row.
 */
export function ProposeRow(props: ProposeRowProps) {
  const { block, inspect, t } = props
  const [expanded, setExpanded] = useState(false)
  const state = stateOf(props)
  const title = block.args.text('title') ?? ''
  const reason = props.phase === 'result' && props.block.isError
    ? props.block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
    : ''
  return <div data-tool="propose_action" data-state={state}>
    <DisclosureRow title={t('row.title')} icon={<IconAppsAddOutlineRegular size={14} />} running={state === 'preparing' || state === 'running'}
      open={expanded && reason !== ''} expandable={reason !== ''} expandOnRowClick keepContentWhenOpen
      onToggle={() => { setExpanded(value => !value) }}
      collapsedContent={<span className={css.summary}><span>{t(`row.${state}`)}</span><span className={css.title}>{title}</span></span>}>
      <pre className={css.reason}>{reason}</pre>
      {inspect && <button type="button" className={css.inspect} onClick={inspect}>{t('row.inspect')}</button>}
    </DisclosureRow>
  </div>
}
