/** Read-only historical /team failures and fallback output. */
import { useState } from 'react'
import { DisclosureRow, IconUsersOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { NS } from './locales.ts'
import css from './TeamCommandRow.module.css'

/** Framework command data and the owning Team dictionary. */
export type TeamCommandRowProps = PropsRuntime<'conversation.chat.commandview'> & PropsLocale<typeof NS>

const TEAM_ICON = <IconUsersOutlineRegular size={14} />

function commandSummary(node: TeamCommandRowProps['node'], t: TeamCommandRowProps['t']): string {
  const outcome = node.outcome
  if (outcome === null) return t('command.running')
  switch (outcome.kind) {
    case 'success':
      return outcome.text || t('command.done')
    case 'error': {
      const reason = outcome.text?.trim().split(/\r?\n/u)[0]
      return reason ? t('command.failedReason', { reason }) : t('command.failed')
    }
    /* v8 ignore next -- CommandNode restricts outcomes to success or error. */
    default: return assertNever(outcome.kind)
  }
}

/**
 * Render the recorded Team command with the shared agent glyph and disclosure.
 * @param props - command record and localized Team text.
 * @returns an outcome row; recorded failures and multiline output remain expandable.
 */
export function TeamCommandRow({ node, t }: Pick<TeamCommandRowProps, 'node' | 't'>) {
  const [expanded, setExpanded] = useState(false)
  const running = node.outcome === null
  const failed = node.outcome?.kind === 'error'
  const summary = commandSummary(node, t)
  const body = node.outcome?.text
  const expandable = body !== undefined && body !== '' && (failed || body.includes('\n'))
  return (
    <div className={css.root} data-team-command data-state={running ? 'running' : failed ? 'error' : 'ok'} aria-busy={running || undefined}>
      <DisclosureRow
        icon={TEAM_ICON}
        title={t('command.title')}
        titleClassName={css.title}
        running={running}
        open={expanded && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} data-shimmer-decoration aria-hidden />
            <span className={css.summary} data-error={failed || undefined}><TextShimmer>{summary}</TextShimmer></span>
          </>
        )}
      >
        <pre className={css.body} data-error={failed || undefined}>{body}</pre>
      </DisclosureRow>
    </div>
  )
}
