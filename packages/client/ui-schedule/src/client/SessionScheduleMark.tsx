/**
 * Sidebar Session-row clock mark: one Session's active scheduled-task
 * indicator, seated in the row's leading 16px cell before the title.
 *
 * The row offers that cell to this seat only while its own primary state is
 * idle, so an approval request, a new message, or live activity keeps the
 * row's state dot in the same cell and never mounts the mark. The mark
 * projects the one shared Host task catalog onto this Session; it activates,
 * retains, and unarchives nothing, and it never reads a Session log.
 */

import {
  IconClockOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  useSessionScheduleFacts, type SessionScheduleCatalogObservable,
} from './session-schedule-state.ts'
import { NS } from './locales.ts'
import css from './SessionScheduleMark.module.css'

/** Injected share of the Session-row clock mark: the shared Host task catalog. */
export interface SessionScheduleMarkInjected {
  /** One catalog shared by every row; the renderer binds it to the `useCatalog` selector hook. */
  readonly hooks: { readonly catalog: SessionScheduleCatalogObservable }
}

/** Full props of the Session-row clock mark. */
export type SessionScheduleMarkProps =
  PropsRuntime<'sidebar.session.row.leading'> & PropsLocale<typeof NS> & InjectFace<SessionScheduleMarkInjected>

/**
 * Render the clock mark while this Session's active tasks are non-empty.
 * @param props.sessionId - Session this row shows.
 * @param props.useCatalog - selector hook over the shared Host task catalog.
 * @param props.t - Schedule catalog locale seat.
 * @returns the mark, or nothing while the read is unresolved, failed, ended, or empty.
 */
export function SessionScheduleMark({
  sessionId, useCatalog, t,
}: SessionScheduleMarkProps) {
  const facts = useSessionScheduleFacts(useCatalog, sessionId)
  if (!facts.hasActive) return null
  return (
    <span
      className={css.mark}
      data-session-schedule-mark=""
      // A press on the mark must not activate the Session through the row's
      // own click target; the row keeps every other cell as its activation area.
      onClick={(event) => { event.stopPropagation() }}
    >
      <IconClockOutlineRegular size={12} />
      {/* The glyph is aria-hidden, so the count reaches assistive technology
          only through this label, as the row's status dots do. */}
      <span className={css.visuallyHidden}>{t('mark.aria', { count: facts.records.length })}</span>
    </span>
  )
}
