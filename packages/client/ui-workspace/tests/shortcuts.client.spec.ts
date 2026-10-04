/** Workspace commands capture their business target before the dispatcher executes them. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionForkError } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutCommand, ShortcutGesture, ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PanelInfo, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from '../src/client/shortcuts.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (value: string) => value as SessionId
const context = { region: 'page', modal: null, target: null } as const
const key = (code: string, rest: Partial<ShortcutGesture> = {}): ShortcutGesture => ({
  code, control: false, alt: false, shift: false, meta: true, repeat: false,
  composing: false, defaultPrevented: false, ...rest,
})
const row = (id: string, main = false): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, cwd: `/workspace/${id}`, blank: false,
  running: false, updatedAt: 0, retainedBy: main ? { mainView: 1 } : {},
})
async function bench(runtime: 'web' | 'desktop' = 'desktop', platform: ShortcutPlatform = 'macos') {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new ShortcutRegistry(runtime, platform)
  const commands = new Map<string, ShortcutCommand>()
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => {
    commands.set(command.id, command)
    return registry.register(command)
  }, catalog: registry.catalog })
  const list = createSnapshotStore<SessionListState>({
    ids: [sid('a'), sid('b')], byId: { [sid('a')]: row('a', true), [sid('b')]: row('b') },
    phase: 'ready', projectionsBySession: {},
  })
  const history = createSnapshotStore({ openState: 'open', hasMore: false, loadingOlder: false } as SessionSnapshot)
  const loadOlder = vi.fn(async () => {})
  const bindings = new Map(['a', 'b'].map(id => [sid(id), {
    sessionId: sid(id), session: { ...history, loadOlder },
  }]))
  ctx.provide('sessions', { list, binding: (id: SessionId) => bindings.get(id) })
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  ctx.provide('layout', { panelInfo })
  const directory = createSnapshotStore(true)
  ctx.provide('slots', { entries: () => directory.getSnapshot() ? [{}] : [], subscribe: (_name: string, listener: () => void) => directory.subscribe(listener) })
  const locale = new LocaleRuntime(ctx)
  locale.register('workspace', { en, zh })
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const navigation = {
    startSession: vi.fn(), forkSession: vi.fn(async () => 'fork-child' as SessionId), archiveSession: vi.fn(async (_sessionId: SessionId) => {}),
  }
  const controls = createWorkspaceShortcutControls()
  const fiber = ctx.plugin((scoped) => {
    installWorkspaceShortcuts(scoped, navigation, controls, (id) => { void navigation.archiveSession(id) })
  })
  await fiber.await()
  const select = (id: string) => { list.set({ ...list.getSnapshot(), byId: {
    [sid('a')]: row('a', id === 'a'), [sid('b')]: row('b', id === 'b'),
  } }) }
  return { ctx, fiber, registry, commands, navigation, controls, list, directory, select, history, loadOlder, panelInfo }
}

afterEach(() => { vi.restoreAllMocks() })

describe('workspace shortcut ownership', () => {
  it('refuses rename and archive without a selected Session and keeps a busy picker closed', async () => {
    const b = await bench()
    b.select('none')
    for (const id of ['session.rename', 'session.archive']) {
      expect(b.commands.get(id)!.resolve(context)).toMatchObject({ status: 'blocked', reason: en['shortcut.noSession'] })
    }
    b.controls.directoryBusy(true)
    b.controls.add()
    expect(b.controls.state.getSnapshot().addRequested).toBe(false)
  })
  it('registers six commands with Desktop and Web defaults and removes registrations with the plugin', async () => {
    const b = await bench()
    expect(b.registry.catalog.getSnapshot().map(row => row.id)).toEqual([
      'session.new', 'session.search', 'workspace.add', 'session.rename', 'session.fork', 'session.archive',
    ])
    expect(b.registry.catalog.getSnapshot().every(row => row.keys.length > 0)).toBe(true)
    const web = await bench('web')
    expect(web.registry.catalog.getSnapshot().map(row => row.aria)).toEqual([
      'Alt+Meta+N', 'Alt+Meta+K', 'Alt+Meta+O', 'Alt+Meta+G', 'Shift+Meta+F', 'Alt+Meta+A',
    ])
    await b.fiber.dispose()
    expect(b.registry.catalog.getSnapshot()).toEqual([])
  })

  it.each([
    { runtime: 'web', platform: 'macos' }, { runtime: 'web', platform: 'windows' },
    { runtime: 'desktop', platform: 'macos' }, { runtime: 'desktop', platform: 'windows' },
  ] as const)('uses the shared three-key rename binding on $runtime/$platform', async ({ runtime, platform }) => {
    const b = await bench(runtime, platform)
    const primary = { meta: platform === 'macos', control: platform === 'windows' }
    const consume = vi.fn()
    for (const shift of [false, true]) {
      expect(b.registry.dispatch(key('KeyR', { ...primary, shift }), context, consume)).toEqual({ status: 'pass' })
    }
    expect(consume).not.toHaveBeenCalled()
    expect(b.controls.state.getSnapshot().renameTarget).toBeNull()
    expect(b.registry.dispatch(key('KeyG', { ...primary, alt: true }), context, consume).status).toBe('handled')
    expect(b.controls.state.getSnapshot().renameTarget?.sessionId).toBe('a')
  })

  it.each(['web', 'desktop'] as const)('renames only a nonblank main Conversation without an obscuring modal on %s', async (runtime) => {
    const b = await bench(runtime)
    const gesture = key('KeyG', { alt: true })
    const invoke = (modal: string | null = null) => b.registry.dispatch(gesture, { ...context, modal }, vi.fn())
    b.list.set({ ...b.list.getSnapshot(), byId: { [sid('a')]: { ...row('a', true), blank: true } } })
    expect(invoke().status).toBe('blocked')
    expect(b.controls.state.getSnapshot().renameTarget).toBeNull()
    b.select('a')
    b.panelInfo.set({ activePanelId: 'plugins' as MainPanelId })
    expect(invoke().status).toBe('blocked')
    expect(b.controls.state.getSnapshot().renameTarget).toBeNull()
    b.panelInfo.set({ activePanelId: null })
    expect(invoke('settings').status).toBe('blocked')
    expect(b.controls.state.getSnapshot().renameTarget).toBeNull()
    expect(invoke().status).toBe('handled')
    expect(b.controls.state.getSnapshot().renameTarget?.sessionId).toBe('a')
  })

  it('uses the owner for new/search/add from terminals and modals while preserving repeat and directory occupancy', async () => {
    const b = await bench()
    const consume = vi.fn()
    expect(b.registry.dispatch(key('KeyN'), context, consume).status).toBe('handled')
    b.registry.dispatch(key('KeyN', { repeat: true }), context, consume)
    expect(b.navigation.startSession).toHaveBeenCalledOnce()
    expect(b.registry.dispatch(key('KeyN'), { ...context, modal: 'settings' }, consume).status).toBe('handled')
    expect(b.registry.dispatch(key('KeyN'), { ...context, region: 'terminal' }, consume).status).toBe('handled')
    expect(b.navigation.startSession).toHaveBeenCalledTimes(3)
    b.registry.dispatch(key('KeyK'), context, consume)
    expect(b.controls.state.getSnapshot().searchRequest).toBe(1)
    b.registry.dispatch(key('KeyO'), context, consume)
    expect(b.controls.state.getSnapshot().addRequested).toBe(true)
    b.controls.closeAdd()
    b.controls.directoryBusy(true)
    expect(b.registry.dispatch(key('KeyO'), context, consume).status).toBe('blocked')
    expect(b.controls.state.getSnapshot().addRequested).toBe(false)
    b.controls.directoryBusy(false)
    b.directory.set(false)
    expect(b.registry.dispatch(key('KeyO'), context, consume).status).toBe('blocked')
  })

  it('captures rename and archive targets while the main Session changes', async () => {
    const b = await bench()
    for (const command of ['session.rename', 'session.archive']) {
      b.select('a')
      const resolution = b.commands.get(command)!.resolve(context)
      b.select('b')
      expect(resolution.status).toBe('handled')
      if (resolution.status === 'handled') resolution.run()
    }
    expect(b.controls.state.getSnapshot().renameTarget).toEqual({ sessionId: 'a', currentTitle: 'a' })
    expect(b.navigation.archiveSession).toHaveBeenCalledWith('a')
  })

  it('leaves loaded history unchanged when commands mount, Sessions change, or Fork runs', async () => {
    const b = await bench()
    b.history.set({ ...b.history.getSnapshot(), hasMore: true })
    b.select('b')
    b.select('a')
    expect(b.registry.dispatch(key('KeyF', { alt: true }), context, vi.fn()).status).toBe('handled')
    await Promise.resolve()
    expect(b.loadOlder).not.toHaveBeenCalled()
    expect(b.navigation.forkSession).toHaveBeenCalledWith('a')
  })

  it('captures the source Session and lets the Host choose its last completed turn', async () => {
    const b = await bench()
    const resolution = b.commands.get('session.fork')!.resolve(context)
    b.select('b')
    if (resolution.status !== 'handled') throw new Error('nonblank Session was unavailable')
    resolution.run()
    expect(b.navigation.forkSession).toHaveBeenCalledWith('a')
  })

  it('blocks absent or blank Sessions and permits retry while running after the Host refuses a fork', async () => {
    const b = await bench()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    b.navigation.forkSession.mockRejectedValueOnce(new SessionForkError(
      new RemoteError('session/fork-unavailable', 'no completed turn', { sessionId: sid('a') }), sid('a'),
    ))
    const invoke = () => b.registry.dispatch(key('KeyF', { alt: true }), context, vi.fn())
    expect(invoke().status).toBe('handled')
    await vi.waitFor(() => { expect(b.controls.state.getSnapshot().forkError).toMatchObject({ reason: 'unavailable' }) })
    expect(warning).not.toHaveBeenCalled()
    b.controls.dismissForkError()
    b.navigation.forkSession.mockRejectedValueOnce(new Error('connection closed'))
    expect(invoke().status).toBe('handled')
    await vi.waitFor(() => { expect(b.controls.state.getSnapshot().forkError).toMatchObject({ reason: 'failed' }) })
    expect(warning).toHaveBeenCalledOnce()
    b.list.set({ ...b.list.getSnapshot(), byId: { [sid('a')]: { ...row('a', true), running: true } } })
    expect(invoke().status).toBe('handled')
    expect(b.navigation.forkSession).toHaveBeenCalledTimes(3)
    b.list.set({ ...b.list.getSnapshot(), byId: { [sid('a')]: { ...row('a', true), blank: true } } })
    expect(invoke()).toMatchObject({ status: 'blocked', reason: en['shortcut.noCompletedTurn'] })
    b.list.set({ ...b.list.getSnapshot(), byId: {} })
    expect(invoke()).toMatchObject({ status: 'blocked', reason: en['shortcut.noSession'] })
    expect(b.loadOlder).not.toHaveBeenCalled()
  })
})

it('opens an empty rename draft for unnamed history instead of its directory label', async () => {
  const b = await bench()
  const unnamed = row('a', true)
  delete unnamed.title
  unnamed.displayTitle = 'Default workspace'
  b.list.set({ ...b.list.getSnapshot(), byId: { [unnamed.id]: unnamed } })
  const command = b.commands.get('session.rename')!.resolve(context)
  expect(command.status).toBe('handled')
  if (command.status === 'handled') command.run()
  expect(b.controls.state.getSnapshot().renameTarget).toEqual({ sessionId: 'a', currentTitle: '' })
})
