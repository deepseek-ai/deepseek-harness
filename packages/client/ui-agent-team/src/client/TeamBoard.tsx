/** Shared tasks section of the Session panel: the task rows and the progress beside the section title. */
import { useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamProjection, TeamTaskView, TeamTaskId } from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconChevronDownOutlineRegular,
  StateDot, Tooltip, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamBoard.module.css'

/** Full props of the shared tasks section body. */
export type TeamBoardProps =
  PropsRuntime<'conversation.session.panel.section'> & PropsLocale<typeof NS>

/** Full props of the progress beside the section title. */
export type TeamProgressProps =
  PropsRuntime<'conversation.session.panel.section.actions'> & PropsLocale<typeof NS>

type VisibleTask = TeamTaskView & { status: Exclude<TeamTaskView['status'], 'deleted'> }

const statusKeys = {
  pending: 'status.pending', in_progress: 'status.in_progress', completed: 'status.completed',
} satisfies Record<VisibleTask['status'], TeamKey>

const dotStates = {
  pending: 'idle', in_progress: 'ongoing', completed: 'done',
} satisfies Record<VisibleTask['status'], StateDotState>

function visibleTasks(team: TeamProjection): VisibleTask[] {
  return team.tasks.filter((task): task is VisibleTask => task.status !== 'deleted')
}

function progressLabel(tasks: readonly VisibleTask[], t: TeamBoardProps['t']): string {
  const completed = tasks.filter(task => task.status === 'completed').length
  const active = tasks.filter(task => task.status === 'in_progress').length
  const pending = tasks.length - completed - active
  return [
    ...completed > 0 ? [t('progress.completed', { count: completed })] : [],
    ...active > 0 ? [t('progress.active', { count: active })] : [],
    ...pending > 0 ? [t('progress.pending', { count: pending })] : [],
  ].join('\u2002·\u2002')
}

function TaskRow({ task, rootId, expanded, onToggle, t }: Pick<TeamBoardProps, 't'> & {
  task: VisibleTask
  rootId: SessionId
  expanded: boolean
  onToggle: () => void
}) {
  const owner = task.ownerName ?? task.ownerId ?? t('unowned')
  const blocked = task.status === 'pending' && !task.ready
  const detailsId = `team-task-${rootId}-${task.id}`
  return (
    <li className={css.task} data-team-task={task.id} data-status={task.status} data-expanded={expanded}>
      <Tooltip label={task.subject} onlyWhenClipped disabled={expanded} delayMs={500} portal side="top">
        <button
          type="button"
          className={css.taskRow}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span className={css.glyph} role="img" aria-label={blocked ? t('blocked') : t(statusKeys[task.status])}>
            <StateDot state={blocked ? 'warning' : dotStates[task.status]} />
          </span>
          <span className={css.subject}>{task.subject}</span>
          <span className={css.chevron} aria-hidden><IconChevronDownOutlineRegular size={14} /></span>
        </button>
      </Tooltip>
      {expanded && (
        <div className={css.details} id={detailsId} data-team-task-details>
          {task.description && <p className={css.description}>{task.description}</p>}
          <p className={css.owner} data-team-task-owner>
            <span className={css.ownerLabel}>{t('owner')}: </span>
            <Tooltip label={owner} onlyWhenClipped delayMs={500} portal side="top">
              <span className={css.ownerValue}>{owner}</span>
            </Tooltip>
          </p>
        </div>
      )}
    </li>
  )
}

/**
 * Render read-only tasks in source order; the Session panel owns the title and
 * scrolling, and hides the section while this renders nothing.
 * @param props - Session values, the `agentTeam` projection, and copy.
 * @returns the task list with any board failure, or null with neither.
 */
export function TeamBoard({ sessionId, useProjection, t }: TeamBoardProps) {
  const team = useProjection('agentTeam')
  const [expandedTaskId, setExpandedTaskId] = useState<TeamTaskId | null>(null)
  if (!team?.enabled) return null
  const tasks = visibleTasks(team)
  if (tasks.length === 0 && team.failure === undefined) return null
  return (
    <div className={css.board} data-team-panel="">
      {team.failure !== undefined && (
        <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
      )}
      {tasks.length > 0 && (
        <ul className={css.tasks}>
          {tasks.map(task => (
            <TaskRow
              key={task.id} task={task} rootId={sessionId}
              expanded={expandedTaskId === task.id}
              onToggle={() => { setExpandedTaskId(current => current === task.id ? null : task.id) }}
              t={t}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Render the tasks' progress beside the section title, one line that clips.
 * @param props - the `agentTeam` projection and copy.
 * @returns the progress phrase, or null without visible tasks.
 */
export function TeamProgress({ useProjection, t }: TeamProgressProps) {
  const team = useProjection('agentTeam')
  if (!team?.enabled) return null
  const progress = progressLabel(visibleTasks(team), t)
  if (progress === '') return null
  return <span className={css.progress}>{progress}</span>
}
