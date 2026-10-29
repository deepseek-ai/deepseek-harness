import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { resolveSlotLabel, type HostObservable, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { StaticRemoteAccess, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  ScheduleEditRequest, ScheduleEditResult, ScheduleId, ScheduleInputErrorCode, ScheduleRunRequest, ScheduleRunResult,
  ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleDeleteInactiveResult,
} from '@deepseek-ai/dsh-schedule/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { CatalogInjected } from '../src/client/catalog-source.ts'
import { ScheduleDeleteToast, type DeleteToastSource } from '../src/client/DeleteToast.tsx'
import { SCHEDULE_TASK_ID, SCHEDULE_TASK_KIND } from '../src/client/definition.ts'
import { ScheduleTaskTab, type ScheduleTaskBindingInjected, type ScheduleTaskCatalogInjected, type ScheduleTaskTabInjected } from '../src/client/ScheduleTaskTab.tsx'
import { ScheduleTaskTabTitle } from '../src/client/ScheduleTaskTabTitle.tsx'
import type { TaskManagerInjected } from '../src/client/TaskManagerPage.tsx'
import { ScheduleCatalogAction } from '../src/client/ScheduleCatalogAction.tsx'
import { SessionScheduleHover } from '../src/client/SessionScheduleHover.tsx'
import { SessionScheduleMark } from '../src/client/SessionScheduleMark.tsx'
import { ScheduleTurnCard, type ScheduleTurnCardInjected } from '../src/client/ScheduleTurnCard.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

const Empty = () => null

/** Raw inject face of an ambient row seat: the shared Host catalog observable. */
interface SessionCatalogFace {
  readonly hooks: { readonly catalog: HostObservable<unknown> }
}

function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.header.utilities')
    .map(entry => entry.options.id)
}

/** The right-Sidebar services `apply` registers into, replaced by spies. */
interface SidebarStubs {
  readonly openTab: Mock
  readonly register: Mock
  readonly tabsIn: Mock
}

/**
 * Read the object one slot entry's `inject` callback returned.
 *
 * A stored entry types that callback as returning a plain record, while the
 * plugin's own callback returns the face object the record carries; each case
 * below names the interface it reads from the object this returns.
 * @param entry - registered slot entry.
 * @param args - owner values the entry's scope passes to its callback.
 * @returns the injected face object.
 * @throws if the entry injected no face.
 */
function injectedFace(entry: StoredEntry, ...args: never[]): object {
  const face = entry.inject?.(...args)
  if (face === undefined) throw new Error('slot entry injected no face')
  return face
}

/**
 * Build the spies for the two right-Sidebar services `apply` requires.
 * @returns fresh spies for the tab registry, the navigation face, and one Session's committed tabs.
 */
function sidebarStubs(): SidebarStubs {
  return { openTab: vi.fn(), register: vi.fn(() => () => {}), tabsIn: vi.fn(() => [{ id: 'tab-1' }]) }
}

interface RemoteStubInput {
  schedule?: object
  $on: (event: 'schedule/changed', listener: () => void) => () => void
}

// A Service preserves the associated namespace lookup used by the real Gateway.
class RemoteStub extends Service {
  constructor(ctx: Context, readonly $on: RemoteStubInput['$on']) {
    super(ctx, 'remote')
  }
}

async function baseContext(
  remote: RemoteStubInput = { $on: () => () => {} },
  sidebar: SidebarStubs = sidebarStubs(),
  allows: (action: string) => boolean = () => true,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  new StaticRemoteAccess(ctx, allows)
  new UiConversation(ctx, { binding: () => undefined } as never)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  // `RemoteStub` registers the `remote` service itself, so this harness must not also
  // provide one: the second registration is rejected as a duplicate at <root>.
  new RemoteStub(ctx, remote.$on)
  await ctx.plugin({ apply(provider: Context) {
    provider.provide('remote.schedule', (remote.schedule ?? {}) as never)
  } }).await()
  ctx.provide('uiWorkspace', { openSession: vi.fn(), startSession: vi.fn() } as never)
  ctx.provide('sidebarRightTabs', { register: sidebar.register } as never)
  ctx.provide('sidebarRight', { openTab: sidebar.openTab, tabsIn: sidebar.tabsIn } as never)
  const id = 'cold-original' as SessionId
  const sessions: SessionListState = {
    ids: [id], byId: { [id]: { id, displayTitle: id, running: false, blank: false, updatedAt: 0, retainedBy: {} } },
    phase: 'ready', projectionsBySession: {},
  }
  const workspaces: WorkspaceSnapshot = { items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
  ctx.provide('sessions', {
    list: { getSnapshot: () => sessions, subscribe: () => () => {} },
    binding: () => undefined,
  } as never)
  ctx.provide('workspaces', { list: { getSnapshot: () => workspaces } } as never)
  ctx.provide('conversation', {} as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  return ctx
}

function declareHeader(ctx: Context): () => void {
  return ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, Empty)
}

function declareTranscriptSeats(ctx: Context): () => void {
  return ctx.slots.register({
    name: 'root',
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    },
  } as never, Empty)
}

