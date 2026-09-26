/**
 * Browser catalogs for retained Host tasks and the selected Session's active
 * reminders, plus the right-Sidebar page that shows one task's detail.
 *
 * The page type reaches the Sidebar through its public path only: the
 * definition into `ctx.sidebarRightTabs`, the body into the keyed
 * `sidebar.right.pane.tab` seat, and the chip title into
 * `sidebar.right.pane.tab.title`, both under the definition's `id`. Because the
 * Sidebar persists a tab's layout record and not the parameters its opener
 * passed, the page also owns a binding from each tab page to the task it last
 * showed, which its body and chip read back after a reload. The Session
 * header entry and the task tab share one Host catalog source, so opening or
 * deleting from either view reads and refreshes the same records.
 *
 * The created task of a `schedule_create` call renders at Turn level: a Turn
 * Definition publishes the settled result against its Turn, and ui-chat's
 * `conversation.chat.turnTail` list seat renders the card beneath
 * the closing prose, outside the collapsible Tool group, opening the same
 * right-Sidebar detail the header entry opens. The call's Tool-group cell
 * stays with ui-tool's generic keyed tool view, so this package registers no
 * `tool.call.toolview` entry for the wire name.
 *
 * Two ambient surfaces read the ONE Host catalog the page owns: ui-workspace's
 * `sidebar.session.row.leading` seat marks an idle row whose Session has an
 * active task, and its `sidebar.session.row.hover` seat lists those tasks
 * inside the row's hover card. Both project the same source, so N visible rows
 * issue one query rather than one per row. The header entry keeps its own
 * per-Session source.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleCatalogEntry, ScheduleDeliveryHistoryRequest, ScheduleId, ScheduleUpdateRequest } from '@deepseek-ai/dsh-schedule/client'
import { createCatalogSource, type CatalogDeleteOutcome, type CatalogInjected } from './catalog-source.ts'
import { createDeleteToastSource, ScheduleDeleteToast } from './DeleteToast.tsx'
import { SCHEDULE_TASK_ID, SCHEDULE_TASK_KIND, scheduleTaskDefinition } from './definition.ts'
import { ScheduleCatalogAction } from './ScheduleCatalogAction.tsx'
import { ScheduleTurnCard, type ScheduleTurnCardInjected } from './ScheduleTurnCard.tsx'
import { scheduleTurnDefinition } from './schedule-turn.ts'
import { ScheduleTaskTab, type ScheduleTaskBindingInjected, type ScheduleTaskCatalogInjected, type ScheduleTaskTabInjected } from './ScheduleTaskTab.tsx'
import { ScheduleTaskTabTitle } from './ScheduleTaskTabTitle.tsx'
import { SessionScheduleHover } from './SessionScheduleHover.tsx'
import { SessionScheduleMark } from './SessionScheduleMark.tsx'
import { createSessionScheduleSource, type SessionScheduleSourceFactory } from './session-schedule-state.ts'
import { TaskTabBindings } from './task-tab-bindings.ts'
import { TaskManagerPage, type TaskManagerInjected } from './TaskManagerPage.tsx'
import type { TaskDetailInjected } from './TaskDetail.tsx'
import { TaskManagerIcon } from './TaskManagerIcon.tsx'
import { sessionLinkState } from './session-link.ts'
import { en, NS, zh, type ScheduleCatalogKey } from './locales.ts'
import { en as managerEn, zh as managerZh, type TaskManagerKey } from './task-manager-locales.ts'

const MANAGER_NS = 'schedule.manager'
const PANEL_ID = 'schedules' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Active Schedule catalog copy. */
    'schedule.catalog': ScheduleCatalogKey
    /** Host task management page and task tab copy. */
    'schedule.manager': TaskManagerKey
  }
}

