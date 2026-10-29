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
 * issue one query rather than one per row. The header entry projects the same
 * source onto the open Session's active tasks.
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
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleId, ScheduleCatalogEntry, ScheduleDeleteResult } from '@deepseek-ai/dsh-schedule/client'
import { createCatalogSource, type CatalogDeleteOutcome } from './catalog-source.ts'
import { createClearEnded } from './clear-ended.ts'
import { createDeleteToastSource, ScheduleDeleteToast } from './DeleteToast.tsx'
import { SCHEDULE_TASK_ID, SCHEDULE_TASK_KIND, scheduleTaskDefinition } from './definition.ts'
import { ScheduleCatalogAction } from './ScheduleCatalogAction.tsx'
import { ScheduleTurnCard, type ScheduleTurnCardInjected } from './ScheduleTurnCard.tsx'
import { scheduleTurnDefinition } from './schedule-turn.ts'
import { ScheduleTaskTab, type ScheduleTaskBindingInjected, type ScheduleTaskCatalogInjected, type ScheduleTaskTabInjected } from './ScheduleTaskTab.tsx'
import { ScheduleTaskTabTitle } from './ScheduleTaskTabTitle.tsx'
import { SessionScheduleHover } from './SessionScheduleHover.tsx'
import { SessionScheduleMark } from './SessionScheduleMark.tsx'
import { TaskTabBindings } from './task-tab-bindings.ts'
import { TaskManagerPage, type TaskManagerInjected } from './TaskManagerPage.tsx'
import type { TaskDetailInjected } from './TaskDetail.tsx'
import { TaskManagerIcon } from './TaskManagerIcon.tsx'
import { sessionLinkState } from './session-link.ts'
import { en, ja, es, fr, de, ru, pt, NS, zh, type ScheduleCatalogKey } from './locales.ts'
import { en as managerEn, ja as managerJa, es as managerEs, fr as managerFr, de as managerDe, ru as managerRu, pt as managerPt, zh as managerZh, type TaskManagerKey } from './task-manager-locales.ts'

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

