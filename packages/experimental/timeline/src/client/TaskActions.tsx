import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconChevronsUpDownOutlineRegular,
  IconListPenOutlineRegular,
  IconPauseOutlineRegular,
  IconPlayOutlineRegular,
  IconQueueOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { priorities } from '../records.ts'
import type { Annotation, Priority, Task, Tree } from '../records.ts'
import { CONTROL_WAIT_MS, latestControl, pendingControl } from '../controls.ts'
import { prioritiesOf } from '../tasks.ts'
import type { TaskRequest } from './actions.ts'

export interface PlaybackState {
  annotations: readonly Annotation[]
  trees: readonly Tree[]
  now: number
}

/** Express user intent without editing agent-owned progress optimistically. */
export function TaskActions({
  tree,
  task,
  status,
  playback,
  request,
  setPriority,
  annotate,
  annotationOpen = false,
  t,
  children,
}: {
  tree: Tree
  task?: Task | undefined
  status: Task['status']
  playback: PlaybackState
  request: (value: TaskRequest) => Promise<void>
  setPriority?: (value: Priority) => Promise<void>
  annotate?: () => void
  annotationOpen?: boolean
  children?: ReactNode
} & PropsLocale<'timeline'>): ReactNode {
  const sending = useRef(false)
  const [message, setMessage] = useState<'taskRequestFailed' | 'prioritySaveFailed' | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const updatedAt = task?.updatedAt ?? Math.max(tree.createdAt, ...tree.tasks.map(task => task.updatedAt))
  useEffect(() => {
    setMessage(null)
  }, [status, updatedAt])
  const wholePlan = task === undefined
  const parentPriority = task?.parent == null ? null : (prioritiesOf(tree.tasks).get(task.parent) ?? null)
  const priority = task?.priority ?? parentPriority
  const target =
    task === undefined
      ? { kind: 'tree' as const, tree: tree.id }
      : { kind: 'task' as const, tree: tree.id, task: task.id }
  const receipt =
    pendingControl(playback.annotations, target, playback.trees, playback.now) ??
    latestControl(playback.annotations, target)
  const control = receipt?.control
  const unconfirmed = control?.outcome === null
  const waiting = receipt !== undefined && unconfirmed && playback.now - receipt.createdAt < CONTROL_WAIT_MS
  const retry = unconfirmed || control?.outcome?.status === 'answered'
  const available =
    status !== 'done' && status !== 'retired' && tree.tasks.some(task => task.status !== 'retired')
  const perform = async (operation: () => Promise<void>, priority = false) => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setMessage(null)
    try {
      await operation()
    } catch {
      setMessage(priority ? 'prioritySaveFailed' : 'taskRequestFailed')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  const action = retry ? control.action : status === 'active' ? 'pause' : 'resume'
  const requesting = status !== 'done' && !waiting && !retry
  const text =
    status === 'done'
      ? t('taskCompleted')
      : waiting
        ? t(action === 'pause' ? 'pausePending' : 'resumePending')
        : retry
          ? t(action === 'pause' ? 'retryPause' : 'retryResume')
          : t(action === 'pause' ? 'pauseTask' : 'resumeTask')
  // The whole-tree button keeps short visible text; its accessible name also names the tree.
  const label = wholePlan && requesting ? t(action === 'pause' ? 'pausePlan' : 'resumePlan') : text
  const playbackButton = (
    <Button
      className={wholePlan ? 'timeline-playback' : 'timeline-task-action'}
      data-action={status === 'done' ? 'done' : action}
      data-pending={waiting}
      aria-label={label}
      disabled={busy || !available || waiting}
      onClick={() => {
        void perform(() => request({ action, tree, ...(task === undefined ? {} : { task }) }))
      }}
    >
      {status === 'done' ? (
        <IconCheckOutlineRegular size={18} />
      ) : action === 'pause' ? (
        <IconPauseOutlineRegular size={18} />
      ) : (
        <IconPlayOutlineRegular size={18} />
      )}
      <span>{text}</span>
    </Button>
  )
  const playbackControl = (
    <Tooltip
      label={
        busy
          ? t('sendingTaskRequest')
          : waiting
            ? `${label} · ${t(control.delivery === 'unknown' ? 'controlDeliveryUnknown' : 'controlWaitingHint')}`
            : retry
              ? `${label} · ${t('controlUnconfirmedHint')}`
              : `${label} · ${t('taskControlsHint')}`
      }
      side="top"
      portal
    >
      <span
        className="timeline-playback-anchor"
        tabIndex={waiting ? 0 : undefined}
        role={waiting ? 'group' : undefined}
        aria-label={waiting ? label : undefined}
      >
        {playbackButton}
      </span>
    </Tooltip>
  )
  return (
    <div className={wholePlan ? 'timeline-plan-controls' : 'timeline-task-controls'}>
      {wholePlan ? (
        <div
          className="timeline-overall"
          role={available ? 'group' : undefined}
          aria-label={available ? t('taskControls') : undefined}
          aria-busy={busy || waiting}
        >
          {available ? playbackControl : null}
          {children}
        </div>
      ) : (
        <div
          className="timeline-task-grid"
          role="group"
          aria-label={t('taskControls')}
          aria-busy={busy || waiting}
        >
          <Menu
            open={menu}
            onClose={() => { setMenu(false) }}
            side="top"
            portal
            compact
            autoFocus
            className="timeline-priority-menu"
            selectedId={task.priority ?? 'none'}
            anchor={
              <Button
                className="timeline-task-action timeline-priority-trigger"
                aria-label={`${t('priority')}: ${priority ?? t('noPriority')}`}
                title={t('priorityHint')}
                aria-haspopup="menu"
                aria-expanded={menu}
                disabled={busy || status === 'retired'}
                onClick={() => { setMenu(!menu) }}
              >
                <IconQueueOutlineRegular size={16} />
                <span className="timeline-priority-title">{t('priority')}:</span>
                <span className="timeline-priority-badge" data-priority={priority ?? 'none'}>
                  {priority ?? t('noPriority')}
                </span>
                <IconChevronsUpDownOutlineRegular size={12} />
              </Button>
            }
            items={[
              ...priorities.map(value => ({
                id: value,
                label: (
                  <span className="timeline-priority-option">
                    <span className="timeline-priority-badge" data-priority={value}>
                      {value}
                    </span>
                    {t(`priority${value}`)}
                  </span>
                ),
              })),
              {
                id: 'none',
                label:
                  parentPriority === null ? t('noPriority') : `${t('inheritedPriority')}: ${parentPriority}`,
              },
            ]}
            onSelect={(value) => {
              setMenu(false)
              const priority = priorities.find(item => item === value) ?? null
              if (priority !== task.priority && setPriority !== undefined)
                void perform(() => setPriority(priority), true)
            }}
          />
          {playbackControl}
          <Button
            className="timeline-task-action"
            aria-label={t('addAnnotation')}
            aria-pressed={annotationOpen}
            aria-expanded={annotationOpen}
            disabled={busy || status === 'retired'}
            onClick={annotate}
          >
            <IconListPenOutlineRegular size={18} />
            <span>{t('addAnnotation')}</span>
          </Button>
        </div>
      )}
      {message !== null ? (
        <small className="timeline-error" role="alert">
          {t(message)}
        </small>
      ) : null}
    </div>
  )
}