/** Required services for catalogs, ambient Session marks, the right Sidebar, Remote queries, and original-Session navigation. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.schedule', 'conversation', 'uiConversation', 'uiWorkspace', 'sessions',
  'workspaces', 'sidebarRightTabs', 'sidebarRight',
]

/**
 * Register the Host task page, the Session-header reminder catalog, the
 * right-Sidebar page that shows one task's detail, and the transcript card of
 * one created task.
 * @param ctx - browser services used by these contributions.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-schedule: dictionaries')
  ctx.effect(() => ctx.locale.register(MANAGER_NS, { zh: managerZh, en: managerEn }), 'ui-schedule: manager dictionaries')
  const t = ctx.locale.bind(MANAGER_NS)
  const manager: CatalogInjected<ScheduleCatalogEntry> = createCatalogSource<ScheduleCatalogEntry>({
    list: () => ctx.remote.schedule.catalog(),
    remove: async (id) => {
      const record = manager.hooks.catalog.getSnapshot().records.find(item => item.id === id)
      if (record === undefined) return { ok: true, value: { id, deleted: false, code: 'schedule_not_found' } }
      return ctx.remote.schedule.delete({ sessionId: record.sessionId, id })
    },
    subscribeChanged: listener => ctx.remote.$on('schedule/changed', listener),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  // One outcome store behind one `shell.overlay` entry announces every deletion
  // this plugin's surfaces settle, so the notice outlives the panel, popover, or
  // tab the deletion started in.
  const deleteToast = createDeleteToastSource()
  const reportedDelete = (onDelete: (id: ScheduleId) => Promise<CatalogDeleteOutcome>) =>
    async (id: ScheduleId): Promise<CatalogDeleteOutcome> => {
      const outcome = await onDelete(id)
      deleteToast.report(outcome)
      return outcome
    }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'schedule.delete-toast', locale: MANAGER_NS,
    inject: () => ({ hooks: deleteToast.hooks, dismiss: deleteToast.dismiss }),
  }, ScheduleDeleteToast))
  /**
   * Forward one compare-and-update request, which may replace the task name,
   * the instruction, and/or the timing, and refresh the authoritative catalog
   * after an accepted or stale outcome.
   * @param request - complete expected record with the optional content and timing change.
   * @returns the original Remote mutation result.
   */
  const updateTask = async (request: ScheduleUpdateRequest) => {
    const result = await ctx.remote.schedule.update(request)
    if (result.ok && ('record' in result.value || result.value.code === 'schedule_conflict'
      || result.value.code === 'schedule_ended' || result.value.code === 'schedule_not_found')) {
      // The write is in, so this readback must not join a read that was sent
      // before it: naming every request seen so far makes the source issue a new
      // one, the way the post-deletion readback supersedes.
      await manager.onRetry(manager.hooks.catalog.getSnapshot().readRequest)
    }
    return result
  }
  const loadHistory = (request: ScheduleDeliveryHistoryRequest) => ctx.remote.schedule.history(request)
  const openSession = (id: SessionId): void => {
    if (sessionLinkState(id, ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot()) === 'available') {
      ctx.uiWorkspace.openSession(id)
    }
  }
  const detail: TaskDetailInjected & ScheduleTaskCatalogInjected = {
    hooks: manager.hooks,
    onDelete: reportedDelete(manager.onDelete),
    onRetry: manager.onRetry,
    onUpdateTiming: updateTask,
    loadHistory,
    onOpenSession: openSession,
  }
  // The Sidebar persists a tab's layout record and not its navigation
  // parameters, so this page type keeps the task it last showed per Session and
  // tab id. That Session's committed tab ids bound every write, so a closed tab
  // leaves no entry behind.
  const taskBindings = new TaskTabBindings(
    sessionId => ctx.sidebarRight.tabsIn(sessionId).map(tab => tab.id),
  )
  ctx.effect(() => ctx.sidebarRightTabs.register(scheduleTaskDefinition(t)), 'ui-schedule: task tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SCHEDULE_TASK_ID,
    locale: MANAGER_NS,
    inject: (): ScheduleTaskTabInjected => ({ ...detail, taskBindings }),
  }, ScheduleTaskTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: SCHEDULE_TASK_ID,
    locale: MANAGER_NS,
    inject: (): ScheduleTaskCatalogInjected & ScheduleTaskBindingInjected => ({ hooks: detail.hooks, taskBindings }),
  }, ScheduleTaskTabTitle))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: MANAGER_NS,
    inject: (): TaskManagerInjected => ({
      ...detail,
      // The page has no creation form: a new reminder starts in a Session.
      onNewTask: () => { ctx.uiWorkspace.startSession() },
    }),
  }, TaskManagerPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    locale: MANAGER_NS,
    label: () => t('panel'),
  }, TaskManagerIcon))
  // The created task is a Turn-level element, not a Tool-group row: the Turn
  // Definition publishes the settled result and this tail list entry renders
  // the card beneath the closing prose.
  ctx.uiConversation.events.register(scheduleTurnDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'schedule-created',
    order: 20,
    locale: MANAGER_NS,
    inject: (sessionId: SessionId): ScheduleTurnCardInjected => ({
      hooks: { catalog: manager.hooks.catalog },
      onRetry: manager.onRetry,
      openTaskDetail: (id) => {
        ctx.sidebarRight.openTab(SCHEDULE_TASK_KIND, { params: { sessionId, id } })
      },
    }),
  }, ScheduleTurnCard))
  // The Session header keeps one per-Session source: it lists the open
  // Session's active tasks and starts only while that header is mounted. The
  // Sidebar row seats read the shared `manager` catalog instead, so every
  // visible row projects one Host query rather than issuing its own.
  const createSource: SessionScheduleSourceFactory = sessionId =>
    createSessionScheduleSource(ctx, sessionId)
  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'schedule-catalog',
      // Sits left of the overflow menu (order 0) and right of the header's
      // leading utilities (order -10), matching the shipped mock.
      order: -5,
      locale: NS,
      inject: (sessionId) => {
        const source = createSource(sessionId)
        return {
          ...source,
          // The header's deletions settle through the same app-wide toast as the
          // Tasks page and the task tab.
          onDelete: reportedDelete(source.onDelete),
          openTaskDetail: (id: ScheduleId) => {
            ctx.sidebarRight.openTab(SCHEDULE_TASK_KIND, { params: { sessionId, id } })
          },
        }
      },
    }, ScheduleCatalogAction),
  )
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'schedule-mark',
    order: 10,
    locale: NS,
    inject: () => ({ hooks: { catalog: manager.hooks.catalog } }),
  }, SessionScheduleMark))
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover',
    id: 'schedule-tasks',
    order: 10,
    locale: NS,
    inject: () => ({ hooks: { catalog: manager.hooks.catalog } }),
  }, SessionScheduleHover))
}
