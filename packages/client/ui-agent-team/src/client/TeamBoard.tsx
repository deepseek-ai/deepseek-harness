import { useLayoutEffect, useRef, useState } from 'react'
import type {
  TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconChevronDownOutlineRegular,
  StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamBoard.module.css'

/** Full props of the task board below the shared subagent catalog. */
export type TeamBoardProps =
  PropsRuntime<'conversation.session.header.actions.subagent.footer'> & PropsLocale<typeof NS>

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

function taskDotState(task: TeamTask): StateDotState {
  switch (task.status) {
    case 'pending': return task.ready ? 'idle' : 'warning'
    case 'in_progress': return 'ongoing'
    case 'completed': return 'done'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'idle'
  }
}

/** Task card with a two-line description clamp expanded from a toggle in the meta row. */
function TaskCard({ task, t }: {
  task: TeamTask
  t: TranslateNS<typeof NS>
}) {
  const owner = task.ownerId
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = textRef.current
    /* v8 ignore next -- the paragraph mounts in the same commit as the effect. */
    if (paragraph === null) return
    const measure = (): void => { setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [task.description, expanded])
  return (
    <article className={css.task}>
      <div className={css.taskTitle}>
        <strong>{task.subject}</strong>
        <span className={css.taskState}>
          <StateDot state={taskDotState(task)} />
          <span>{t(statusKey(task.status))}</span>
        </span>
      </div>
      <p ref={textRef} className={expanded ? undefined : css.clampedDescription}>{task.description}</p>
      <div className={css.meta}>
        {(clamped || expanded) && (
          <button
            type="button"
            className={css.expandToggle}
            aria-expanded={expanded}
            onClick={() => { setExpanded(current => !current) }}
          >
            {t(expanded ? 'task.collapse' : 'task.expand')}
            <IconChevronDownOutlineRegular size={12} className={expanded ? css.expandToggleOpen : undefined} />
          </button>
        )}
        <span>{task.id}</span>
        <span>{t('owner')}: {owner ?? t('unowned')}</span>
        {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
        {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
        {task.writeScopes.length > 0 && <span>{t('writeScopes')}: {task.writeScopes.join(', ')}</span>}
      </div>
    </article>
  )
}

/** Render the root conversation's read-only task board from its current projection. */
export function TeamBoard({
  useProjection, t,
}: TeamBoardProps) {
  const team = useProjection('agentTeam')
  if (!team?.enabled) return null
  return (
    <section className={css.board} aria-label={t('trigger')} data-team-panel>
      <h3>{t('tasks')}<span className={css.count}>{team.tasks.length}</span></h3>
      {team.failure !== undefined && (
        <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
      )}
      {team.tasks.length === 0
        ? <p className={css.emptyNotice}>{t('empty')}</p>
        : (
          <div className={css.tasks}>
            {team.tasks.map(task => (
              <TaskCard key={task.id} task={task} t={t} />
            ))}
          </div>
        )}
    </section>
  )
}
