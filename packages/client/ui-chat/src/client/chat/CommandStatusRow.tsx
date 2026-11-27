import { memo, useCallback, useMemo, useState } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { DisclosureRow, IconApiOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives/client'
import a11yCss from './accessibility.module.css'
import css from './CommandStatusRow.module.css'

type CommandRowState = 'running' | 'ok' | 'error'

const COMMAND_ICON = <IconApiOutlineRegular size={14} />

interface CommandStatusRowProps {
  title: string
  state: CommandRowState
  summary: string
  body: string | null
  t: ChatViewSlotProps['t']
}

/** Render a running or settled status with optional multiline details.
 * @param props - localized labels, status, and expandable content.
 * @returns the status row.
 */
export const CommandStatusRow = memo(function CommandStatusRow({ title, state, summary, body, t }: CommandStatusRowProps) {
  const [expanded, setExpanded] = useState(false)
  const running = state === 'running'
  const open = expanded && body !== null
  const toggle = useCallback(() => { setExpanded(value => !value) }, [])
  const collapsedContent = useMemo(() => (
    <>
      <span className={css.separator} data-shimmer-decoration aria-hidden />
      <span className={css.summary} data-error={state === 'error' || undefined}>
        <TextShimmer>{summary}</TextShimmer>
      </span>
    </>
  ), [state, summary])
  const content = useMemo(() => open
    ? <pre className={css.body} data-error={state === 'error' || undefined}>{body}</pre>
    : undefined, [body, open, state])
  return (
    <div className={css.root} data-variant="others" data-state={state}>
      {state === 'running' && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      {state === 'error' && <span className={a11yCss.visuallyHidden}>{t('row.failed')}</span>}
      <DisclosureRow
        leadingClassName={css.leading}
        titleClassName={css.title}
        icon={COMMAND_ICON}
        title={title}
        running={running}
        open={open}
        expandable={body !== null}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        collapsedContent={collapsedContent}
      >
        {content}
      </DisclosureRow>
    </div>
  )
})
