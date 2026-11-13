import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconEllipsisOutlineRegular,
  IconDownloadOutlineRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  IconQuestionOutlineRegular,
  Menu,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Task, Tree, TimelineView } from '../records.ts'
import { measureAll, prioritiesOf } from '../tasks.ts'
import type { ViewState } from './store.ts'
import { Progress, formatProgress } from './Progress.tsx'
import { MINUTE_MS } from '../policy.ts'
import type { ProgressPrecision } from '../policy.ts'
import { formatDuration } from '../periods.ts'
import { statusTones } from './status.ts'
import { TaskActions } from './TaskActions.tsx'
import type { PlaybackState } from './TaskActions.tsx'
import type { TaskRequest } from './actions.ts'
import { TreeTransfer, exportTree } from './TreeTransfer.tsx'
import type { TreeTransferActions } from './TreeTransfer.tsx'

interface TaskTreeProps extends PropsLocale<'timeline'>, TreeTransferActions {
  sessionId: string
  view: TimelineView
  state: ViewState
  now: number
  decimals: ProgressPrecision
  segmented?: boolean
  update: (patch: Partial<ViewState>) => void
  toggle: (tree: Tree['id'], id: Task['id']) => void
  openTask: (tree: Tree['id'], task: Task['id']) => void
  requestTask: (request: TaskRequest) => Promise<void>
  playback: PlaybackState
  running: boolean
}

/** Whole minutes in the units of formatDuration; less than one minute reads `<1m`. */
function formatMinutes(minutes: number): string {
  return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : formatDuration(minutes * MINUTE_MS)
}

