/**
 * Session row icons after the time label: a branch glyph while the Session
 * works in the worktree the panel created for it, and the state glyph of its
 * most urgent change request. Glyphs of open change requests stay in the
 * row's subdued color with a dot for their checks; merged and closed ones keep
 * their state color.
 */

import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-workspace SlotMap merge (the Session row seats).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ChecksRollup } from '@deepseek-ai/dsh-experimental-forge/types'
import { ChangeRequestGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import { useSessionForgeFacts, type SessionListChangeRequest, type SessionListInjected } from './session-list.ts'
import { TONE_LABEL } from './status.ts'
import css from './SessionList.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Copy of each checks outcome a row and its hover card name. */
export const CHECKS_LABEL: Record<Exclude<ChecksRollup, 'none'>, ForgePanelKey> = {
  pending: 'change.ci.running',
  success: 'change.ci.passed',
  failure: 'change.ci.failedUnlisted',
}

/**
 * The checks outcome a row shows for a change request: none for a merged,
 * closed, or not yet polled one.
 * @param entry - the change request.
 * @returns the outcome.
 */
export function rowChecks(entry: SessionListChangeRequest): ChecksRollup {
  if (entry.state === undefined || entry.tone === 'merged' || entry.tone === 'closed') return 'none'
  return entry.state.checksRollup
}

/**
 * Name a change request's state and checks, as one line.
 * @param entry - the change request.
 * @param t - forge panel copy.
 * @returns the line.
 */
export function stateLine(entry: SessionListChangeRequest, t: Translate): string {
  const state = t(TONE_LABEL[entry.tone])
  const checks = rowChecks(entry)
  return checks === 'none' ? state : t('list.stateChecks', { state, checks: t(CHECKS_LABEL[checks]) })
}

/** Full props of the row icons. */
export type SessionRowForgeProps =
  PropsRuntime<'sidebar.session.row.trailing'> & PropsLocale<typeof NS> & InjectFace<SessionListInjected>

/**
 * Render a Session row's forge icons.
 * @param props - the row's Session, the shared hooks, and copy.
 * @returns the icons, or nothing for a Session without a worktree or change requests.
 */
export function SessionRowForge({ sessionId, useSessions, useStates, t }: SessionRowForgeProps): ReactNode {
  const facts = useSessionForgeFacts(useSessions, useStates, sessionId)
  const top = facts.changeRequests[0]
  return (
    <>
      {facts.worktree !== null && (
        <span className={css.icon} role="img" aria-label={t('list.worktree')} data-forge-row-worktree="">
          <IconBranchOutlineRegular size={13} />
        </span>
      )}
      {top !== undefined && (
        <span
          className={css.icon}
          role="img"
          aria-label={t('change.stateAria', { state: stateLine(top, t) })}
          data-forge-row-change={top.tone}
        >
          <ChangeRequestGlyph tone={top.tone} tinted={top.tone === 'merged' || top.tone === 'closed'} size={14} />
          {rowChecks(top) !== 'none' && <span className={css.dot} data-checks={rowChecks(top)} />}
        </span>
      )}
    </>
  )
}