type Entry = ScheduleCatalogEntry

const COLD_SESSION = 'cold-original' as SessionId

/** One active Host task delivered to the cold Session that the harness lists. */
const hostTask: Entry = { kind: 'rrule',
  id: 'host-task' as ScheduleId, title: 'Review deployment', prompt: 'Review deployment',
  rrule: 'DTSTART;TZID=UTC:20990101T000000\nRRULE:FREQ=DAILY;COUNT=1', scheduledAt: '2099-01-01T00:00:00.000Z',
  target: { kind: 'session', sessionId: COLD_SESSION }, involvedSessionIds: [COLD_SESSION], status: 'active',
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
}

/** Tasks page entry mounted over a Schedule Remote stub. */
interface HostPage {
  /** Face that the page entry injected. */
  readonly face: TaskManagerInjected
  /** Release the catalog subscription and the context. */
  readonly close: () => Promise<void>
}

/**
 * Mount the Tasks page entry over a Schedule Remote stub and settle its first catalog read.
 * @param schedule - Schedule Remote methods that the case stubs.
 * @returns the page face and its teardown.
 */
async function hostPage(schedule: object): Promise<HostPage> {
  const ctx = await baseContext({ schedule, $on: () => () => {} })
  ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } } as never, Empty)
  await ctx.plugin({ inject: [...inject], apply }).await()
  const face = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as TaskManagerInjected
  const dispose = face.hooks.catalog.subscribe(vi.fn())
  await face.onRetry()
  return {
    face,
    close: async () => {
      dispose()
      await ctx.fiber.dispose()
    },
  }
}

