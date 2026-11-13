import { useId, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore, ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../config.ts'
import { defaultReportCadence } from '../policy.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { createViewStore, ViewState } from './store.ts'
import { emptyDraft } from './store.ts'
import { Schedule } from './Schedule.tsx'
import { TaskTree } from './TaskTree.tsx'
import { Details } from './Details.tsx'
import type { DetailTarget } from './navigation.ts'
import type { AnnotationRequest, PriorityRequest, TaskRequest } from './actions.ts'
import { DiscussionHistory } from './Annotations.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TreeTransferActions } from './TreeTransfer.tsx'

export interface PanelInjected extends TreeTransferActions {
  hooks: {
    clock: ObservableSnapshot<number>
    locale: ObservableSnapshot<{ active: string }>
    settings: ObservableSnapshot<ConfigFormSnapshot<Config>>
    selection: ObservableSnapshot<SessionId | null>
  }
  requestTask: (request: TaskRequest) => Promise<void>
  setPriority: (request: PriorityRequest) => Promise<void>
  annotate: (request: AnnotationRequest) => Promise<{ notified: boolean }>
  consumeSelection: () => void
}
type PanelProps = PropsRuntime<'sidebar.right.pane.tab'> &
  PropsLocale<'timeline'> &
  PropsStore<ReturnType<typeof createViewStore>> &
  InjectFace<PanelInjected>

/** Read the shared committed view; this panel owns only viewing choices. */
export function Panel({
  sessionId,
  useProjection,
  useStore,
  actions,
  useClock,
  useLocale,
  useSettings,
  t,
  useSession,
  requestTask,
  setPriority,
  annotate,
  useTabInfo,
  useSelection,
  consumeSelection,
  importTree,
  removeTree,
}: PanelProps): ReactNode {
  const id = useId()
  const locale = useLocale(value => value.active)
  const container = useRef<HTMLDivElement>(null)
  const restore = useRef<{ scrollTop: number; target: DetailTarget | null } | null>(null)
  const view = useProjection('timeline')
  const settings = useSettings(value => value.value)
  const state = useStore(value => value)
  const now = useClock(value => value)
  const playback = { annotations: view?.annotations ?? [], trees: view?.trees ?? [], now }
  const running = useSession(value => value.running)
  const selection = useSelection(value => (value === sessionId ? value : null))
  useLayoutEffect(() => {
    if (selection === null) return
    actions.update({ tree: null, tab: 'tasks', details: { tasks: [], timeline: [] } })
    consumeSelection()
  }, [selection])
  const tabInfo = useTabInfo()
  const pages = state.details[state.tab]
  const page = pages.at(-1)
  const draftKey = JSON.stringify(page?.target)
  useLayoutEffect(() => {
    const root = container.current
    const page = restore.current
    if (root === null || page === null) return
    restore.current = null
    const target = page.target
    const control =
      target === null
        ? root.querySelector<HTMLButtonElement>('[data-detail-back]')
        : [...root.querySelectorAll<HTMLButtonElement>('[data-task-id],[data-report-id]')].find(button =>
          target.kind === 'task'
            ? button.dataset.taskId === target.task && button.dataset.treeId === target.tree
            : button.dataset.reportId === target.report,
        )
    // Child links return inside their disclosure; focus must not change the saved time position.
    control?.closest('details')?.setAttribute('open', '')
    ;(root.querySelector<HTMLElement>('.timeline-detail-scroll') ?? root).scrollTop = page.scrollTop
    ;(control ?? root.querySelector<HTMLElement>('[role=tabpanel]'))?.focus({ preventScroll: true })
  }, [pages])
  const open = (target: DetailTarget) => {
    // Detail links exist only while the panel is mounted.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const root = container.current!
    restore.current = { scrollTop: 0, target: null }
    actions.update({
      details: {
        ...state.details,
        [state.tab]: [
          ...pages,
          {
            target,
            scrollTop: (root.querySelector<HTMLElement>('.timeline-detail-scroll') ?? root).scrollTop,
          },
        ],
      },
    })
  }
  const back = (previous: (typeof pages)[number]) => {
    restore.current = previous
    actions.update({ details: { ...state.details, [state.tab]: pages.slice(0, -1) } })
  }
  const tabIds = ['tasks', 'timeline'] as const
  return (
    <div
      className="dsh-timeline"
      data-detail={page?.target.kind}
      ref={container}
      data-timeline-dock-open={tabInfo.sidebar.expanded && tabInfo.tab.visible}
    >
      <header className="timeline-panel-header">
        <span>
          <strong>{t('title')}</strong>
          <small>{t('guide')}</small>
        </span>
      </header>
      <div className="timeline-tabs" role="tablist" aria-label={t('title')}>
        {tabIds.map(tab => (
          <button
            key={tab}
            id={`${id}-${tab}`}
            data-tab={tab}
            role="tab"
            type="button"
            aria-selected={state.tab === tab}
            aria-controls={`${id}-content`}
            tabIndex={state.tab === tab ? 0 : -1}
            onClick={() => { actions.update({ tab }) }}
            onKeyDown={(event) => {
              const index = tabIds.indexOf(tab)
              const next: ViewState['tab'] | undefined =
                event.key === 'Home'
                  ? tabIds[0]
                  : event.key === 'End'
                    ? tabIds[1]
                    : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
                      ? tabIds[(index + 1) % tabIds.length]
                      : undefined
              if (next === undefined) return
              event.preventDefault()
              actions.update({ tab: next })
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
                ?.focus()
            }}
          >
            {t(tab === 'tasks' ? 'tasks' : 'reports')}
            {tab === 'timeline' && view !== undefined ? (
              <span className="timeline-tab-count" aria-hidden="true">
                {view.reports.filter(report => report.source !== 'no-activity').length}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {view === undefined ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <div role="tabpanel" id={`${id}-content`} aria-labelledby={`${id}-${state.tab}`} tabIndex={0}>
          {page !== undefined ? (
            <Details
              locale={locale}
              view={view}
              target={page.target}
              decimals={settings?.progressDecimals ?? 2}
              back={() => { back(page) }}
              open={open}
              requestTask={requestTask}
              playback={playback}
              setPriority={setPriority}
              annotate={annotate}
              annotationDraft={{
                draft: state.drafts[draftKey] ?? emptyDraft,
                update: (patch) => { actions.draft(draftKey, patch) },
              }}
              t={t}
            />
          ) : state.tab === 'tasks' ? (
            <TaskTree
              sessionId={sessionId}
              view={view}
              state={state}
              now={now}
              decimals={settings?.progressDecimals ?? 2}
              segmented={settings?.segmentedProgress ?? true}
              update={actions.update}
              toggle={actions.toggle}
              openTask={(tree, task) => { open({ kind: 'task', tree, task }) }}
              requestTask={requestTask}
              playback={playback}
              running={running}
              importTree={importTree}
              removeTree={async (tree) => {
                const result = await removeTree(tree)
                actions.forgetTree(tree)
                return result
              }}
              t={t}
            />
          ) : (
            <>
              {settings?.reportsEnabled === false ? (
                <p className="timeline-notice" role="status">
                  {t('reportsDisabled')}
                </p>
              ) : null}
              {view.error ? (
                <p className="timeline-error" role="alert">
                  {t('failed')} {view.error}
                </p>
              ) : null}
              <Schedule
                locale={locale}
                cadence={settings ?? defaultReportCadence}
                view={view}
                state={state}
                now={now}
                update={actions.update}
                openReport={(report) => { open({ kind: 'report', report }) }}
                t={t}
              />
            </>
          )}
          {page === undefined ? (
            <DiscussionHistory
              locale={locale}
              view={view}
              open={state.historyOpen}
              onToggle={(historyOpen) => { actions.update({ historyOpen }) }}
              t={t}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
