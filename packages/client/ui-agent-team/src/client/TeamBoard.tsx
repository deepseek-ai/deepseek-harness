/** Shared tasks section of the Session panel: the task rows and the progress beside the section title. */
import { useMemo, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamProjection, TeamTaskView, TeamTaskId } from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  HoverCard, HoverCardGroup, IconChevronDownOutlineRegular,
  StateDot, Tooltip, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import type { createTeamBoardStore } from './team-board-store.ts'
import css from './TeamBoard.module.css'

/** Full props of the shared tasks section body. */
export type TeamBoardProps =
  PropsRuntime<'conversation.session.panel.section'>
  & PropsRenderFactories
  & PropsStore<ReturnType<typeof createTeamBoardStore>>
  & PropsLocale<typeof NS>

/** Tasks the list shows before its fold control holds the rest back. */
const FOLD_LIMIT = 5

type VisibleTask = TeamTaskView & { status: Exclude<TeamTaskView['status'], 'deleted'> }

const NO_TASKS: readonly VisibleTask[] = []

/** Full props of the progress beside the section title. */
export type TeamProgressProps =
  PropsRuntime<'conversation.session.panel.section.actions'> & PropsLocale<typeof NS>

const statusKeys = {
  pending: 'status.pending', in_progress: 'status.in_progress', completed: 'status.completed',
} satisfies Record<VisibleTask['status'], TeamKey>

const dotStates = {
  pending: 'idle', in_progress: 'ongoing', completed: 'done',
} satisfies Record<VisibleTask['status'], StateDotState>

function visibleTasks(team: TeamProjection): VisibleTask[] {
  return team.tasks.filter((task): task is VisibleTask => task.status !== 'deleted')
}

/**
 * Order the tasks for the list: the ones in progress, then the pending ones,
 * each in source order, then the completed ones with the latest in source
 * order first. A task carries no completion time, so source order stands in
 * for it.
 * @param tasks - the visible tasks in source order.
 * @returns the tasks in display order.
 */
function listOrder(tasks: readonly VisibleTask[]): VisibleTask[] {
  return [
    ...tasks.filter(task => task.status === 'in_progress'),
    ...tasks.filter(task => task.status === 'pending'),
    ...tasks.filter(task => task.status === 'completed').reverse(),
  ]
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

function TaskRow({ task, rootId, expanded, onToggle, renderFactorySlot, t }: Pick<TeamBoardProps, 'renderFactorySlot' | 't'> & {
  task: VisibleTask
  rootId: SessionId
  expanded: boolean
  onToggle: () => void
}) {
  const owner = task.ownerName ?? task.ownerId ?? t('unowned')
  const blocked = task.status === 'pending' && !task.ready
  const detailsId = `team-task-${rootId}-${task.id}`
  const state = blocked ? 'warning' : dotStates[task.status]
  const status = blocked ? t('blocked') : t(statusKeys[task.status])
  // An expanded row already shows its details, so its hover card stays closed.
  return (
    <li className={css.task} data-team-task={task.id} data-status={task.status} data-expanded={expanded}>
      <HoverCard
        grouped
        disabled={expanded}
        anchor={(
          <button
            type="button"
            className={css.taskRow}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={onToggle}
          >
            <span className={css.glyph} role="img" aria-label={status}>
              <StateDot state={state} />
            </span>
            <span className={css.subject}>{task.subject}</span>
            <span className={css.chevron} aria-hidden><IconChevronDownOutlineRegular size={14} /></span>
          </button>
        )}
        content={renderFactorySlot('conversation.session.panel.details', {
          title: task.subject,
          lines: [t('hover.owner', { name: owner }), ...task.description ? [task.description] : []],
          status: { state, label: status },
        })}
      />
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
 * Render read-only tasks: the ones in progress first, then the pending ones,
 * then the completed ones. The list shows five tasks and then a fold control
 * that shows the rest, once that holds back two tasks or more; the choice is
 * kept per Session. The Session panel owns the title and scrolling, and hides
 * the section while this renders nothing.
 * @param props - Session values, the `agentTeam` projection, the fold store, and copy.
 * @returns the task list with any board failure, or null with neither.
 */
export function TeamBoard({ sessionId, useProjection, useStore, actions, renderFactorySlot, t }: TeamBoardProps) {
  const team = useProjection('agentTeam')
  const unfolded = useStore(state => state.unfolded)
  const [expandedTaskId, setExpandedTaskId] = useState<TeamTaskId | null>(null)
  const ordered = useMemo(() => team?.enabled === true ? listOrder(visibleTasks(team)) : NO_TASKS, [team])
  if (!team?.enabled) return null
  if (ordered.length === 0 && team.failure === undefined) return null
  // Folding holds back two tasks or more, since the fold control takes a row itself.
  const foldable = ordered.length > FOLD_LIMIT + 1
  const tasks = foldable && !unfolded ? ordered.slice(0, FOLD_LIMIT) : ordered
  const label = unfolded ? t('list.less') : t('list.more', { count: ordered.length - FOLD_LIMIT })
  return (
    <div className={css.board} data-team-panel="">
      {team.failure !== undefined && (
        <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
      )}
      {tasks.length > 0 && (
        // Moving between rows swaps their hover cards without another dwell.
        <HoverCardGroup>
          <ul className={css.tasks}>
            {tasks.map(task => (
              <TaskRow
                key={task.id} task={task} rootId={sessionId}
                expanded={expandedTaskId === task.id}
                onToggle={() => { setExpandedTaskId(current => current === task.id ? null : task.id) }}
                renderFactorySlot={renderFactorySlot}
                t={t}
              />
            ))}
          </ul>
        </HoverCardGroup>
      )}
      {foldable && renderFactorySlot('conversation.session.panel.fold', {
        expanded: unfolded,
        label,
        name: t('list.foldName', { label }),
        onToggle: () => { actions.unfoldedSet(!unfolded) },
      })}
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
