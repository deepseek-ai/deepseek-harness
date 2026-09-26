/**
 * Scheduled-task section of the Sidebar Session-row hover card.
 *
 * The row's own card already carries the Session title, its relative time, and
 * the trailing status line; this seat contributes the Session's active tasks
 * between them. It is mounted only while the card is open, and it projects the
 * one shared Host task catalog onto the hovered Session.
 */

import { useState } from 'react'
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { formatScheduleFrequency, nextRunParts, orderScheduleRecords, taskName } from './schedule-format.ts'
import {
  useSessionScheduleFacts, type SessionScheduleCatalogObservable,
} from './session-schedule-state.ts'
import { NS } from './locales.ts'
import css from './SessionScheduleMark.module.css'

/** Most task rows one hover card shows before it reports the omitted remainder. */
export const SESSION_HOVER_TASK_LIMIT = 2

/** Injected share of the Session-row hover-card task section: the shared Host task catalog. */
export interface SessionScheduleHoverInjected {
  /** One catalog shared by every row; the renderer binds it to the `useCatalog` selector hook. */
  readonly hooks: { readonly catalog: SessionScheduleCatalogObservable }
}

/** Full props of the Session-row hover-card task section. */
export type SessionScheduleHoverProps =
  PropsRuntime<'sidebar.session.row.hover'> & PropsLocale<typeof NS> & InjectFace<SessionScheduleHoverInjected>

/**
 * Render up to {@link SESSION_HOVER_TASK_LIMIT} overdue-first task rows.
 *
 * The reference clock is sampled once per mount: the card is a long-hover
 * preview, so its "next run" text must not drift while the pointer rests.
 * @param props.sessionId - Session this row shows.
 * @param props.useCatalog - selector hook over the shared Host task catalog.
 * @param props.t - Schedule catalog locale seat.
 * @returns the task rows plus an omission line, or nothing without an active task.
 */
export function SessionScheduleHover({
  sessionId, useCatalog, t,
}: SessionScheduleHoverProps) {
  const facts = useSessionScheduleFacts(useCatalog, sessionId)
  const [now] = useState(() => Date.now())
  if (!facts.hasActive) return null
  const ordered = orderScheduleRecords(facts.records, now)
  const shown = ordered.slice(0, SESSION_HOVER_TASK_LIMIT)
  const omitted = ordered.length - shown.length
  return (
    <div className={css.tasks} data-session-schedule-tasks="">
      {shown.map((record) => {
        const nextRun = nextRunParts(record.scheduledAt, t('time.locale'), now, t)
        return (
          <div className={css.task} key={record.id} data-session-schedule-task="">
            <span className={css.taskIcon} aria-hidden="true"><IconClockOutlineRegular size={12} /></span>
            <span className={css.taskBody}>
              <span className={css.taskName}>{taskName(record)}</span>
              {/* The same next-run shape the list rows, the detail, and the chat
                  card show: the device-zone stamp first, then the distance. */}
              <span className={css.taskTiming}>
                {`${formatScheduleFrequency(record, t)} · `}
                <time dateTime={record.scheduledAt}>{nextRun.absolute}</time>
                {' '}
                <span className={css.taskRelative}>{nextRun.relative}</span>
              </span>
            </span>
          </div>
        )
      })}
      {omitted > 0 && <div className={css.omitted}>{t('hover.more', { count: omitted })}</div>}
    </div>
  )
}
