import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { expect, it, vi } from 'vitest'
import { Config, liveConfig } from '../src/config.ts'
import { MINUTE_MS, TIMELINE_CONFIG_ID, minuteAt } from '../src/policy.ts'
import { taskId, treeId } from '../src/records.ts'
import { TIMELINE_CHANNEL, TIMELINE_LOCALE } from '../src/protocol.ts'
import { apply, inject } from '../src/client/index.ts'
import type { PanelInjected } from '../src/client/Panel.tsx'
import { editableSettings, type SettingsInjected } from '../src/client/Settings.tsx'
import type { TaskCardInjected } from '../src/client/TaskCard.tsx'
import type { TaskDockInjected } from '../src/client/TaskDock.tsx'
import { createSettingsStore, createViewStore } from '../src/client/store.ts'

const id = SessionId('mount')
const other = SessionId('other')
const next = SessionId('next')
const tree = treeId.parse('plan')
const task = taskId.parse('check')
const seats = [
  'tool.call.toolview', 'plugins.bundle.config', 'sidebar.right.pane.tab', 'conversation.input.dock',
] as const

it('mounts and disposes the Timeline surfaces with session-owned actions and settings', async () => {
  const ctx = new Context()
  vi.useFakeTimers()
  vi.setSystemTime(2000)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  try {
    const closeTab = vi.fn()
    const register = vi.fn((_tab: SidebarRightTabDefinition) => closeTab)
    const mounted = createSnapshotStore<SessionId | undefined>(other)
    const initial = createSnapshotStore<unknown>(undefined)
    const later = createSnapshotStore<unknown>({ trees: [] })
    const future = createSnapshotStore<unknown>({ trees: [] })
    const projections = new Map([[id, initial], [other, later], [next, future]])
    const binding = vi.fn((sessionId: SessionId) => {
      const projection = projections.get(sessionId)
      return projection === undefined ? undefined : { session: { projections: { faceOf: () => projection } } }
    })
    const sidebar = {
      mounted,
      isExpanded: vi.fn(() => true),
      active: vi.fn<() => { kind: string } | undefined>(() => ({ kind: 'timeline' })),
      toggleExpanded: vi.fn(),
      openTabIn: vi.fn(),
    }
    const using = vi.fn().mockRejectedValue(new Error('Open session for an edit'))
    const mutate = vi.fn().mockResolvedValue(true)
    const ready: ConfigFormSnapshot<Config> = {
      status: 'ready', value: liveConfig(Config()), revision: 7, writable: true, base: {}, user: {},
    }
    const loading: ConfigFormSnapshot<Config> = { ...ready, status: 'loading', value: undefined }
    const disabled = { ...ready, value: liveConfig(Config({ autoOpenSidebar: false })) }
    const form = createSnapshotStore(ready)
    const getForm = vi.fn(() => ({ ...form, mutate }))
    const locale = new LocaleRuntime(ctx, undefined, { languages: ['zh-CN'], preference: null })
    ctx.provide('locale', locale)
    ctx.provide('sidebarRight', sidebar as never)
    ctx.provide('sidebarRightTabs', { register } as never)
    ctx.provide('sessions', { using, binding } as never)
    const connection = createSnapshotStore<'connected' | 'disconnected'>('disconnected')
    const call = vi.fn().mockResolvedValue({ ok: true, value: null })
    ctx.provide('connection', { state: connection, rpc: { call } } as never)
    ctx.provide('configForms', { get: getForm } as never)
    ctx.provide('commandUi', {} as never)
    await ctx.plugin(SlotRegistry)
    ctx.slots.register({ name: 'root', children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    } } as never, () => null)
    const plugin = await ctx.plugin({ inject, apply })
    expect(call).not.toHaveBeenCalled()
    connection.set('connected')
    expect(call).toHaveBeenCalledExactlyOnceWith(TIMELINE_CHANNEL, TIMELINE_LOCALE, 'zh-CN', expect.any(AbortSignal))
    const unregister = locale.addLanguage({ id: 'it', label: 'Italiano', fallback: 'en' })
    expect(call).toHaveBeenCalledOnce()
    unregister()
    locale.setLocale('en')
    expect(call).toHaveBeenLastCalledWith(TIMELINE_CHANNEL, TIMELINE_LOCALE, 'en', expect.any(AbortSignal))
    connection.set('disconnected')
    call.mockRejectedValueOnce(new Error('Transport unavailable'))
    connection.set('connected')
    expect(call).toHaveBeenCalledTimes(3)
    expect(call).toHaveBeenLastCalledWith(TIMELINE_CHANNEL, TIMELINE_LOCALE, 'en', expect.any(AbortSignal))
    const entry = (slot: typeof seats[number]) => {
      const inject = ctx.slots.entries(slot)[0]?.inject
      assert(inject !== undefined)
      return inject
    }
    expect(getForm).toHaveBeenCalledWith(TIMELINE_CONFIG_ID)
    const tab = register.mock.calls[0]?.[0]
    expect(tab?.title('timeline')).toBe('Timeline')
    expect(tab?.guide?.[0]?.title()).toBe('Timeline')
    expect(tab?.guide?.[0]?.description?.()).toBeTruthy()

    const panel = entry('sidebar.right.pane.tab')(id as never) as Record<string, unknown> & PanelInjected
    ctx.emit('command/executed', id, 'other', { kind: 'success', text: '' })
    ctx.emit('command/executed', id, 'timeline', { kind: 'error', text: '' })
    expect(sidebar.openTabIn).not.toHaveBeenCalled()
    ctx.emit('command/executed', id, 'timeline', { kind: 'success', text: '' })
    expect(panel.hooks.selection.getSnapshot()).toBe(id)
    const otherPanel = entry('sidebar.right.pane.tab')(other as never) as Record<string, unknown> & PanelInjected
    otherPanel.consumeSelection()
    expect(panel.hooks.selection.getSnapshot()).toBe(id)
    panel.consumeSelection()
    expect(panel.hooks.selection.getSnapshot()).toBeNull()
    await vi.advanceTimersByTimeAsync(MINUTE_MS)
    expect(panel.hooks.clock.getSnapshot()).toBe(minuteAt(Date.now()))

    const edits = [
      panel.requestTask({ action: 'pause', tree: { id: tree, title: 'Plan' } }),
      panel.setPriority({ tree, task, priority: 'P0' }),
      panel.annotate({ id: 'note-one', target: { kind: 'tree', tree }, text: 'Continue checking.' }),
      panel.importTree({ id: 'import-one', content: '{}', copy: false, continue: false }),
      panel.removeTree(tree),
    ]
    for (const edit of edits) await expect(edit).rejects.toThrow('Open session for an edit')
    expect(using.mock.calls.every(call => call[0] === id)).toBe(true)

    const dock = entry('conversation.input.dock')(id as never) as Record<string, unknown> & TaskDockInjected
    sidebar.openTabIn.mockClear()
    mounted.set(undefined)
    mounted.set(SessionId('no-binding'))
    mounted.set(id)
    initial.set(null)
    initial.set({})
    initial.set({ trees: null })
    initial.set({ trees: [tree] })
    expect(sidebar.openTabIn).not.toHaveBeenCalled()
    mounted.set(other)
    sidebar.isExpanded.mockReturnValueOnce(false)
    later.set({ trees: [tree] })
    expect(sidebar.openTabIn).toHaveBeenCalledExactlyOnceWith(other, 'timeline')
    later.set({ trees: [tree, tree] })
    expect(sidebar.openTabIn).toHaveBeenCalledOnce()

    mounted.set(next)
    form.set(loading)
    future.set({ trees: [tree] })
    expect(sidebar.openTabIn).toHaveBeenCalledOnce()
    form.set(disabled)
    expect(sidebar.openTabIn).toHaveBeenCalledOnce()
    form.set(ready)
    expect(sidebar.openTabIn).toHaveBeenCalledOnce()

    mounted.set(id)
    future.set({ trees: [] })
    form.set(loading)
    mounted.set(next)
    future.set({ trees: [tree] })
    expect(sidebar.openTabIn).toHaveBeenCalledOnce()
    sidebar.isExpanded.mockReturnValueOnce(false)
    form.set(ready)
    expect(sidebar.openTabIn).toHaveBeenLastCalledWith(next, 'timeline')

    mounted.set(id)
    future.set({ trees: [] })
    form.set(loading)
    mounted.set(next)
    future.set({ trees: [tree] })
    future.set({ trees: [] })
    form.set(ready)
    expect(sidebar.openTabIn).toHaveBeenCalledTimes(2)

    mounted.set(id)
    future.set({ trees: [] })
    form.set(loading)
    mounted.set(next)
    future.set({ trees: [tree] })
    form.set({ ...loading, status: 'unavailable' })
    expect(sidebar.openTabIn).toHaveBeenCalledTimes(2)

    mounted.set(id)
    form.set(disabled)
    dock.toggleSidebar(true)
    expect(sidebar.toggleExpanded).toHaveBeenCalledOnce()
    dock.toggleSidebar(false)
    expect(sidebar.openTabIn).toHaveBeenLastCalledWith(id, 'timeline')
    await expect(dock.removeTree(tree)).rejects.toThrow('Open session for an edit')

    const view = createViewStore().create(id)
    const card = entry('tool.call.toolview')(id as never, view.actions as never) as Record<string, unknown> & TaskCardInjected
    card.openTask(tree, task)
    expect(view.getSnapshot().details.tasks[0]?.target).toEqual({ kind: 'task', tree, task })
    card.openTask(tree)
    expect(view.getSnapshot().details.tasks).toEqual([])
    const settings = entry('plugins.bundle.config')() as Record<string, unknown> & SettingsInjected
    const value = editableSettings(liveConfig(Config()))
    await expect(settings.save({ ...value, periods: [] }, 7)).resolves.toBe(false)
    expect(mutate).not.toHaveBeenCalled()
    await settings.save({ ...value, periods: [60000, 180000], autoOpenSidebar: false }, 7)
    expect(mutate).toHaveBeenCalledWith(expect.arrayContaining([
      { op: 'set', path: ['intervalMs'], value: 60000 },
      { op: 'set', path: ['rollupFactors'], value: [3] },
      { op: 'set', path: ['autoOpenSidebar'], value: false },
    ]), 7)
    const draft = createSettingsStore().create()
    draft.actions.update({ draft: value, revision: 7 })
    expect(draft.getSnapshot()).toMatchObject({ draft: value, revision: 7 })

    initial.set({ trees: [] })
    sidebar.openTabIn.mockClear()
    await plugin.dispose()
    initial.set({ trees: [tree] })
    expect(sidebar.openTabIn).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledOnce()
    for (const seat of seats) expect(ctx.slots.entries(seat)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await ctx.fiber.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

async function mountAtWidth(width: number) {
  const matchMedia = vi.fn((query: string) => ({ matches: width > 768 && query === '(width > 768px)' }))
  vi.stubGlobal('matchMedia', matchMedia)
  const ctx = new Context()
  const projection = createSnapshotStore<unknown>({ trees: [] })
  const sidebar = {
    mounted: createSnapshotStore<SessionId | undefined>(id),
    isExpanded: vi.fn(() => false),
    active: vi.fn(() => undefined),
    toggleExpanded: vi.fn(),
    openTabIn: vi.fn(),
  }
  const form = createSnapshotStore<ConfigFormSnapshot<Config>>({
    status: 'ready', value: liveConfig(Config()), revision: 1, writable: true, base: {}, user: {},
  })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('sidebarRightTabs', { register: () => () => undefined } as never)
  ctx.provide('sessions', { binding: () => ({ session: { projections: { faceOf: () => projection } } }) } as never)
  ctx.provide('connection', {
    state: createSnapshotStore<'connected' | 'disconnected'>('disconnected'),
    rpc: { call: vi.fn() },
  } as never)
  ctx.provide('configForms', { get: () => ({ ...form, mutate: vi.fn() }) } as never)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.input.dock': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  await ctx.plugin({ inject, apply })
  const dock = ctx.slots.entries('conversation.input.dock')[0]?.inject?.(id as never) as TaskDockInjected | undefined
  assert(dock !== undefined)
  return { ctx, matchMedia, projection, sidebar, dock }
}

it.each([700, 768])('leaves the sidebar closed at %i px and lets the dock open it', async (width) => {
  const { ctx, matchMedia, projection, sidebar, dock } = await mountAtWidth(width)
  try {
    projection.set({ trees: [tree] })
    expect(matchMedia).toHaveBeenCalledWith('(width > 768px)')
    expect(sidebar.openTabIn).not.toHaveBeenCalled()
    dock.toggleSidebar(false)
    expect(sidebar.openTabIn).toHaveBeenCalledExactlyOnceWith(id, 'timeline')
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  }
})

it('opens the sidebar for the first task tree where it sits beside the conversation', async () => {
  const { ctx, matchMedia, projection, sidebar } = await mountAtWidth(769)
  try {
    projection.set({ trees: [tree] })
    expect(matchMedia).toHaveBeenCalledWith('(width > 768px)')
    expect(sidebar.openTabIn).toHaveBeenCalledExactlyOnceWith(id, 'timeline')
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  }
})
