/**
 * The forge section of a Session row's hover card: the worktree branch while
 * the Session works in the worktree the panel created for it, and its change
 * requests, most urgent first.
 */

import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-workspace SlotMap merge (the Session row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ChangeRequestGlyph } from './glyphs.tsx'
import type { NS } from './locales.ts'
import { useSessionForgeFacts, type SessionListInjected } from './session-list.ts'
import { CHECKS_LABEL, rowChecks, stateLine } from './SessionRowForge.tsx'
import { TONE_LABEL } from './status.ts'
import css from './SessionList.module.css'

/** Change requests the hover card lists before naming how many more there are. */
export const HOVER_CHANGE_REQUEST_LIMIT = 3

/** Full props of the hover section. */
export type SessionHoverForgeProps =
  PropsRuntime<'sidebar.session.row.hover'> & PropsLocale<typeof NS> & InjectFace<SessionListInjected>

/**
 * Render the forge section of a Session's hover card.
 * @param props - the row's Session, the shared hooks, and copy.
 * @returns the section, or null for a Session without a worktree or change requests.
 */
export function SessionHoverForge({ sessionId, useSessions, useStates, t }: SessionHoverForgeProps): ReactNode {
  const facts = useSessionForgeFacts(useSessions, useStates, sessionId)
  if (facts.worktree === null && facts.changeRequests.length === 0) return null
  const shown = facts.changeRequests.slice(0, HOVER_CHANGE_REQUEST_LIMIT)
  const omitted = facts.changeRequests.length - shown.length
  const worktree = facts.worktree
  return (
    <div className={css.hover} data-forge-session-hover="">
      {worktree !== null && (
        <div className={css.hoverItem}>
          <span className={css.hoverIcon} aria-hidden="true"><IconBranchOutlineRegular size={12} /></span>
          <span className={css.hoverBody}>
            <span className={css.hoverBranch}>{worktree.branch}</span>
            <span className={css.hoverNote}>{t('checkout.worktreeFrom', { base: worktree.from ?? worktree.baseCommit.slice(0, 7) })}</span>
          </span>
        </div>
      )}
      {shown.map((entry) => {
        const checks = rowChecks(entry)
        return (
          <div className={css.hoverItem} key={entry.url} data-forge-session-hover-change={entry.tone}>
            <span className={css.hoverIcon} data-tone={entry.tone} aria-hidden="true">
              <ChangeRequestGlyph tone={entry.tone} tinted={false} size={12} />
            </span>
            <span className={css.hoverBody}>
              <span className={css.hoverTitle}>{entry.state === undefined ? entry.url : `#${entry.state.number} ${entry.state.title}`}</span>
              <span className={css.hoverNote}>
                <span aria-hidden="true">
                  {t(TONE_LABEL[entry.tone])}
                  {checks !== 'none' && <span className={css.hoverSeparator}>·</span>}
                  {checks !== 'none' && <span data-checks={checks}>{t(CHECKS_LABEL[checks])}</span>}
                </span>
                <span className={css.visuallyHidden}>{stateLine(entry, t)}</span>
              </span>
            </span>
          </div>
        )
      })}
      {omitted > 0 && <div className={css.hoverMore}>{t('list.more', { count: omitted })}</div>}
    </div>
  )
}