/** Required services for catalogs, ambient Session marks, the right Sidebar, Remote queries, linked-Session navigation, and access. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.schedule', 'conversation', 'uiConversation', 'uiWorkspace', 'sessions',
  'workspaces', 'sidebarRightTabs', 'sidebarRight', 'remoteAccess',
]

async function settle<T>(call: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T> | undefined> {
  try { return await call() }
  catch (_error: unknown) {
    // A rejected call leaves the outcome unknown, so its caller shows the same localized retry as a Remote failure.
    return undefined
  }
}

function inputCorrection(error: RemoteFailure): 'host.notFuture' | 'host.invalidRule' | undefined {
  if (error.code !== 'schedule/input-invalid') return undefined
  const { code } = error.details
  if (code === 'not_future') return 'host.notFuture'
  return code === 'invalid_rule' || code === 'frequency_too_high' || code === 'invalid_time_zone' || code === 'time_out_of_range'
    ? 'host.invalidRule' : undefined
}

/**
 * Register the Host task page, the Session-header reminder catalog, the
 * right-Sidebar page that shows one task's detail, and the transcript card of
 * one created task while the current Peer may read the task catalog.
 * @param ctx - browser services used by these contributions.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-schedule: dictionaries')
  const managerDictionaries = {
    zh: managerZh,
    en: managerEn,
    ja: managerJa,
    es: managerEs,
    fr: managerFr,
    de: managerDe,
    ru: managerRu,
    pt: managerPt,
  }
  ctx.effect(() => ctx.locale.register(MANAGER_NS, managerDictionaries), 'ui-schedule: manager dictionaries')
  const t = ctx.locale.bind(MANAGER_NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(scheduleTaskDefinition(t)), 'ui-schedule: task tab type')
  // The created task is a Turn-level element, not a Tool-group row: the Turn
  // Definition publishes the settled result and the tail list entry below
  // renders the card beneath the closing prose.
  ctx.uiConversation.events.register(scheduleTurnDefinition)
  ctx.remoteAccess.whenAccess('schedule/catalog', function* () {
    const manager = createCatalogSource<ScheduleCatalogEntry>({
      list: () => ctx.remote.schedule.catalog(),
      remove: async (id): Promise<RemoteResult<ScheduleDeleteResult>> => {
        const result = await ctx.remote.schedule.edit({ id, action: 'delete' })
        if (!result.ok) return result
        return { ok: true, value: 'deleted' in result.value ? { id, deleted: true } : { id, deleted: false, code: 'schedule_not_found' } }
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
    yield ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'schedule.delete-toast', locale: MANAGER_NS,
      inject: () => ({ hooks: deleteToast.hooks, dismiss: deleteToast.dismiss }),
    }, ScheduleDeleteToast))
    // The Host answered, so this readback must not join a read that was sent
    // before it: naming every request seen so far makes the source issue a new
    // one, the way the post-deletion readback supersedes.
    const refresh = (): Promise<void> => manager.onRetry(manager.hooks.catalog.getSnapshot().readRequest)
    const openSession = (id: SessionId): void => {
      if (sessionLinkState(id, ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot()) === 'available') {
        ctx.uiWorkspace.openSession(id)
      }
    }
    /**
     * Remove every ended Host task and read the catalog back.
     *
     * The readback names every request seen so far, so it supersedes a read sent
     * before the removal instead of joining it.
     * @returns the settled bulk-removal outcome.
     */
    const clearEnded = createClearEnded({
      removeInactive: () => ctx.remote.schedule.deleteInactive(),
      refresh,
    })
    const detail: TaskDetailInjected & ScheduleTaskCatalogInjected = {
      hooks: manager.hooks,
      onDelete: reportedDelete(manager.onDelete),
      onRetry: manager.onRetry,
      loadHistory: request => ctx.remote.schedule.history(request),
      onOpenSession: openSession,
      hostActions: {
        edit: async (request) => {
          const result = await settle(() => ctx.remote.schedule.edit(request))
          if (result === undefined) return { failed: 'host.saveError' }
          if (!result.ok) return { failed: inputCorrection(result.error) ?? 'host.saveError' }
          await refresh()
          if (!('code' in result.value)) return 'saved'
          return { failed: result.value.code === 'schedule_conflict' ? 'host.conflict' : 'detail.missing' }
        },
        run: async (id) => {
          const result = await settle(() => ctx.remote.schedule.run({ id }))
          if (result === undefined || !result.ok) return { failed: 'host.runError' }
          await refresh()
          if (!('code' in result.value)) return 'queued'
          return { failed: result.value.code === 'schedule_execution_pending' ? 'host.executionPending' : 'detail.missing' }
        },
        loadNewSessionInterval: async () => {
          const result = await settle(() => ctx.remote.schedule.deliveryLimits())
          return result?.ok === true ? result.value.newSessionIntervalSeconds : undefined
        },
      },
    }
    // The Sidebar persists a tab's layout record and not its navigation
    // parameters, so this page type keeps the task it last showed per Session and
    // tab id. That Session's committed tab ids bound every write, so a closed tab
    // leaves no entry behind.
    const taskBindings = new TaskTabBindings(
      sessionId => ctx.sidebarRight.tabsIn(sessionId).map(tab => tab.id),
    )
    yield ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: SCHEDULE_TASK_ID,
      locale: MANAGER_NS,
      inject: (): ScheduleTaskTabInjected => ({ ...detail, taskBindings }),
    }, ScheduleTaskTab))
    yield ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: SCHEDULE_TASK_ID,
      locale: MANAGER_NS,
      inject: (): ScheduleTaskCatalogInjected & ScheduleTaskBindingInjected => ({ hooks: detail.hooks, taskBindings }),
    }, ScheduleTaskTabTitle))
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: MANAGER_NS,
      inject: (): TaskManagerInjected => ({
        ...detail,
        onNewTask: () => { ctx.uiWorkspace.startSession() },
        onClearEnded: async () => {
          const outcome = await clearEnded()
          deleteToast.reportClear(outcome)
        },
        onCreateTask: async (request) => {
          const result = await settle(() => ctx.remote.schedule.create(request))
          if (result === undefined) return { failed: 'host.createError' }
          if (!result.ok) return { failed: inputCorrection(result.error) ?? 'host.createError' }
          manager.retainCreated(result.value)
          await refresh()
          return { created: result.value }
        },
      }),
    }, TaskManagerPage))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 10,
      locale: MANAGER_NS,
      label: () => t('panel'),
    }, TaskManagerIcon))
    yield ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
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
    yield ctx.slots.inject(
      'conversation.session.header.utilities',
      () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'schedule-catalog',
        // Sits left of the overflow menu (order 0) and right of the header's
        // leading utilities (order -10), matching the shipped mock.
        order: -5,
        locale: NS,
        inject: sessionId => ({
          hooks: manager.hooks,
          onRetry: manager.onRetry,
          onDelete: detail.onDelete,
          openTaskDetail: (id: ScheduleId) => {
            ctx.sidebarRight.openTab(SCHEDULE_TASK_KIND, { params: { sessionId, id } })
          },
        }),
      }, ScheduleCatalogAction),
    )
    yield ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
      name: 'sidebar.session.row.leading',
      id: 'schedule-mark',
      order: 10,
      locale: NS,
      inject: () => ({ hooks: { catalog: manager.hooks.catalog } }),
    }, SessionScheduleMark))
    yield ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
      name: 'sidebar.session.row.hover',
      id: 'schedule-tasks',
      order: 10,
      locale: NS,
      inject: () => ({ hooks: { catalog: manager.hooks.catalog } }),
    }, SessionScheduleHover))
  })
}