describe('ui-schedule browser half', () => {
  it('reads the configured delivery interval and contains Remote and transport failures', async () => {
    const deliveryLimits = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { newSessionIntervalSeconds: 7200 } })
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
      .mockRejectedValueOnce(new Error('Disconnected'))
    const ctx = await baseContext({ schedule: { deliveryLimits }, $on: () => () => {} })
    try {
      const owner = ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } } as never, Empty)
      try {
        await ctx.plugin({ inject: [...inject], apply }).await()
        const face = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as TaskManagerInjected
        await expect(face.hostActions.loadNewSessionInterval()).resolves.toBe(7200)
        await expect(face.hostActions.loadNewSessionInterval()).resolves.toBeUndefined()
        await expect(face.hostActions.loadNewSessionInterval()).resolves.toBeUndefined()
        expect(deliveryLimits).toHaveBeenCalledTimes(3)
      } finally { owner() }
    } finally { await ctx.fiber.dispose() }
  })

  it('declares only the services used by registration', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.schedule', 'conversation', 'uiConversation', 'uiWorkspace', 'sessions',
      'workspaces', 'sidebarRightTabs', 'sidebarRight', 'remoteAccess',
    ])
  })

  it('contributes its surfaces only while the current Peer may read the task catalog', async () => {
    for (const allowed of [false, true]) {
      const sidebar = sidebarStubs()
      const allows = vi.fn(() => allowed)
      const ctx = await baseContext(undefined, sidebar, allows)
      const header = declareHeader(ctx)
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      expect(allows).toHaveBeenCalledWith('schedule/catalog')
      // The Session-header reminder catalog is this plugin's entry point into the page.
      expect(headerEntryIds(ctx)).toEqual(allowed ? ['schedule-catalog'] : [])
      // The task tab type is a definition, registered either way.
      expect(sidebar.register).toHaveBeenCalledOnce()
      await fiber.dispose()
      header()
      await ctx.fiber.dispose()
    }
  })

  it('waits for the header declaration, orders between static context and Jobs, and tears down', async () => {
    const ctx = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(headerEntryIds(ctx)).toEqual([])

    const header = declareHeader(ctx)
    ctx.slots.register({
      name: 'conversation.session.header.utilities', id: 'agent-preset', order: -10,
    }, Empty)
    ctx.slots.register({
      name: 'conversation.session.header.utilities', id: 'job-list', order: 20,
    }, Empty)
    expect(headerEntryIds(ctx)).toEqual(['agent-preset', 'schedule-catalog', 'job-list'])

    await fiber.dispose()
    expect(headerEntryIds(ctx)).toEqual(['agent-preset', 'job-list'])
    header()
    await ctx.fiber.dispose()
  })

  it('shares catalog requests and invalidations across Session headers', async () => {
    const sessionId = 'catalog-session' as SessionId
    const id = 'catalog-reminder' as ScheduleId
    const list = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const remove = vi.fn().mockResolvedValue({ ok: true, value: { id, deleted: true } })
    let onChanged: (() => void) | undefined
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((event: string, listener: () => void) => {
      expect(event).toBe('schedule/changed')
      onChanged = listener
      return unsubscribe
    })
    const ctx = await baseContext({ schedule: { catalog: list, edit: remove }, $on: subscribe })
    declareHeader(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]!
    const face = injectedFace(entry, sessionId as never) as CatalogInjected
    const other = injectedFace(entry, 'other-session' as never) as CatalogInjected
    const dispose = face.hooks.catalog.subscribe(vi.fn())
    const disposeOther = other.hooks.catalog.subscribe(vi.fn())
    try {
      expect(other.hooks.catalog).toBe(face.hooks.catalog)
      await Promise.resolve()
      expect(list).toHaveBeenLastCalledWith()
      await vi.waitFor(() => { expect(face.hooks.catalog.getSnapshot().status).toBe('ready') })
      await face.onDelete(id)
      expect(remove).toHaveBeenCalledWith({ id, action: 'delete' })
      expect(list).toHaveBeenCalledTimes(2)
      onChanged!()
      await Promise.resolve()
      expect(list).toHaveBeenCalledTimes(3)
      ctx.emit('connection/reset')
      await Promise.resolve()
      expect(list).toHaveBeenCalledTimes(4)
      dispose()
      expect(unsubscribe).not.toHaveBeenCalled()
      disposeOther()
      expect(unsubscribe).toHaveBeenCalledOnce()
      ctx.emit('connection/reset')
      expect(list).toHaveBeenCalledTimes(4)
    } finally {
      dispose()
      disposeOther()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('registers the deletion notice on the frame overlay and reports each settled outcome into it', async () => {
    const id = 'toast-reminder' as ScheduleId
    const list = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const remove = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { id, deleted: true } })
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
      .mockResolvedValueOnce({ ok: true, value: { id, code: 'schedule_not_found' } })
    const ctx = await baseContext({ schedule: { catalog: list, edit: remove }, $on: () => () => {} })
    const owner = ctx.slots.register({
      name: 'root',
      children: {
        'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, Empty)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      const overlay = ctx.slots.entries('shell.overlay')[0]!
      expect(overlay.component).toBe(ScheduleDeleteToast)
      expect(overlay.options).toMatchObject({ id: 'schedule.delete-toast' })
      expect(overlay.locale).toBe('schedule.manager')
      const toast = injectedFace(overlay) as Omit<DeleteToastSource, 'report'>
      expect(toast.hooks.toast.getSnapshot()).toBeNull()

      const entry = ctx.slots.entries('conversation.session.header.utilities')[0]!
      const face = injectedFace(entry, 'toast-session' as never) as CatalogInjected
      const dispose = face.hooks.catalog.subscribe(vi.fn())
      try {
        // Both outcomes the header entry settles reach the one store its overlay
        // entry reads, in the order the deletions settled.
        await expect(face.onDelete(id)).resolves.toBe('deleted')
        expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'deleted', seq: 1 })
        await expect(face.onDelete(id)).resolves.toBe('failed')
        expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'deleteFailed', seq: 2 })
        await expect(face.onDelete(id)).resolves.toBe('deleted')
        expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'deleted', seq: 3 })
        toast.dismiss()
        expect(toast.hooks.toast.getSnapshot()).toBeNull()
      } finally {
        dispose()
      }
    } finally {
      await fiber.dispose()
      owner()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a catalog read when the namespace injection is deliberately omitted', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const ctx = await baseContext({ schedule: { catalog: list }, $on: () => () => {} })
    declareHeader(ctx)
    const fiber = ctx.plugin({ inject: inject.filter(key => key !== 'remote.schedule'), apply })
    await fiber.await()
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]!
    const face = injectedFace(entry, 'original' as never) as CatalogInjected
    const dispose = face.hooks.catalog.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(face.hooks.catalog.getSnapshot().status).toBe('error') })
      expect(list).not.toHaveBeenCalled()
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('registers the task tab type, its body, and its chip under one id', async () => {
    const sidebar = sidebarStubs()
    const ctx = await baseContext(undefined, sidebar)
    const owner = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
      },
    } as never, Empty)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      expect(sidebar.register).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: SCHEDULE_TASK_ID, kind: SCHEDULE_TASK_KIND, priority: 'builtin' }),
      )
      const body = ctx.slots.entries('sidebar.right.pane.tab')[0]!
      expect(body.component).toBe(ScheduleTaskTab)
      expect(body.options).toMatchObject({ key: SCHEDULE_TASK_ID })
      const title = ctx.slots.entries('sidebar.right.pane.tab.title')[0]!
      expect(title.component).toBe(ScheduleTaskTabTitle)
      expect(title.options).toMatchObject({ key: SCHEDULE_TASK_ID })
    } finally {
      await fiber.dispose()
      owner()
      await ctx.fiber.dispose()
    }
  })

  it('binds the shown task to the Session committed tabs and starts a new task from the panel', async () => {
    const sidebar = sidebarStubs()
    const ctx = await baseContext(undefined, sidebar)
    const owner = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
        main: { kind: 'keyed', scope: 'root' },
      },
    } as never, Empty)
    const startSession = vi.spyOn(ctx.uiWorkspace, 'startSession')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      const sessionId = 'bound-session' as SessionId
      const page = { id: 'tab-1', kind: SCHEDULE_TASK_KIND, contentId: SCHEDULE_TASK_ID }
      const body = injectedFace(
        ctx.slots.entries('sidebar.right.pane.tab')[0]!, sessionId as never,
      ) as ScheduleTaskTabInjected
      body.taskBindings.write(sessionId, page, { sessionId, id: 'bound-task' as ScheduleId })
      // A write reads the committed tab ids of the Session that owns the tab.
      expect(sidebar.tabsIn).toHaveBeenCalledWith(sessionId)
      expect(body.taskBindings.read(sessionId, page)).toEqual({ sessionId, id: 'bound-task' })
      // The chip reads the same binding and the same Host catalog as the body.
      const chip = injectedFace(
        ctx.slots.entries('sidebar.right.pane.tab.title')[0]!, sessionId as never,
      ) as ScheduleTaskCatalogInjected & ScheduleTaskBindingInjected
      expect(chip.taskBindings).toBe(body.taskBindings)
      expect(chip.hooks.catalog).toBe(body.hooks.catalog)
      const panel = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as TaskManagerInjected
      panel.onNewTask()
      expect(startSession).toHaveBeenCalledOnce()
    } finally {
      await fiber.dispose()
      owner()
      await ctx.fiber.dispose()
    }
  })

  it('opens the task tab with the entry Session and the chosen task id', async () => {
    const sidebar = sidebarStubs()
    const ctx = await baseContext(undefined, sidebar)
    declareHeader(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]!
    expect(entry.component).toBe(ScheduleCatalogAction)
    expect(entry.options).toMatchObject({ id: 'schedule-catalog' })
    const face = injectedFace(entry, 'catalog-session' as never) as { readonly openTaskDetail: (id: ScheduleId) => void }
    try {
      face.openTaskDetail('catalog-reminder' as ScheduleId)
      expect(sidebar.openTab).toHaveBeenCalledExactlyOnceWith(
        SCHEDULE_TASK_KIND, { params: { sessionId: 'catalog-session', id: 'catalog-reminder' } },
      )
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('renders the created task at Turn level and opens it in the call Session', async () => {
    const sidebar = sidebarStubs()
    const ctx = await baseContext(undefined, sidebar)
    const owner = declareTranscriptSeats(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      // The card is a Turn-tail element; the generic ui-tool detail card owns
      // the `tool.call.toolview` cell for `schedule_create`, so this plugin
      // registers no competing entry for that wire name.
      expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(0)
      const entry = ctx.slots.entries('conversation.chat.turnTail')[0]!
      expect(entry.component).toBe(ScheduleTurnCard)
      expect(entry.options).toMatchObject({ id: 'schedule-created', order: 20 })
      expect(entry.locale).toBe('schedule.manager')
      const face = injectedFace(entry, 'card-session' as never) as ScheduleTurnCardInjected
      face.openTaskDetail('created-reminder' as ScheduleId)
      expect(sidebar.openTab).toHaveBeenCalledExactlyOnceWith(
        SCHEDULE_TASK_KIND, { params: { sessionId: 'card-session', id: 'created-reminder' } },
      )
    } finally {
      await fiber.dispose()
      owner()
      await ctx.fiber.dispose()
    }
  })

  it('keeps an ended task in the global page, reads its history, opens its target Session, and deletes it by id', async () => {
    const record = hostTask
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [record] })
    const historyResult = { ok: true, value: {
      id: record.id, records: [], earlierRecordsUnavailable: false,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    } }
    const history = vi.fn().mockResolvedValue(historyResult)
    const remove = vi.fn().mockResolvedValue({ ok: true, value: { id: record.id, deleted: true } })
    let onChanged: (() => void) | undefined
    const ctx = await baseContext({ schedule: { catalog, history, edit: remove }, $on: (_event, listener) => {
      onChanged = listener
      return () => { onChanged = undefined }
    } })
    const openSession = vi.spyOn(ctx.uiWorkspace, 'openSession')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('main')).toEqual([])
    const owner = ctx.slots.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' },
      },
    } as never, Empty)
    const entry = ctx.slots.entries('main')[0]!
    expect(entry.options.key).toBe('schedules')
    const panel = ctx.slots.entries('sidebar.panellist')[0]!
    expect(panel.options.id).toBe('schedules')
    ctx.locale.setLocale('en')
    expect(resolveSlotLabel(panel.options.label)).toBe('Automation tasks')
    ctx.locale.setLocale('zh')
    expect(resolveSlotLabel(panel.options.label)).toBe('自动化任务')
    const face = injectedFace(entry, undefined as never) as TaskManagerInjected
    const dispose = face.hooks.catalog.subscribe(vi.fn())
    try {
      await vi.waitFor(() => { expect(face.hooks.catalog.getSnapshot().records).toEqual([record]) })
      const ended: Entry = { ...record, status: 'ended' }
      catalog.mockResolvedValue({ ok: true, value: [ended] })
      onChanged!()
      await vi.waitFor(() => { expect(face.hooks.catalog.getSnapshot().records).toEqual([ended]) })
      expect(remove).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      const request = { id: record.id, limit: 20 }
      expect(await face.loadHistory(request)).toBe(historyResult)
      expect(history).toHaveBeenCalledExactlyOnceWith(request)
      expect(openSession).not.toHaveBeenCalled()
      face.onOpenSession(COLD_SESSION)
      expect(openSession).toHaveBeenCalledWith(COLD_SESSION)
      const available = ctx.sessions.list.getSnapshot()
      const workspace = ctx.workspaces.list.getSnapshot()
      const sessionRead = vi.spyOn(ctx.sessions.list, 'getSnapshot')
      const workspaceRead = vi.spyOn(ctx.workspaces.list, 'getSnapshot')
      sessionRead.mockReturnValue({ ...available, phase: 'pending' })
      face.onOpenSession(COLD_SESSION)
      expect(openSession).toHaveBeenCalledTimes(1)
      sessionRead.mockReturnValue({ ...available, ids: [], byId: {} })
      face.onOpenSession(COLD_SESSION)
      expect(openSession).toHaveBeenCalledTimes(1)
      sessionRead.mockReturnValue(available)
      workspaceRead.mockReturnValue({ ...workspace, archivedSessionIds: [COLD_SESSION] })
      face.onOpenSession(COLD_SESSION)
      expect(openSession).toHaveBeenCalledTimes(1)
      workspaceRead.mockReturnValue(workspace)
      face.onOpenSession(COLD_SESSION)
      expect(openSession).toHaveBeenCalledTimes(2)
      catalog.mockResolvedValue({ ok: true, value: [] })
      await face.onDelete(record.id)
      expect(remove).toHaveBeenCalledWith({ id: record.id, action: 'delete' })
      expect(face.hooks.catalog.getSnapshot().records).toEqual([])
      await face.onDelete(record.id)
      expect(remove).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
      await fiber.dispose()
      expect(ctx.slots.entries('main')).toEqual([])
      expect(ctx.slots.entries('sidebar.panellist')).toEqual([])
      owner()
      await ctx.fiber.dispose()
    }
  })

  it('clears every ended task from the global page, reads the catalog back, and reports the count', async () => {
    const record: ScheduleCatalogEntry = {
      id: 'host-ended' as ScheduleId, status: 'ended',
      target: { kind: 'session', sessionId: 'cold-original' as SessionId }, involvedSessionIds: ['cold-original' as SessionId],
      kind: 'after', title: 'Ended review', prompt: 'Ended review', afterSeconds: 60,
      scheduledAt: '2099-01-01T00:00:00.000Z',
    }
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: [record] })
      .mockResolvedValue({ ok: true, value: [] })
    const deleteInactive = vi.fn().mockResolvedValue({ ok: true, value: { deleted: 1 } })
    const ctx = await baseContext({ schedule: { catalog, deleteInactive }, $on: () => () => {} })
    const owner = ctx.slots.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, Empty)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      const face = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as TaskManagerInjected
      const toast = injectedFace(ctx.slots.entries('shell.overlay')[0]!) as Omit<DeleteToastSource, 'report' | 'reportClear'>
      const dispose = face.hooks.catalog.subscribe(vi.fn())
      try {
        await vi.waitFor(() => { expect(face.hooks.catalog.getSnapshot().records).toEqual([record]) })
        const reads = catalog.mock.calls.length
        await face.onClearEnded()
        expect(deleteInactive).toHaveBeenCalledOnce()
        // The acknowledged removal reads the catalog back instead of joining a
        // read issued before it, so the page's rows follow the removal.
        expect(catalog.mock.calls.length).toBe(reads + 1)
        await vi.waitFor(() => { expect(face.hooks.catalog.getSnapshot().records).toEqual([]) })
        expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'cleared', count: 1, seq: 1 })
      } finally {
        dispose()
      }
    } finally {
      await fiber.dispose()
      owner()
      await ctx.fiber.dispose()
    }
  })

  it('reports a settled bulk removal after the page registration is gone', async () => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const removal = Promise.withResolvers<{ ok: true; value: ScheduleDeleteInactiveResult }>()
    const deleteInactive = vi.fn(() => removal.promise)
    const ctx = await baseContext({ schedule: { catalog, deleteInactive }, $on: () => () => {} })
    const owner = ctx.slots.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, Empty)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    let claimed = false
    try {
      const face = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as TaskManagerInjected
      const toast = injectedFace(ctx.slots.entries('shell.overlay')[0]!) as Omit<DeleteToastSource, 'report' | 'reportClear'>
      const clearing = face.onClearEnded()
      // The page panel can unmount while the Host removal is still in flight;
      // the notice store belongs to the plugin, so the outcome still publishes.
      owner()
      claimed = true
      removal.resolve({ ok: true, value: { deleted: 2 } })
      await clearing
      expect(toast.hooks.toast.getSnapshot()).toEqual({ kind: 'cleared', count: 2, seq: 1 })
    } finally {
      if (!claimed) owner()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('registers the row mark and hover-card seats under the Session row declarations', async () => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const ctx = await baseContext({ schedule: { catalog }, $on: () => () => {} })
    const owner = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
        main: { kind: 'keyed', scope: 'root' },
      },
    } as never, Empty)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      const mark = ctx.slots.entries('sidebar.session.row.leading')[0]!
      expect(mark.component).toBe(SessionScheduleMark)
      expect(mark.options).toMatchObject({ id: 'schedule-mark', order: 10 })
      expect(mark.locale).toBe(NS)
      const hover = ctx.slots.entries('sidebar.session.row.hover')[0]!
      expect(hover.component).toBe(SessionScheduleHover)
      expect(hover.options).toMatchObject({ id: 'schedule-tasks', order: 10 })
      expect(hover.locale).toBe(NS)
      // A root-scope list entry receives no owner values in `inject`. Both row
      // seats inject the one Host catalog the page reads, and neither creates a
      // per-Session Remote source, so N visible rows issue one query.
      const page = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as SessionCatalogFace
      for (const entry of [mark, hover]) {
        const face = injectedFace(entry) as SessionCatalogFace
        expect(face.hooks.catalog).toBe(page.hooks.catalog)
        expect(face).not.toHaveProperty('createSource')
      }
      await fiber.dispose()
      expect(ctx.slots.entries('sidebar.session.row.leading')).toEqual([])
      expect(ctx.slots.entries('sidebar.session.row.hover')).toEqual([])
    } finally {
      owner()
      await ctx.fiber.dispose()
    }
  })

  it('registers both dictionaries and releases them with its fiber', async () => {
    const ctx = await baseContext()
    declareHeader(ctx)
    ctx.locale.setLocale('zh')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const translate = ctx.locale.bind(NS)
    expect(translate('list.aria')).toBe(zh['list.aria'])
    ctx.locale.setLocale('en')
    expect(translate('list.aria')).toBe(en['list.aria'])
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())

    await fiber.dispose()
    expect(translate('list.aria')).not.toBe(en['list.aria'])
    await ctx.fiber.dispose()
  })
})