/** Expandable task hierarchy with host-native semantic status tags. */
export function TaskTree({
  sessionId,
  view,
  state,
  now,
  decimals,
  segmented = true,
  update,
  toggle,
  openTask,
  requestTask,
  playback,
  running,
  importTree,
  removeTree,
  t,
}: TaskTreeProps): ReactNode {
  const menuButton = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [transfer, setTransfer] = useState<'import' | 'remove' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Tree | undefined>()
  const [message, setMessage] = useState<string | null>(null)
  const tree = view.trees.find(item => item.id === (state.tree ?? view.activeTreeId))
  const missing = state.tree !== null && tree === undefined
  const treeIndex = view.trees.findIndex(item => item.id === tree?.id)
  // Paging needs another tree, or a way to reach the only tree when none is shown.
  const single = view.trees.length === 1 && tree !== undefined
  const previous = view.trees[treeIndex - 1]
  const next = view.trees[treeIndex + 1]
  const select = (tree: Tree) => {
    update({ tree: tree.id })
    setMenuOpen(false)
  }
  const measures = useMemo(() => measureAll(tree?.tasks ?? [], segmented), [tree, segmented])
  const priorities = useMemo(() => prioritiesOf(tree?.tasks ?? []), [tree])
  const parents = useMemo(
    () => new Set(tree?.tasks.filter(task => task.status !== 'retired').map(task => task.parent)),
    [tree],
  )
  const overall = measures.get(null)
  const leaves = tree?.tasks.filter(item => item.status !== 'retired' && !parents.has(item.id)) ?? []
  const done = leaves.filter(item => item.status === 'done').length
  const working = overall?.status === 'active' && running
  const observedAt =
    !working && tree !== undefined
      ? Math.max(tree.createdAt, ...tree.tasks.map(item => item.updatedAt))
      : now
  const elapsed = tree === undefined ? 0 : Math.max(0, observedAt - tree.createdAt)
  const remaining =
    overall === undefined || overall.progress <= 0
      ? null
      : (elapsed * (1 - overall.progress)) / overall.progress
  const remainingText =
    remaining === null ? t('unknown') : `≈${formatMinutes(Math.max(1, Math.round(remaining / MINUTE_MS)))}`
  const estimateHint = `${t('estimateCalculated')}: ${remainingText}\n\n${t('estimateHint')}`
  const collapsed = tree !== undefined && Object.hasOwn(state.collapsed, tree.id) ? state.collapsed[tree.id] : undefined
  const rows = (parent: Task['id'] | null): ReactNode =>
    tree?.tasks
      .filter(item => item.parent === parent && item.status !== 'retired')
      .map((item) => {
        // Rows are reached through the same non-retired branches as measureAll.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const measure = measures.get(item.id)!
        const nested = parents.has(item.id)
        const expanded = !collapsed?.includes(item.id)
        const status = measure.status
        const priority = priorities.get(item.id) ?? null
        return (
          <li key={item.id}>
            <div className="timeline-task" data-status={status}>
              {nested ? (
                <button
                  className="timeline-disclosure"
                  aria-label={item.title}
                  aria-expanded={expanded}
                  onClick={() => { toggle(tree.id, item.id) }}
                >
                  <span className="timeline-caret" data-expanded={expanded}>
                    <IconChevronRightOutlineRegular size={14} />
                  </span>
                </button>
              ) : (
                <span className="timeline-leaf" data-status={status} aria-hidden="true">
                  {status === 'done' ? (
                    <IconCheckOutlineRegular size={14} />
                  ) : (
                    <span className="timeline-status-dot" />
                  )}
                </span>
              )}
              <button
                className="timeline-task-title"
                data-tree-id={tree.id}
                data-task-id={item.id}
                onClick={() => { openTask(tree.id, item.id) }}
              >
                <span>{item.title}</span>
                <small>
                  <Tag tone={statusTones[status]}>{t(status)}</Tag>
                  {priority === null ? null : (
                    <span className="timeline-priority-badge" data-priority={priority}>
                      {priority}
                    </span>
                  )}
                  {item.note ? <span className="timeline-task-note">{item.note}</span> : null}
                </small>
              </button>
              <Progress
                label={`${item.title} ${t('progress')}`}
                value={measure.progress}
                status={status}
                decimals={decimals}
                parts={measure.parts}
                t={t}
              />
              <span className="timeline-percent">{formatProgress(measure.progress, decimals)}%</span>
            </div>
            {nested && expanded ? <ul>{rows(item.id)}</ul> : null}
          </li>
        )
      })
  return (
    <section className="timeline-task-tree" aria-label={t('tasks')}>
      <nav
        className="timeline-tree-navigation"
        aria-label={t('taskTreeChoice')}
        data-single={single || undefined}
      >
        {view.trees.length === 0 || missing ? null : (
          <>
            {single ? null : (
              <Button
                className="timeline-icon-button"
                aria-label={t('previousTree')}
                title={t('previousTree')}
                disabled={previous === undefined}
                onClick={previous === undefined ? undefined : () => { select(previous) }}
              >
                <IconChevronLeftOutlineRegular size={18} />
              </Button>
            )}
            <div className="timeline-tree-label">
              <div className="timeline-tree-picker">
                <select
                  aria-label={t('taskTreeChoice')}
                  value={tree?.id ?? ''}
                  onChange={(event) => {
                    const selected = view.trees.find(item => item.id === event.currentTarget.value)
                    if (selected !== undefined) select(selected)
                  }}
                >
                  {view.trees.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </div>
              {single ? null : (
                <small>
                  {treeIndex + 1} / {view.trees.length}
                </small>
              )}
            </div>
            {single ? null : (
              <Button
                className="timeline-icon-button"
                aria-label={t('nextTree')}
                title={t('nextTree')}
                disabled={next === undefined}
                onClick={next === undefined ? undefined : () => { select(next) }}
              >
                <IconChevronRightOutlineRegular size={18} />
              </Button>
            )}
          </>
        )}
        <div className="timeline-tree-actions">
          {
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              align="end"
              portal
              compact
              autoFocus
              anchor={
                <Button
                  ref={menuButton}
                  className="timeline-icon-button"
                  aria-label={t('treeActions')}
                  title={t('treeActions')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => { setMenuOpen(!menuOpen) }}
                >
                  <IconEllipsisOutlineRegular size={18} />
                </Button>
              }
              items={[
                ...(tree?.tasks.some(task => parents.has(task.id))
                  ? [
                    {
                      id: 'expand',
                      label: t('expandAll'),
                      icon: <IconChevronDownOutlineRegular size={16} />,
                    },
                    {
                      id: 'collapse',
                      label: t('collapseAll'),
                      icon: <IconChevronRightOutlineRegular size={16} />,
                    },
                  ]
                  : []),
                {
                  id: 'import',
                  label: t('importTree'),
                  icon: <IconPlusOutlineRegular size={16} />,
                  disabled: running,
                },
                ...(tree === undefined
                  ? []
                  : [
                    {
                      id: 'export',
                      label: t('exportTree'),
                      icon: <IconDownloadOutlineRegular size={16} />,
                    },
                    {
                      id: 'remove',
                      label: t('deleteTree'),
                      icon: <IconTrashOutlineRegular size={16} />,
                      danger: true,
                      disabled: running,
                    },
                  ]),
              ]}
              onSelect={(id) => {
                setMenuOpen(false)
                setMessage(null)
                if (id === 'import' || id === 'remove') {
                  menuButton.current?.focus({ preventScroll: true })
                  if (id === 'remove') setDeleteTarget(tree)
                  setTransfer(id)
                  return
                }
                // Every remaining menu item is registered only for a selected tree.
                // oxlint-disable-next-line typescript/no-non-null-assertion
                const selected = tree!
                if (id === 'export') {
                  try {
                    exportTree(selected, view.annotations, sessionId)
                  } catch (error: unknown) {
                    setMessage(error instanceof Error ? error.message : t('treeTransferFailed'))
                  }
                  return
                }
                update({
                  collapsed: {
                    ...state.collapsed,
                    [selected.id]:
                      id === 'expand'
                        ? []
                        : selected.tasks.filter(task => parents.has(task.id)).map(task => task.id),
                  },
                })
                setMenuOpen(false)
              }}
            />
          }
        </div>
      </nav>
      {message === null ? null : (
        <p className="timeline-error" role="alert">
          {message}
        </p>
      )}
      <TreeTransfer
        key={transfer}
        sessionId={sessionId}
        mode={transfer}
        tree={
          transfer === 'remove'
            ? (view.trees.find(item => item.id === deleteTarget?.id) ?? deleteTarget)
            : tree
        }
        view={view}
        running={running}
        decimals={decimals}
        t={t}
        close={() => { setTransfer(null) }}
        importTree={importTree}
        removeTree={removeTree}
        imported={(id, warning) => {
          update({ tree: id, tab: 'tasks', details: { ...state.details, tasks: [] } })
          setMessage(warning ? t('treeNotifyUnknown') : null)
        }}
        removed={(warning) => {
          setMessage(warning ? t('treeNotifyUnknown') : null)
        }}
      />
      {tree === undefined ? (
        <div className="timeline-empty">
          {missing ? (
            <>
              <p role="status">{t('treeUnavailable')}</p>
              {view.activeTreeId === null ? null : (
                <Button variant="outline" onClick={() => { update({ tree: null }) }}>
                  {t('openActiveTree')}
                </Button>
              )}
            </>
          ) : (
            <>
              <p>{t('emptyTasks')}</p>
              <p className="timeline-muted">{t('planHint')}</p>
              <Button
                variant="outline"
                disabled={running}
                title={running ? t('treeIdleRequired') : undefined}
                onClick={() => { setTransfer('import') }}
              >
                {t('importTree')}
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="timeline-overview" data-status={overall?.status ?? 'pending'}>
            <div className="timeline-overview-title">
              <strong>{t('progress')}</strong>
              <Tag tone={statusTones[overall?.status ?? 'pending']}>{t(overall?.status ?? 'pending')}</Tag>
            </div>
            <TaskActions
              playback={playback}
              key={tree.id}
              tree={tree}
              status={overall?.status ?? 'pending'}
              request={requestTask}
              t={t}
            >
              <Progress
                label={t('progress')}
                value={overall?.progress ?? 0}
                status={overall?.status ?? 'pending'}
                decimals={decimals}
                parts={overall?.parts}
                t={t}
              />
              <strong>
                {formatProgress(overall?.progress ?? 0, decimals)}
                <span>%</span>
              </strong>
            </TaskActions>
            <div className="timeline-task-stats">
              <span>
                {done}/{leaves.length} {t('leafTasks')}
              </span>
              <span>
                {t('elapsed')}: {formatMinutes(Math.floor(elapsed / MINUTE_MS))}
                {working ? (
                  <>
                    {' · '}
                    <span className="timeline-eta">
                      {t('remaining')}: {remainingText}
                      <Tooltip label={estimateHint} side="top" maxWidth={320} portal openOnClick>
                        <Button
                          className="timeline-icon-button timeline-estimate-help"
                          aria-label={t('estimateHelp')}
                        >
                          <IconQuestionOutlineRegular size={14} />
                        </Button>
                      </Tooltip>
                    </span>
                  </>
                ) : null}
              </span>
            </div>
          </div>
          <ul className="timeline-tasks">{rows(null)}</ul>
        </>
      )}
    </section>
  )
}
