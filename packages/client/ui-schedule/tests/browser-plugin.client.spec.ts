import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { resolveSlotLabel, type HostObservable, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ScheduleId, ScheduleCatalogEntry, ScheduleUpdateRequest, ScheduleUpdateResult } from '@deepseek-ai/dsh-schedule/client'
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
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
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

describe('ui-schedule browser half', () => {
  it('declares only the services used by registration', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.schedule', 'conversation', 'uiConversation', 'uiWorkspace', 'sessions',
      'workspaces', 'sidebarRightTabs', 'sidebarRight',
    ])
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

  it('binds catalog requests and invalidations to the header Session', async () => {
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
    const ctx = await baseContext({ schedule: { list, delete: remove }, $on: subscribe })
    declareHeader(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = ctx.slots.entries('conversation.session.header.utilities')[0]!
    const face = injectedFace(entry, sessionId as never) as CatalogInjected
    const dispose = face.hooks.catalog.subscribe(vi.fn())
    try {
      await Promise.resolve()
      expect(list).toHaveBeenLastCalledWith({ sessionId })
      expect(face.hooks.catalog.getSnapshot().status).toBe('ready')
      await face.onDelete(id)
      expect(remove).toHaveBeenCalledWith({ sessionId, id })
      expect(list).toHaveBeenCalledTimes(2)
      onChanged!()
      await Promise.resolve()
      expect(list).toHaveBeenCalledTimes(3)
      ctx.emit('connection/reset')
      await Promise.resolve()
      expect(list).toHaveBeenCalledTimes(4)
      dispose()
      expect(unsubscribe).toHaveBeenCalledOnce()
      ctx.emit('connection/reset')
      expect(list).toHaveBeenCalledTimes(4)
    } finally {
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
    const ctx = await baseContext({ schedule: { list, delete: remove }, $on: () => () => {} })
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
    const ctx = await baseContext({ schedule: { list }, $on: () => () => {} })
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
      // The panel starts a new reminder in a Session rather than opening a creation form.
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

  it('retains an ended task in the global page and navigates and deletes with its original Session binding', async () => {
    const record: ScheduleCatalogEntry = {
      id: 'host-task' as ScheduleId, sessionId: 'cold-original' as SessionId, status: 'active',
      kind: 'after', title: 'Review deployment', prompt: 'Review deployment', afterSeconds: 60,
      scheduledAt: '2099-01-01T00:00:00.000Z',
    }
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [record] })
    const historyResult = { ok: true, value: {
      id: record.id, records: [], earlierRecordsUnavailable: false,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    } }
    const history = vi.fn().mockResolvedValue(historyResult)
    const remove = vi.fn().mockResolvedValue({ ok: true, value: { id: record.id, deleted: true } })
    let onChanged: (() => void) | undefined
    const ctx = await baseContext({ schedule: { catalog, history, delete: remove }, $on: (_event, listener) => {
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
      const ended: ScheduleCatalogEntry = { ...record, status: 'inactive' }
      catalog.mockResolvedValue({ ok: true, value: [ended] })
      onChanged!()
      await vi.waitFor(() => { expect(face.hooks.catalog.getSnapshot().records).toEqual([ended]) })
      expect(remove).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      const request = { id: record.id, sessionId: record.sessionId, limit: 20 }
      expect(await face.loadHistory(request)).toBe(historyResult)
      expect(history).toHaveBeenCalledExactlyOnceWith(request)
      expect(openSession).not.toHaveBeenCalled()
      face.onOpenSession(record.sessionId)
      expect(openSession).toHaveBeenCalledWith(record.sessionId)
      const available = ctx.sessions.list.getSnapshot()
      const workspace = ctx.workspaces.list.getSnapshot()
      const sessionRead = vi.spyOn(ctx.sessions.list, 'getSnapshot')
      const workspaceRead = vi.spyOn(ctx.workspaces.list, 'getSnapshot')
      sessionRead.mockReturnValue({ ...available, phase: 'pending' })
      face.onOpenSession(record.sessionId)
      expect(openSession).toHaveBeenCalledTimes(1)
      sessionRead.mockReturnValue({ ...available, ids: [], byId: {} })
      face.onOpenSession(record.sessionId)
      expect(openSession).toHaveBeenCalledTimes(1)
      sessionRead.mockReturnValue(available)
      workspaceRead.mockReturnValue({ ...workspace, archivedSessionIds: [record.sessionId] })
      face.onOpenSession(record.sessionId)
      expect(openSession).toHaveBeenCalledTimes(1)
      workspaceRead.mockReturnValue(workspace)
      face.onOpenSession(record.sessionId)
      expect(openSession).toHaveBeenCalledTimes(2)
      catalog.mockResolvedValue({ ok: true, value: [] })
      await face.onDelete(record.id)
      expect(remove).toHaveBeenCalledWith({ sessionId: record.sessionId, id: record.id })
      expect(face.hooks.catalog.getSnapshot().records).toEqual([])
      await face.onDelete(record.id)
      expect(remove).toHaveBeenCalledTimes(1)
    } finally {
      dispose()
      await fiber.dispose()
      expect(ctx.slots.entries('main')).toEqual([])
      expect(ctx.slots.entries('sidebar.panellist')).toEqual([])
      owner()
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

describe('task timing Remote injection', () => {
  it.each(['saved', 'noop', 'conflict', 'ended', 'missing', 'invalid', 'remote', 'reject'] as const)(
    'preserves the exact request and refreshes only acknowledged or stale %s results', async (mode) => {
      const record: ScheduleCatalogEntry = {
        id: 'timing' as ScheduleId, sessionId: 'cold-original' as SessionId, status: 'active', kind: 'every',
        title: 'Original instruction', prompt: 'Original instruction', everySeconds: 301,
        scheduledAt: '2099-01-01T00:00:00.000Z',
      }
      const expected = {
        id: record.id, kind: 'every' as const, title: record.title, prompt: record.prompt,
        everySeconds: 301, scheduledAt: record.scheduledAt,
      }
      const request: ScheduleUpdateRequest = {
        sessionId: record.sessionId, id: record.id, expected, change: { kind: 'every', every_seconds: 601 },
      }
      const error = new RemoteError('gateway/internal', 'Storage unavailable', {})
      const replies: Record<Exclude<typeof mode, 'reject'>, RemoteResult<ScheduleUpdateResult>> = {
        saved: { ok: true, value: { id: record.id, updated: true, record: { ...expected, everySeconds: 601 } } },
        noop: { ok: true, value: { id: record.id, updated: false, record: expected } },
        conflict: { ok: true, value: { id: record.id, updated: false, code: 'schedule_conflict' } },
        ended: { ok: true, value: { id: record.id, updated: false, code: 'schedule_ended' } },
        missing: { ok: true, value: { id: record.id, updated: false, code: 'schedule_not_found' } },
        invalid: { ok: true, value: { code: 'invalid_rule', message: 'Invalid' } },
        remote: { ok: false, error },
      }
      const catalog = vi.fn().mockResolvedValue({ ok: true, value: [record] })
      const update = vi.fn<(input: ScheduleUpdateRequest) => Promise<RemoteResult<ScheduleUpdateResult>>>()
      if (mode === 'reject') update.mockRejectedValue(error)
      else update.mockResolvedValue(replies[mode])
      const ctx = await baseContext({ schedule: { catalog, update }, $on: () => () => {} })
      ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } } as never, Empty)
      await ctx.plugin({ inject: [...inject], apply }).await()
      const face = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as TaskManagerInjected
      const dispose = face.hooks.catalog.subscribe(vi.fn())
      try {
        await face.onRetry()
        catalog.mockClear()
        const refreshed = { ...record, everySeconds: 601, scheduledAt: '2099-02-03T04:05:06.789Z' }
        const read = Promise.withResolvers<RemoteResult<ScheduleCatalogEntry[]>>()
        catalog.mockReturnValue(read.promise)
        const completion = vi.fn()
        const updating = face.onUpdateTiming(request).then((value) => { completion(); return value })
        if (mode === 'reject') {
          await expect(updating).rejects.toBe(error)
          expect(catalog).not.toHaveBeenCalled()
        } else if (mode === 'invalid' || mode === 'remote') {
          expect(await updating).toBe(replies[mode])
          expect(catalog).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() => { expect(catalog).toHaveBeenCalledOnce() })
          expect(completion).not.toHaveBeenCalled()
          expect(face.hooks.catalog.getSnapshot().records).toEqual([record])
          read.resolve({ ok: true, value: [refreshed] })
          expect(await updating).toBe(replies[mode])
          expect(face.hooks.catalog.getSnapshot().records).toEqual([refreshed])
          catalog.mockRejectedValueOnce(error)
          expect(await face.onUpdateTiming(request)).toBe(replies[mode])
          expect(face.hooks.catalog.getSnapshot()).toMatchObject({ records: [refreshed], status: 'error' })
        }
        expect(update.mock.calls[0]![0]).toBe(request)
      } finally {
        dispose()
        await ctx.fiber.dispose()
      }
    },
  )

  it('reads again for an accepted update instead of joining the read in flight', async () => {
    const record: ScheduleCatalogEntry = {
      id: 'timing' as ScheduleId, sessionId: 'cold-original' as SessionId, status: 'active', kind: 'every',
      title: 'Original instruction', prompt: 'Original instruction', everySeconds: 301,
      scheduledAt: '2099-01-01T00:00:00.000Z',
    }
    const expected = {
      id: record.id, kind: 'every' as const, title: record.title, prompt: record.prompt,
      everySeconds: 301, scheduledAt: record.scheduledAt,
    }
    const request: ScheduleUpdateRequest = {
      sessionId: record.sessionId, id: record.id, expected, change: { kind: 'every', every_seconds: 601 },
    }
    const accepted: RemoteResult<ScheduleUpdateResult> = {
      ok: true, value: { id: record.id, updated: true, record: { ...expected, everySeconds: 601 } },
    }
    const reply = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: [record] })
    const update = vi.fn<(input: ScheduleUpdateRequest) => Promise<RemoteResult<ScheduleUpdateResult>>>()
      .mockReturnValue(reply.promise)
    const ctx = await baseContext({ schedule: { catalog, update }, $on: () => () => {} })
    ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } } as never, Empty)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as TaskManagerInjected
    const dispose = face.hooks.catalog.subscribe(vi.fn())
    try {
      await face.onRetry()
      catalog.mockClear()

      // A read is in flight when the update is acknowledged, and that read was sent
      // before the write: the readback may not join it, or the row would come back
      // from the pre-write list. The read below is issued after the write resolves, so
      // the ordinal the receipt names is the one that read holds, and a refresh shares
      // only a read requested later than its ordinal. The case relies on the request
      // batch window still being open when the receipt resumes - the write queues the
      // receipt before the read below is issued, so its microtask runs first - and the
      // sharing path itself is pinned at the source, in the catalog cases
      // `reuses the read in flight for a caller that has not seen it` and
      // `does not reuse a read issued before the caller’s ordinal`.
      const updating = face.onUpdateTiming(request)
      const stale = Promise.withResolvers<RemoteResult<ScheduleCatalogEntry[]>>()
      const fresh = { ...record, everySeconds: 601 }
      catalog.mockReturnValueOnce(stale.promise)
      reply.resolve(accepted)
      const staleRequest = face.hooks.catalog.getSnapshot().readRequest + 1
      void face.onRetry()
      // Premise: one read is in flight, issued under `staleRequest`, with the write's
      // receipt queued behind it.
      expect(catalog).toHaveBeenCalledTimes(1)
      expect(face.hooks.catalog.getSnapshot())
        .toMatchObject({ status: 'loading', readRequest: staleRequest })

      // The read sent before the write settles here. A readback that joined it would
      // issue no second read and publish this pre-write list instead.
      catalog.mockResolvedValueOnce({ ok: true, value: [fresh] })
      stale.resolve({ ok: true, value: [record] })
      await updating

      // The readback issued its own read under the next ordinal and published that
      // read's records, so the settled ordinal names the readback's request.
      expect(catalog).toHaveBeenCalledTimes(2)
      expect(face.hooks.catalog.getSnapshot()).toMatchObject({
        records: [fresh], status: 'ready', readRequest: staleRequest + 1, readSettled: staleRequest + 1,
      })
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('ui-schedule node half', () => {
  it('keeps the node half inert', () => {
    expect(applyNode).not.toThrow()
  })
})