describe('Host task Remote injection', () => {
  const error = new RemoteError('gateway/internal', 'Storage unavailable', {})
  const edit: ScheduleEditRequest = {
    id: hostTask.id, action: 'update', patch: { title: 'Renamed' }, expectedUpdatedAt: hostTask.updatedAt ?? null,
  }
  const createRequest: ScheduleCreateRequest = {
    title: hostTask.title, prompt: hostTask.prompt, timing: { kind: 'rrule', rrule: 'rrule' in hostTask ? hostTask.rrule : '' }, target: { kind: 'session', sessionId: COLD_SESSION },
  }
  const refreshed: Entry = { ...hostTask, title: 'Renamed', updatedAt: '2026-10-01T00:00:00.000Z' }
  const refusal = (code: ScheduleInputErrorCode): RemoteResult<never> => ({
    ok: false, error: new RemoteError('schedule/input-invalid', 'Refused', { code }),
  })

  it.each([
    ['saved', { ok: true, value: refreshed }, 'saved'],
    ['conflict', { ok: true, value: { id: hostTask.id, code: 'schedule_conflict' } }, { failed: 'host.conflict' }],
    ['missing', { ok: true, value: { id: hostTask.id, code: 'schedule_not_found' } }, { failed: 'detail.missing' }],
  ] as const)('sends the edit unchanged and answers a %s reply once its readback settles', async (_name, reply, outcome) => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [hostTask] })
    const remoteEdit = vi.fn<(request: ScheduleEditRequest) => Promise<RemoteResult<ScheduleEditResult>>>().mockResolvedValue(reply)
    const { face, close } = await hostPage({ catalog, edit: remoteEdit })
    try {
      catalog.mockClear()
      const read = Promise.withResolvers<RemoteResult<Entry[]>>()
      catalog.mockReturnValueOnce(read.promise)
      const completion = vi.fn()
      const editing = face.hostActions.edit(edit).then((value) => { completion(); return value })
      // The Host answered, so the page reads again and answers only once that read publishes.
      await vi.waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
      expect(completion).not.toHaveBeenCalled()
      expect(face.hooks.catalog.getSnapshot().records).toEqual([hostTask])
      read.resolve({ ok: true, value: [refreshed] })
      expect(await editing).toEqual(outcome)
      expect(face.hooks.catalog.getSnapshot().records).toEqual([refreshed])
      // A failed readback keeps the last records and still answers what the Host said.
      catalog.mockRejectedValueOnce(error)
      expect(await face.hostActions.edit(edit)).toEqual(outcome)
      expect(face.hooks.catalog.getSnapshot()).toMatchObject({ records: [refreshed], status: 'error' })
      expect(remoteEdit.mock.calls[0]![0]).toBe(edit)
    } finally {
      await close()
    }
  })

  it.each([
    ['a past start', refusal('not_future'), 'host.notFuture', 'host.notFuture'],
    ['an invalid rule', refusal('invalid_rule'), 'host.invalidRule', 'host.invalidRule'],
    ['a rule that runs too often', refusal('frequency_too_high'), 'host.invalidRule', 'host.invalidRule'],
    ['an unknown time zone', refusal('invalid_time_zone'), 'host.invalidRule', 'host.invalidRule'],
    ['a time past the supported range', refusal('time_out_of_range'), 'host.invalidRule', 'host.invalidRule'],
    ['an invalid name or instruction', refusal('invalid_prompt'), 'host.saveError', 'host.createError'],
    ['a Remote failure', { ok: false, error }, 'host.saveError', 'host.createError'],
  ] as const)(
    'answers a refused edit or creation for %s with its correction and reads nothing',
    async (_reason, reply, saveFailure, createFailure) => {
      const catalog = vi.fn().mockResolvedValue({ ok: true, value: [hostTask] })
      const remoteEdit = vi.fn().mockResolvedValue(reply)
      const create = vi.fn().mockResolvedValue(reply)
      const { face, close } = await hostPage({ catalog, edit: remoteEdit, create })
      try {
        catalog.mockClear()
        expect(await face.hostActions.edit(edit)).toEqual({ failed: saveFailure })
        expect(await face.onCreateTask(createRequest)).toEqual({ failed: createFailure })
        expect(remoteEdit.mock.calls[0]![0]).toBe(edit)
        expect(create.mock.calls[0]![0]).toBe(createRequest)
        // The Host stored nothing, so the page keeps its records and sends no read.
        expect(catalog).not.toHaveBeenCalled()
        expect(face.hooks.catalog.getSnapshot().records).toEqual([hostTask])
      } finally {
        await close()
      }
    },
  )

  it.each([
    ['queued', { ok: true, value: refreshed }, 'queued'],
    ['pending', { ok: true, value: { id: hostTask.id, code: 'schedule_execution_pending' } }, { failed: 'host.executionPending' }],
    ['missing', { ok: true, value: { id: hostTask.id, code: 'schedule_not_found' } }, { failed: 'detail.missing' }],
  ] as const)('runs the task by id and answers a %s reply after its readback', async (_name, reply, outcome) => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [hostTask] })
    const run = vi.fn<(request: ScheduleRunRequest) => Promise<RemoteResult<ScheduleRunResult>>>().mockResolvedValue(reply)
    const { face, close } = await hostPage({ catalog, run })
    try {
      catalog.mockClear()
      catalog.mockResolvedValueOnce({ ok: true, value: [refreshed] })
      expect(await face.hostActions.run(hostTask.id)).toEqual(outcome)
      expect(run).toHaveBeenCalledExactlyOnceWith({ id: hostTask.id })
      expect(catalog).toHaveBeenCalledOnce()
      expect(face.hooks.catalog.getSnapshot().records).toEqual([refreshed])
    } finally {
      await close()
    }
  })

  it('answers a rejected call or a failed run with its retry and reads nothing', async () => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [hostTask] })
    const rejected = vi.fn().mockRejectedValue(new Error('Disconnected'))
    const run = vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce({ ok: false, error })
    const { face, close } = await hostPage({ catalog, edit: rejected, create: rejected, run })
    try {
      catalog.mockClear()
      expect(await face.hostActions.edit(edit)).toEqual({ failed: 'host.saveError' })
      expect(await face.onCreateTask(createRequest)).toEqual({ failed: 'host.createError' })
      expect(await face.hostActions.run(hostTask.id)).toEqual({ failed: 'host.runError' })
      expect(await face.hostActions.run(hostTask.id)).toEqual({ failed: 'host.runError' })
      expect(rejected).toHaveBeenCalledTimes(2)
      expect(run).toHaveBeenCalledTimes(2)
      expect(catalog).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('lists a created task before its readback and answers with that task', async () => {
    const created: Entry = { ...hostTask, id: 'created-task' as ScheduleId }
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [hostTask] })
    const create = vi.fn<(request: ScheduleCreateRequest) => Promise<RemoteResult<Entry>>>()
      .mockResolvedValue({ ok: true, value: created })
    const { face, close } = await hostPage({ catalog, create })
    try {
      catalog.mockClear()
      const read = Promise.withResolvers<RemoteResult<Entry[]>>()
      catalog.mockReturnValueOnce(read.promise)
      const creating = face.onCreateTask(createRequest)
      await vi.waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
      // The acknowledged task is on the page while the read that lists it is in flight.
      expect(face.hooks.catalog.getSnapshot().records).toEqual([hostTask, created])
      read.resolve({ ok: true, value: [hostTask, created] })
      expect(await creating).toEqual({ created })
      expect(face.hooks.catalog.getSnapshot()).toMatchObject({ records: [hostTask, created], status: 'ready' })
      expect(create.mock.calls[0]![0]).toBe(createRequest)
    } finally {
      await close()
    }
  })

  it('reads again for an accepted edit instead of joining the read in flight', async () => {
    const reply = Promise.withResolvers<RemoteResult<ScheduleEditResult>>()
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [hostTask] })
    const remoteEdit = vi.fn<(request: ScheduleEditRequest) => Promise<RemoteResult<ScheduleEditResult>>>()
      .mockReturnValue(reply.promise)
    const { face, close } = await hostPage({ catalog, edit: remoteEdit })
    try {
      catalog.mockClear()

      // A read is in flight when the edit is acknowledged, and that read was sent
      // before the write: the readback may not join it, or the row would come back
      // from the pre-write list. The read below is issued after the write resolves, so
      // the ordinal the receipt names is the one that read holds, and a refresh shares
      // only a read requested later than its ordinal. The case relies on the request
      // batch window still being open when the receipt resumes: the `await` below lets
      // the wrapper that contains rejected calls pass the answer on, so the edit
      // resumes before the microtask that closes the window the read below opens. The
      // sharing path itself is pinned at the source, in the catalog cases
      // `reuses the read in flight for a caller that has not seen it` and
      // `does not reuse a read issued before the caller’s ordinal`.
      const editing = face.hostActions.edit(edit)
      reply.resolve({ ok: true, value: refreshed })
      await Promise.resolve()
      const stale = Promise.withResolvers<RemoteResult<Entry[]>>()
      catalog.mockReturnValueOnce(stale.promise)
      const staleRequest = face.hooks.catalog.getSnapshot().readRequest + 1
      void face.onRetry()
      // Premise: one read is in flight, issued under `staleRequest`, with the write's
      // receipt queued behind it.
      expect(catalog).toHaveBeenCalledTimes(1)
      expect(face.hooks.catalog.getSnapshot())
        .toMatchObject({ status: 'loading', readRequest: staleRequest })

      // The read sent before the write settles here. A readback that joined it would
      // issue no second read and publish this pre-write list instead.
      catalog.mockResolvedValueOnce({ ok: true, value: [refreshed] })
      stale.resolve({ ok: true, value: [hostTask] })
      expect(await editing).toBe('saved')

      // The readback issued its own read under the next ordinal and published that
      // read's records, so the settled ordinal names the readback's request.
      expect(catalog).toHaveBeenCalledTimes(2)
      expect(face.hooks.catalog.getSnapshot()).toMatchObject({
        records: [refreshed], status: 'ready', readRequest: staleRequest + 1, readSettled: staleRequest + 1,
      })
    } finally {
      await close()
    }
  })
})

describe('ui-schedule node half', () => {
  it('keeps the node half inert', () => {
    expect(applyNode).not.toThrow()
  })
})
