/**
 * The task tab's body: one retained task's detail in the right Sidebar.
 *
 * The tab's layout record stores nothing durable. It selects its task from the
 * shared Host catalog by the navigation parameters it was opened with and
 * renders the same `TaskDetail` component the Tasks page renders, so both views
 * offer identical fields, timing edits, saved deliveries, confirmed deletion,
 * and the original Session link. A record restored by a reload carries no
 * parameters, so the body falls back to the provider-owned binding that the
 * navigation wrote; a retained edit draft keeps the detail on screen after the
 * catalog row disappears, and a confirmed deletion closes this tab once the
 * refreshed catalog reports the row gone; without a draft, the body reports
 * that the task is gone.
 *
 * The parameters name the task's original Session, and every mutation carries
 * that binding, so reading or deleting from here never activates a Session.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogSnapshot } from './catalog-source.ts'
import { CatalogFeedback } from './CatalogFeedback.tsx'
import { TaskDetail, useTaskDetail, type TaskDetailInjected } from './TaskDetail.tsx'
import type { TaskTabBindings } from './task-tab-bindings.ts'
import { useTaskTabTarget } from './task-tab-target.ts'
import css from './TaskManagerPage.module.css'

/** The Host task catalog the body, its chip, and the Tasks page all read. */
export interface ScheduleTaskCatalogInjected {
  /** Shared Host task catalog with its query and deletion state. */
  readonly hooks: { readonly catalog: HostObservable<CatalogSnapshot<ScheduleCatalogEntry>> }
}

/** The provider-owned recovery a restored tab page resolves its task through. */
export interface ScheduleTaskBindingInjected {
  /** Durable binding from one task tab page to the task it last showed. */
  readonly taskBindings: TaskTabBindings
}

/** Everything the task tab's body needs injected. */
export interface ScheduleTaskTabInjected extends TaskDetailInjected, ScheduleTaskCatalogInjected, ScheduleTaskBindingInjected {}

/** Props of the task tab's body: the tab it draws, localized copy, and its catalog face. */
export type ScheduleTaskTabProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'schedule.manager'>
  & InjectFace<ScheduleTaskTabInjected>

/**
 * Render the single task named by this tab's navigation parameters or by the
 * binding those parameters last wrote.
 *
 * When neither names a task, the body reports the catalog feedback until a read
 * requested after the baseline for the current navigation succeeds without the
 * task; the missing-task state then covers both an unbound restored tab and a
 * navigated tab whose task is gone.
 * @param props - tab information, the Host task catalog, localized copy, and action callbacks.
 * @returns the task's detail, or its centered loading, query-failure, or missing-task state.
 */
export function ScheduleTaskTab(props: ScheduleTaskTabProps): ReactNode {
  const {
    sessionId, useTabInfo, useCatalog, onRetry, taskBindings, t,
  } = props
  const { tab } = useTabInfo()
  const { navigated, navigation, recovered, params } = useTaskTabTarget(sessionId, tab, taskBindings)
  const catalog = useCatalog(snapshot => snapshot)
  const detail = useTaskDetail(props, catalog, params?.id)
  const { task, record: catalogRecord } = detail
  // A restored tab can appear with a task whose creation the last successful read
  // has not seen yet, so the retained records state that this tab's task is gone
  // only from a read requested after the baseline for its current navigation - the
  // rule the created-task card applies to a missing record. The baseline is the
  // request ordinal this tab observed when it started showing that navigation: the
  // Sidebar navigates a tab again without remounting its component, so the
  // navigation's revision moves the baseline, while a restored tab whose binding is
  // forgotten keeps the baseline it appeared with. A row the records already hold is
  // shown from whatever read published it.
  const navigationRevision = navigated ? tab.navigation.revision : undefined
  const [baseline, setBaseline] = useState(() => (
    { revision: navigationRevision, request: catalog.readRequest }
  ))
  if (baseline.revision !== navigationRevision) {
    setBaseline({ revision: navigationRevision, request: catalog.readRequest })
  }
  const answered = catalog.settled && catalog.readSettled > baseline.request
  useEffect(() => {
    // The retained records leave this tab without a task and no read requested
    // after that baseline has succeeded: ask for one, naming the baseline ordinal.
    // A refresh shares only a read requested after that ordinal, so the read that
    // answers for this tab is never one sent before the baseline.
    if (task === undefined && !answered) void onRetry(baseline.request)
  }, [onRetry, baseline.request, task, answered])

  useEffect(() => {
    if (navigation === undefined) return
    taskBindings.write(sessionId, { id: tab.id, kind: tab.kind, contentId: tab.contentId }, navigation)
  }, [taskBindings, sessionId, tab.id, tab.kind, tab.contentId, navigation?.sessionId, navigation?.id])

  useEffect(() => {
    // A binding this tab cannot resolve against a read that succeeded after the tab
    // appeared described a task that no longer exists; forgetting it leaves the
    // restored tab in the same feedback state as one that never had a binding. A
    // refresh republishes `loading` over the retained records, so that read is the
    // one that answers, not the read state.
    if (recovered === undefined || navigated || !answered || catalogRecord !== undefined) return
    taskBindings.forget(sessionId, { id: tab.id, kind: tab.kind, contentId: tab.contentId })
  }, [taskBindings, sessionId, tab.id, tab.kind, tab.contentId, recovered, navigated, answered, catalogRecord])

  if (task === undefined) {
    // A tab this window cannot name a task for has nothing left to load once a
    // read succeeds, so it states the task's absence rather than reporting a load
    // that never ends; an unbound restored tab and a navigated tab whose task is
    // gone read the same to the user, so both center the one missing-task state.
    // A ready catalog from a read this tab may not use is not that answer: the
    // tab is waiting for its own read, so it reports the load instead.
    const pending = catalog.status === 'ready' && !answered
    return <div className={css.tabBody}>
      {answered
        ? <div className={css.empty} role="status">
          <IconClockOutlineRegular size={24} className={css.emptyGlyph} />
          <h3>{t('detail.missing')}</h3>
        </div>
        : <CatalogFeedback status={pending ? 'loading' : catalog.status} populated={false} onRetry={onRetry} t={t} />}
    </div>
  }

  return <div className={css.tabBody}>
    <TaskDetail
      {...detail.props}
      task={task}
      authoritative={catalogRecord !== undefined}
      onDeleted={() => { tab.actions.close() }}
      withinSession={sessionId}
    />
  </div>
}
