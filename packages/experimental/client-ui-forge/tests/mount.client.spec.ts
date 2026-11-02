// @vitest-environment jsdom
/**
 * Forge panel registration: the Remote mount, slot entries, per-Session stores,
 * actions and their notices, the changes view, and unload.
 */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ChangeRequestSnapshot, ForgeReviewRequest, ForgeReviewResult } from '@deepseek-ai/dsh-experimental-forge/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionToast } from '../src/client/ActionToast.tsx'
import { CHANGES_ID, CHANGES_KIND } from '../src/client/changes-address.ts'
import { ChangesTab, type ChangesTabInjected } from '../src/client/ChangesTab.tsx'
import { ChangesTabTitle } from '../src/client/ChangesTabTitle.tsx'
import { ForgeTab, type ForgeTabInjected } from '../src/client/ForgeTab.tsx'
import { ForgeTabTitle } from '../src/client/ForgeTabTitle.tsx'
import { HeaderButton, type HeaderButtonInjected } from '../src/client/HeaderButton.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import { inject, mountForgePanel, TAB_ID, TAB_KIND } from '../src/client/mount.ts'
import type { SessionListInjected } from '../src/client/session-list.ts'
import { SessionHoverForge } from '../src/client/SessionHoverForge.tsx'
import { SessionRowForge } from '../src/client/SessionRowForge.tsx'
import type { NoticeSource } from '../src/client/source.ts'
import type { ReviewSelection } from '../src/client/review.ts'
import { WorktreeProgress, type WorktreeProgressInjected } from '../src/client/WorktreeProgress.tsx'
import { WorktreeToggle, type WorktreeToggleInjected } from '../src/client/WorktreeToggle.tsx'
import type {
  ForgeBranches, ForgeChangeRequestDiff, ForgeChangeRequestStatesFrame, ForgeLocalDiff, ForgeLocalScope, ForgePanelState,
} from '../src/types.ts'
import { entry, listState, ready, snapshot, unserved } from './client-fixtures.client.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-client-ui-forge', descriptors: [] }
const S1 = SessionId('s1')
const S2 = SessionId('s2')
const BRANCHES: ForgeBranches = { current: 'main', branches: ['main', 'release'] }
const LOCAL: ForgeLocalDiff = { base: 'origin/main', files: [], omitted: 0 }
const CHANGE: ForgeChangeRequestDiff = { headSha: 'a'.repeat(40), files: [], localAhead: null, fileUrls: {} }

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
})

/** A fake `follow` or `changeRequestStates` stream handle the test feeds by hand. */
function stream<F = ForgePanelState>(signal: AbortSignal) {
  const queue: F[] = []
  let wake: (() => void) | undefined
  let closed = false
  const handle = {
    signal,
    disposed: vi.fn(),
    push(frame: F) { queue.push(frame); wake?.() },
    dispose() { handle.disposed(); closed = true; wake?.() },
    async *[Symbol.asyncIterator](): AsyncIterator<F> {
      while (true) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        if (closed) return
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    },
  }
  return handle
}

const OK: RemoteResult<void> = { ok: true, value: undefined }

/** What a Remote read resolves to. */
type Read<T> = Promise<RemoteResult<T>>

const REFUSED = {
  started: { ok: false, error: new RemoteError('forgePanel/session-started', 'started', {}) },
  unavailable: { ok: false, error: new RemoteError('forgePanel/worktrees-unavailable', 'unavailable', {}) },
  busy: { ok: false, error: new RemoteError('forgePanel/session-busy', 'busy', {}) },
  restore: { ok: false, error: new RemoteError('forgePanel/restore-failed', 'fatal: \'/work/repo-dsh\' already exists', {}) },
  failed: { ok: false, error: new RemoteError('gateway/bad-request', 'failed', {}) },
  stale: { ok: false, error: new RemoteError('forgePanel/stale-head', 'Head branch was modified', {}) },
  refused: { ok: false, error: new RemoteError('forgePanel/action-failed', 'Pull Request is not mergeable', {}) },
} satisfies Record<string, RemoteResult<never>>

function isTabFace(value: Record<string, unknown>): value is Record<string, unknown> & ForgeTabInjected {
  return typeof value.reportVisible === 'function' && typeof value.copyText === 'function'
}

function isHeaderFace(value: Record<string, unknown>): value is Record<string, unknown> & HeaderButtonInjected {
  return typeof value.toggle === 'function' && typeof value.hooks === 'object'
}

function isWorktreeFace(value: Record<string, unknown>): value is Record<string, unknown> & WorktreeToggleInjected {
  return typeof value.request === 'function' && typeof value.branches === 'function'
}

function isProgressFace(value: Record<string, unknown>): value is Record<string, unknown> & WorktreeProgressInjected {
  return typeof value.stop === 'function' && typeof value.retry === 'function' && typeof value.withdraw === 'function'
    && typeof value.restore === 'function' && typeof value.leave === 'function'
}

function isChangesFace(value: Record<string, unknown>): value is Record<string, unknown> & ChangesTabInjected {
  return typeof value.localDiff === 'function' && typeof value.createChangeRequest === 'function'
}

function isListFace(value: Record<string, unknown>): value is Record<string, unknown> & SessionListInjected {
  return typeof value.hooks === 'object' && value.hooks !== null && 'states' in value.hooks
}

function isNoticeFace(value: Record<string, unknown>): value is Record<string, unknown> & Omit<NoticeSource, 'report'> {
  return typeof value.dismiss === 'function' && typeof value.hooks === 'object'
}

/** Let the Remote results that the actions await settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function base() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    $host: RemoteHostFacts = { home: '/home/octo', isLoopback: true }
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  const remote = new Remote()
  const streams: ReturnType<typeof stream>[] = []
  const stateStreams: ReturnType<typeof stream<ForgeChangeRequestStatesFrame>>[] = []
  const forgePanel = {
    follow: vi.fn((_sessionId: SessionId, signal: AbortSignal) => {
      const handle = stream(signal)
      streams.push(handle)
      return handle
    }),
    changeRequestStates: vi.fn((signal: AbortSignal) => {
      const handle = stream<ForgeChangeRequestStatesFrame>(signal)
      stateStreams.push(handle)
      return handle
    }),
    track: vi.fn(async (_sessionId: SessionId, _url: string): Promise<RemoteResult<void>> => OK),
    dismiss: vi.fn(async (_sessionId: SessionId, _url: string): Promise<RemoteResult<void>> => OK),
    markReady: vi.fn(async (_sessionId: SessionId, _url: string): Promise<RemoteResult<void>> => OK),
    merge: vi.fn(async (_sessionId: SessionId, _url: string, _method: string, _headSha: string): Promise<RemoteResult<void>> => OK),
    refresh: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    requestWorktree: vi.fn(async (_sessionId: SessionId, _from: string | null): Promise<RemoteResult<void>> => OK),
    cancelWorktree: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    stopCreation: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    retryWorktree: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    restoreWorktree: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    continueInProject: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    branches: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<ForgeBranches>> => ({ ok: true, value: BRANCHES })),
    localDiff: vi.fn(async (_sessionId: SessionId, _scope: ForgeLocalScope, _signal?: AbortSignal): Read<ForgeLocalDiff> =>
      ({ ok: true, value: LOCAL })),
    localText: vi.fn(async (_sessionId: SessionId, _scope: ForgeLocalScope, _path: string): Read<string> => ({ ok: true, value: 'a\n' })),
    changeRequestChecks: vi.fn(async (
      _sessionId: SessionId, _url: string, _headSha: string, _signal: AbortSignal,
    ): Read<ChangeRequestSnapshot> => ({ ok: true, value: snapshot(7) })),
    changeRequestDiff: vi.fn(async (_sessionId: SessionId, _url: string, _signal?: AbortSignal): Read<ForgeChangeRequestDiff> =>
      ({ ok: true, value: CHANGE })),
    changeRequestText: vi.fn(async (_sessionId: SessionId, _url: string, _commit: string, _path: string): Read<string> => ({ ok: true, value: 'b\n' })),
    submitReview: vi.fn(async (_sessionId: SessionId, _url: string, _request: ForgeReviewRequest): Read<ForgeReviewResult> => ({ ok: true, value: { ok: true, url: 'https://github.com/review' } })),
  }
  ctx.provide('remote.forgePanel', forgePanel)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const unregisterTab = vi.fn()
  const sidebarRightTabs = { register: vi.fn((_type: SidebarRightTabDefinition) => unregisterTab) }
  ctx.provide('sidebarRightTabs', sidebarRightTabs)
  const sidebarRight = { openTab: vi.fn(), toggleExpanded: vi.fn(), hide: vi.fn(),
    tabsIn: vi.fn(() => [{ id: 'forge-tab' as TabId, kind: TAB_KIND }]) }
  const scopes = new Map<SessionId, ReturnType<Context['plugin']>>()
  const sessions = { scope: vi.fn<(id: SessionId) => Context | undefined>((id) => {
    let fiber = scopes.get(id)
    if (fiber === undefined) { fiber = ctx.plugin(() => {}); scopes.set(id, fiber) }
    return fiber.ctx
  }) }
  ctx.provide('sessions', sessions)
  ctx.provide('sidebarRight', sidebarRight)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.hero.options': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.session.row.trailing': { kind: 'list', scope: 'root', inline: true },
      'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  return { ctx, remote, unmount, streams, stateStreams, forgePanel, sidebarRightTabs, unregisterTab, sidebarRight, sessions, scopes }
}

async function fixture() {
  const b = await base()
  let dispose: (() => Promise<void>) | undefined
  await b.ctx.plugin({ inject: [...inject], apply: async (plugin: Context) => { dispose = await mountForgePanel(plugin, REMOTE) } })
  assert(dispose !== undefined)
  const entry = (slot: Parameters<typeof b.ctx.slots.entries>[0], component: unknown) =>
    b.ctx.slots.entries(slot).find(candidate => candidate.component === component)
  const tabInject = entry('sidebar.right.pane.tab', ForgeTab)?.inject
  const changesInject = entry('sidebar.right.pane.tab', ChangesTab)?.inject
  const headerInject = entry('conversation.session.header.utilities', HeaderButton)?.inject
  const worktreeInject = entry('conversation.hero.options', WorktreeToggle)?.inject
  const progressInject = entry('conversation.input.dock', WorktreeProgress)?.inject
  const toastInject = entry('shell.overlay', ActionToast)?.inject
  const rowInject = entry('sidebar.session.row.trailing', SessionRowForge)?.inject
  const hoverInject = entry('sidebar.session.row.hover', SessionHoverForge)?.inject
  assert(tabInject !== undefined && headerInject !== undefined && worktreeInject !== undefined && toastInject !== undefined)
  assert(progressInject !== undefined && changesInject !== undefined && rowInject !== undefined && hoverInject !== undefined)
  const tab = (sessionId: SessionId): ForgeTabInjected => {
    const value = tabInject(sessionId as never)
    assert(isTabFace(value))
    return value
  }
  const changes = (sessionId: SessionId): ChangesTabInjected => {
    const value = changesInject(sessionId as never)
    assert(isChangesFace(value))
    return value
  }
  const header = (sessionId: SessionId): HeaderButtonInjected => {
    const value = headerInject(sessionId as never)
    assert(isHeaderFace(value))
    return value
  }
  const worktree = (sessionId: SessionId): WorktreeToggleInjected => {
    const value = worktreeInject(sessionId as never)
    assert(isWorktreeFace(value))
    return value
  }
  const progress = (sessionId: SessionId): WorktreeProgressInjected => {
    const value = progressInject(sessionId as never)
    assert(isProgressFace(value))
    return value
  }
  const toast = (): Omit<NoticeSource, 'report'> => {
    const value = toastInject(undefined as never)
    assert(isNoticeFace(value))
    return value
  }
  const notice = () => toast().hooks.notice.getSnapshot()
  const list = (place: 'row' | 'hover'): SessionListInjected => {
    const value = (place === 'row' ? rowInject : hoverInject)(undefined as never)
    assert(isListFace(value))
    return value
  }
  return { ...b, dispose, entry, tab, changes, header, worktree, progress, toast, notice, list }
}

describe('mountForgePanel registration', () => {
  it('routes complete check reads through the bound Session and propagates failures', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const url = 'https://github.com/octo/demo/pull/7'
    expect(await f.tab(S1).readChecks(url, 'a'.repeat(40), signal)).toEqual(snapshot(7))
    expect(f.forgePanel.changeRequestChecks).toHaveBeenCalledWith(S1, url, 'a'.repeat(40), signal)
    f.forgePanel.changeRequestChecks.mockResolvedValueOnce(REFUSED.failed)
    await expect(f.tab(S1).readChecks(url, 'a'.repeat(40), signal)).rejects.toThrow()
  })

  it('declares the browser services it needs', () => {
    expect(inject).toEqual(['remote', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions'])
  })

  it('registers the tab types, their bodies and titles, the header button, the worktree option and card, and the toast', async () => {
    const f = await fixture()
    expect(f.sidebarRightTabs.register).toHaveBeenCalledTimes(2)
    const type = f.sidebarRightTabs.register.mock.calls[0]?.[0]
    expect(type).toMatchObject({ id: TAB_ID, kind: TAB_KIND })
    expect([en['tab.title'], zh['tab.title']]).toContain(type?.title('sidebar://forge-panel'))
    expect(type?.guide).toHaveLength(1)
    expect([en['guide.title'], zh['guide.title']]).toContain(type?.guide?.[0]?.title())
    expect([en['guide.description'], zh['guide.description']]).toContain(type?.guide?.[0]?.description?.())
    expect(f.sidebarRightTabs.register.mock.calls[1]?.[0]).toMatchObject({ id: CHANGES_ID, kind: CHANGES_KIND })
    expect(f.entry('sidebar.right.pane.tab', ForgeTab)).toMatchObject({ options: { key: TAB_ID }, locale: NS })
    expect(f.entry('sidebar.right.pane.tab.title', ForgeTabTitle)).toMatchObject({ options: { key: TAB_ID }, locale: NS })
    expect(f.entry('sidebar.right.pane.tab', ChangesTab)).toMatchObject({ options: { key: CHANGES_ID }, locale: NS })
    expect(f.entry('sidebar.right.pane.tab', ChangesTab)?.store).toBeDefined()
    expect(f.entry('sidebar.right.pane.tab.title', ChangesTabTitle)).toMatchObject({ options: { key: CHANGES_ID }, locale: NS })
    expect(f.entry('conversation.session.header.utilities', HeaderButton)).toMatchObject({ options: { id: 'forge-panel', order: -8 }, locale: NS })
    // The branch is named in the tab and the Session list, not beside the Session title.
    expect(f.ctx.slots.entries('conversation.session.header.actions')).toEqual([])
    expect(f.entry('conversation.hero.options', WorktreeToggle)).toMatchObject({ options: { id: 'forge-panel.worktree' }, locale: NS })
    expect(f.entry('conversation.input.dock', WorktreeProgress)).toMatchObject({ options: { id: 'forge-panel.worktree', order: 5 }, locale: NS })
    expect(f.ctx.slots.entries('conversation.input.left')).toEqual([])
    expect(f.entry('shell.overlay', ActionToast)).toMatchObject({ options: { id: 'forge-panel.toast' }, locale: NS })
    expect(f.entry('sidebar.session.row.trailing', SessionRowForge)).toMatchObject({ options: { id: 'forge-panel.row', order: 10 }, locale: NS })
    expect(f.entry('sidebar.session.row.hover', SessionHoverForge)).toMatchObject({ options: { id: 'forge-panel.row', order: 20 }, locale: NS })
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it('withdraws every entry, closes the streams, and unmounts the Remote on unload', async () => {
    const f = await fixture()
    f.tab(S1).hooks.panel.subscribe(() => {})
    f.header(S2)
    f.list('row').hooks.states.subscribe(() => {})
    expect(f.streams).toHaveLength(1)
    expect(f.stateStreams).toHaveLength(1)

    await f.dispose()

    expect(f.streams[0]?.disposed).toHaveBeenCalled()
    expect(f.streams[0]?.signal.aborted).toBe(true)
    expect(f.stateStreams[0]?.disposed).toHaveBeenCalled()
    expect(f.stateStreams[0]?.signal.aborted).toBe(true)
    expect(f.unregisterTab).toHaveBeenCalled()
    expect(f.unmount).toHaveBeenCalledOnce()
    for (const [slot, component] of [
      ['sidebar.right.pane.tab', ForgeTab],
      ['sidebar.right.pane.tab.title', ForgeTabTitle],
      ['sidebar.right.pane.tab', ChangesTab],
      ['sidebar.right.pane.tab.title', ChangesTabTitle],
      ['conversation.session.header.utilities', HeaderButton],
      ['conversation.hero.options', WorktreeToggle],
      ['conversation.input.dock', WorktreeProgress],
      ['shell.overlay', ActionToast],
      ['sidebar.session.row.trailing', SessionRowForge],
      ['sidebar.session.row.hover', SessionHoverForge],
    ] as const) expect(f.entry(slot, component)).toBeUndefined()
    f.ctx.emit('connection/reset')
    expect(f.forgePanel.follow).toHaveBeenCalledOnce()
    expect(f.forgePanel.changeRequestStates).toHaveBeenCalledOnce()
  })

  it('unmounts the Remote when the UI registration fails', async () => {
    const b = await base()
    vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
    const fiber = b.ctx.plugin({ inject: [...inject], apply: (plugin: Context) => mountForgePanel(plugin, REMOTE) })
    await expect(fiber).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(b.unregisterTab).toHaveBeenCalled()
  })
})

describe('mountForgePanel Session list', () => {
  it('shares one change request state stream among every Session row and hover card while any of them reads it', async () => {
    const f = await fixture()
    const states = f.list('row').hooks.states
    expect(f.list('hover').hooks.states).toBe(states)
    expect(f.forgePanel.changeRequestStates).not.toHaveBeenCalled()

    const row = states.subscribe(() => {})
    const hover = states.subscribe(() => {})
    f.stateStreams[0]?.push({ type: 'baseline', states: [listState(1)] })
    await vi.waitFor(() => { expect([...states.getSnapshot().state.values()]).toEqual([listState(1)]) })
    row()
    expect(f.stateStreams[0]?.disposed).not.toHaveBeenCalled()
    hover()

    expect(f.forgePanel.changeRequestStates).toHaveBeenCalledOnce()
    expect(f.stateStreams[0]?.disposed).toHaveBeenCalled()
    expect(f.stateStreams[0]?.signal.aborted).toBe(true)
    await f.dispose()
  })
})

describe('mountForgePanel Session stores', () => {
  it('shares one panel stream per Session between the tab, the header button, the worktree option, and the worktree card', async () => {
    const f = await fixture()
    const tab = f.tab(S1)
    expect(f.header(S1).hooks.panel).toBe(tab.hooks.panel)
    expect(f.worktree(S1).hooks.panel).toBe(tab.hooks.panel)
    expect(f.progress(S1).hooks.panel).toBe(tab.hooks.panel)
    expect(f.tab(S2).hooks.panel).not.toBe(tab.hooks.panel)
    expect(f.forgePanel.follow).not.toHaveBeenCalled()

    const seen: unknown[] = []
    const unsubscribe = tab.hooks.panel.subscribe(() => { seen.push(tab.hooks.panel.getSnapshot().state) })
    expect(f.forgePanel.follow).toHaveBeenCalledWith(S1, expect.any(AbortSignal))
    f.streams[0]?.push(ready())
    await vi.waitFor(() => { expect(seen).toEqual([ready()]) })

    tab.reconnect()
    expect(f.forgePanel.follow).toHaveBeenCalledOnce()
    f.ctx.emit('connection/reset')
    expect(f.streams[0]?.disposed).toHaveBeenCalled()
    expect(f.forgePanel.follow).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(f.streams[1]?.disposed).toHaveBeenCalled()
    await f.dispose()
  })

  it('shares the Host facts between Sessions and reads them again after each reconnect', async () => {
    const f = await fixture()
    const host = f.tab(S1).hooks.host
    expect(f.tab(S2).hooks.host).toBe(host)
    expect(host.getSnapshot()).toEqual({ home: '/home/octo', isLoopback: true })
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)

    f.remote.$host = { home: '/home/other', isLoopback: false }
    f.ctx.emit('connection/reset')
    expect(listener).toHaveBeenCalledOnce()
    expect(host.getSnapshot()).toEqual({ home: '/home/other', isLoopback: false })
    unsubscribe()
    f.ctx.emit('connection/reset')
    expect(listener).toHaveBeenCalledOnce()
    await f.dispose()
  })

  it('releases a closed Session and recreates its shared state on reopen', async () => {
    const f = await fixture()
    const first = f.tab(S1)
    first.hooks.panel.subscribe(() => {})
    expect(f.header(S1).hooks.panel).toBe(first.hooks.panel)
    f.streams[0]!.push(ready({ changeRequests: [entry(1, snapshot(1))] }))
    await settle()
    await f.scopes.get(S1)!.dispose()
    f.scopes.delete(S1)
    expect(f.streams[0]!.signal.aborted).toBe(true)
    const next = f.tab(S1)
    expect(next.hooks.panel).not.toBe(first.hooks.panel)
    expect(next.hooks.panel.getSnapshot().state).toBeNull()
    expect(f.header(S1).hooks.panel).toBe(next.hooks.panel)
    next.hooks.panel.subscribe(() => {})
    expect(f.streams).toHaveLength(2)
    await f.dispose()
  })

  it('publishes the selected language and refuses state for a released Session', async () => {
    const f = await fixture()
    const locale = f.tab(S1).hooks.locale
    const changed = vi.fn()
    const unsubscribe = locale.subscribe(changed)
    f.ctx.locale.addLanguage({ id: 'de', label: 'Deutsch', fallback: 'en' })
    f.ctx.locale.setLocale('de')
    expect(locale.getSnapshot()).toBe('de')
    expect(f.ctx.locale.bind(NS)('header.label')).toBe('Änderungsanfragen dieser Sitzung')
    expect(f.ctx.locale.bind(NS)('change.mergeTitle', { name: '#7', base: 'main' })).toBe('#7 in main zusammenführen')
    expect(changed).toHaveBeenCalled()
    unsubscribe()
    f.sessions.scope.mockReturnValue(undefined)
    expect(() => f.tab(S2)).toThrow('is not retained')
    await f.dispose()
  })

  it('shares the tab visibility of a Session with its header entry', async () => {
    const f = await fixture()
    const visible = f.header(S1).hooks.visible
    const listener = vi.fn()
    visible.subscribe(listener)
    expect(visible.getSnapshot()).toBe(false)

    f.tab(S1).reportVisible(true)
    expect(visible.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(f.header(S2).hooks.visible.getSnapshot()).toBe(false)
    await f.dispose()
  })

  it('reveals the hidden tab from the header entry and collapses the sidebar showing it', async () => {
    const f = await fixture()
    f.header(S1).toggle(false)
    expect(f.sidebarRight.openTab).toHaveBeenCalledWith(TAB_KIND)
    expect(f.sidebarRight.toggleExpanded).not.toHaveBeenCalled()
    f.header(S1).toggle(true)
    expect(f.sidebarRight.hide).toHaveBeenCalledWith('forge-tab')
    expect(f.sidebarRight.openTab).toHaveBeenCalledOnce()
    f.sidebarRight.tabsIn.mockReturnValue([])
    f.header(S1).toggle(true)
    expect(f.sidebarRight.hide).toHaveBeenCalledOnce()
    await f.dispose()
  })
})

describe('mountForgePanel tab actions', () => {
  it('opens links outside the app', async () => {
    const f = await fixture()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    f.tab(S1).openLink('https://github.com/octo/demo/pull/1')
    expect(open).toHaveBeenCalledWith('https://github.com/octo/demo/pull/1', '_blank', 'noopener,noreferrer')
    await f.dispose()
  })

  it.each([
    ['confirms a completed copy', async () => {}, { key: 'toast.copied', tone: 'success' }],
    ['reports a refused copy', async () => { throw new Error('denied') }, { key: 'toast.copyFailed', tone: 'failure' }],
  ])('copies text to the clipboard and %s', async (_label, write, outcome) => {
    const f = await fixture()
    const writeText = vi.fn(async (_text: string) => { await write() })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    f.tab(S1).copyText('gh auth login --hostname github.com')
    await settle()

    expect(writeText).toHaveBeenCalledWith('gh auth login --hostname github.com')
    expect(f.notice()).toMatchObject({ ...outcome, params: {}, undo: undefined })
    await f.dispose()
  })

  it('copies a checkout path to the clipboard and confirms it', async () => {
    const f = await fixture()
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    f.tab(S1).copyPath('/work/repo-dsh')
    await settle()

    expect(writeText).toHaveBeenCalledWith('/work/repo-dsh')
    expect(f.notice()).toMatchObject({ key: 'toast.pathCopied', tone: 'success', params: {}, undo: undefined })
    await f.dispose()
  })

  it('refreshes through the Remote and reports only a failure', async () => {
    const f = await fixture()
    await f.tab(S1).refresh()
    expect(f.forgePanel.refresh).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()

    f.forgePanel.refresh.mockResolvedValueOnce(REFUSED.failed)
    await f.tab(S1).refresh()
    expect(f.notice()).toMatchObject({ key: 'toast.refreshFailed', tone: 'failure' })
    await f.dispose()
  })

  it('restores a removed worktree, confirming it or reporting why it failed until the notice is dismissed', async () => {
    const f = await fixture()
    f.tab(S1).restore()
    await settle()
    expect(f.forgePanel.restoreWorktree).toHaveBeenCalledWith(S1)
    expect(f.notice()).toMatchObject({ key: 'toast.restored', tone: 'success', seq: 1 })

    f.forgePanel.restoreWorktree.mockResolvedValueOnce(REFUSED.restore)
    f.tab(S1).restore()
    await settle()
    expect(f.notice()).toMatchObject({
      key: 'toast.restoreFailed', tone: 'failure', seq: 2, params: { message: 'fatal: \'/work/repo-dsh\' already exists' },
    })
    f.toast().dismiss()
    expect(f.notice()).toBeNull()
    await f.dispose()
  })
})

describe('mountForgePanel removal', () => {
  it('removes a change request and offers to restore it', async () => {
    const f = await fixture()
    const value = entry(7, snapshot(7))
    f.tab(S1).remove(value)
    await settle()
    expect(f.forgePanel.dismiss).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7')
    const removed = f.notice()
    expect(removed).toMatchObject({ key: 'toast.removed', tone: 'success', params: { name: '#7' } })

    removed?.undo?.()
    await settle()
    expect(f.forgePanel.track).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7')
    expect(f.notice()).toBe(removed)

    f.forgePanel.track.mockResolvedValueOnce(REFUSED.failed)
    removed?.undo?.()
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.undoFailed', tone: 'failure' })
    await f.dispose()
  })

  it.each([
    ['its URL when it has neither a number nor a snapshot', unserved('https://example.test/review/latest'),
      'https://example.test/review/latest'],
    ['its title when it has no number', { ...unserved('https://example.test/review/latest'), snapshot: snapshot(3) }, 'Change 3'],
    ['the number in its URL', unserved('https://example.test/review/17'), '#17'],
  ])('names a removed unserved change request by %s, without undo', async (_label, value, name) => {
    const f = await fixture()
    f.tab(S1).remove(value)
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.removed', tone: 'success', params: { name }, undo: undefined })
    await f.dispose()
  })

  it('reports a failed removal without offering undo', async () => {
    const f = await fixture()
    f.forgePanel.dismiss.mockResolvedValueOnce(REFUSED.failed)
    f.tab(S1).remove(entry(7, snapshot(7)))
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.removeFailed', tone: 'failure', params: {}, undo: undefined })
    await f.dispose()
  })
})

describe('mountForgePanel change request actions', () => {
  it.each([
    ['confirms it', OK, { key: 'toast.markedReady', tone: 'success', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused, { key: 'toast.markReadyFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
  ])('marks a draft ready through the Remote and %s', async (_label, result, notice) => {
    const f = await fixture()
    f.forgePanel.markReady.mockResolvedValueOnce(result)
    await f.tab(S1).markReady(entry(7, snapshot(7, { draft: true })))
    expect(f.forgePanel.markReady).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7')
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.merged', tone: 'success', params: { name: '#7' } }],
    ['says a moved head needs another look', REFUSED.stale, { key: 'toast.mergeStale', tone: 'failure', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused, { key: 'toast.mergeFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
  ])('merges through the Remote with the confirmed head and %s', async (_label, result, notice) => {
    const f = await fixture()
    f.forgePanel.merge.mockResolvedValueOnce(result)
    await f.tab(S1).merge(entry(7, snapshot(7)), { method: 'rebase', headSha: 'b'.repeat(40) })
    expect(f.forgePanel.merge).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', 'rebase', 'b'.repeat(40))
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })
})

describe('mountForgePanel worktree actions', () => {
  it('requests and withdraws a worktree through the Remote', async () => {
    const f = await fixture()
    const option = f.worktree(S1)
    expect(await option.request('release')).toBe(true)
    expect(await option.request(null)).toBe(true)
    expect(await option.cancel()).toBe(true)
    expect(f.forgePanel.requestWorktree.mock.calls).toEqual([[S1, 'release'], [S1, null]])
    expect(f.forgePanel.cancelWorktree).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it.each([
    ['a started Session', REFUSED.started, 'toast.worktreeStarted'],
    ['a missing worktree service', REFUSED.unavailable, 'toast.worktreeFailed'],
    ['any other failure', REFUSED.failed, 'toast.worktreeFailed'],
  ])('reports a request or withdrawal refused for %s', async (_label, refusal, key) => {
    const f = await fixture()
    const option = f.worktree(S1)
    f.forgePanel.requestWorktree.mockResolvedValueOnce(refusal)
    expect(await option.request('main')).toBe(false)
    expect(f.notice()).toMatchObject({ key, tone: 'failure', seq: 1 })
    f.forgePanel.cancelWorktree.mockResolvedValueOnce(refusal)
    expect(await option.cancel()).toBe(false)
    expect(f.notice()).toMatchObject({ key, tone: 'failure', seq: 2 })
    await f.dispose()
  })

  it('lists the branches of the Session checkout and reports when they cannot be read', async () => {
    const f = await fixture()
    expect(await f.worktree(S1).branches()).toEqual(BRANCHES)
    expect(f.forgePanel.branches).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()

    f.forgePanel.branches.mockResolvedValueOnce(REFUSED.failed)
    expect(await f.worktree(S1).branches()).toBeUndefined()
    expect(f.notice()).toMatchObject({ key: 'toast.branchesFailed', tone: 'failure' })
    await f.dispose()
  })
})

describe('mountForgePanel worktree card actions', () => {
  it.each([
    ['stops the attempt a message waits for', 'stop' as const, 'stopCreation' as const],
    ['makes another attempt for the waiting message', 'retry' as const, 'retryWorktree' as const],
    ['withdraws the request so the waiting message goes on', 'withdraw' as const, 'cancelWorktree' as const],
  ])('%s through the Remote and reports only a failure', async (_label, action, method) => {
    const f = await fixture()
    f.progress(S1)[action]()
    await settle()
    expect(f.forgePanel[method]).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()

    f.forgePanel[method].mockResolvedValueOnce(REFUSED.busy)
    f.progress(S1)[action]()
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.worktreeFailed', tone: 'failure' })
    await f.dispose()
  })

  it('restores a removed worktree through the Remote and confirms it', async () => {
    const f = await fixture()
    expect(await f.progress(S1).restore()).toBeUndefined()
    expect(f.forgePanel.restoreWorktree).toHaveBeenCalledWith(S1)
    expect(f.notice()).toMatchObject({ key: 'toast.restored', tone: 'success' })
    await f.dispose()
  })

  it('returns why a restore failed for the card to show, without a notice', async () => {
    const f = await fixture()
    f.forgePanel.restoreWorktree.mockResolvedValueOnce(REFUSED.restore)
    expect(await f.progress(S1).restore()).toBe('fatal: \'/work/repo-dsh\' already exists')
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it('continues in the project through the Remote and reports only a failure', async () => {
    const f = await fixture()
    f.progress(S1).leave()
    await settle()
    expect(f.forgePanel.continueInProject).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()

    f.forgePanel.continueInProject.mockResolvedValueOnce(REFUSED.busy)
    f.progress(S1).leave()
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.leaveFailed', tone: 'failure' })
    await f.dispose()
  })
})

describe('mountForgePanel changes view', () => {
  it('inserts numbered frozen quotes in the originating Session without sending a message', async () => {
    const f = await fixture()
    try {
      const selection: ReviewSelection = { source: { kind: 'local', scope: 'branch' }, comment: { path: 'a.ts', side: 'R', startLine: 1, endLine: 1, body: 'Check this', hunk: '@@ -1 +1 @@\n-old\n+new' } }
      const scope = f.sessions.scope(S1)!
      let draft = ''
      const focus = vi.fn(), send = vi.fn()
      const insertQuote = vi.fn((text: string) => { draft += `\n> ${text}`; return true })
      const input = { state: { getSnapshot: () => ({ draft }) }, insertQuote, focus }
      const resolve = vi.fn(() => input)
      // Only the input methods used by this contribution are supplied by the Session fixture.
      vi.spyOn(scope, 'get').mockImplementation(name => name === 'conversation' ? { input: { for: resolve }, send } as never : undefined)
      const view = f.changes(S1)
      expect(view.addReviewToInput(selection)).toBe(true)
      expect(view.addReviewToInput(selection)).toBe(true)
      expect(insertQuote.mock.calls.map(([text]) => text.split('\n')[0])).toEqual(['## User Comment 1', '## User Comment 2'])
      expect(resolve).toHaveBeenCalledWith(scope)
      expect(focus).toHaveBeenCalledTimes(2)
      insertQuote.mockReturnValueOnce(false)
      expect(view.addReviewToInput(selection)).toBe(false)
      expect(focus).toHaveBeenCalledTimes(2)
      expect(send).not.toHaveBeenCalled()
      const request: ForgeReviewRequest = { kind: 'review', headSha: 'a', event: 'comment', body: 'Summary', comments: [] }
      expect(await view.submitReview('https://github.com/pr', request)).toMatchObject({ ok: true, value: { ok: true } })
      expect(f.forgePanel.submitReview).toHaveBeenCalledWith(S1, 'https://github.com/pr', request)
    } finally { await f.dispose() }
  })
  it.each(['no scope', 'no conversation'] as const)('refuses a quote with %s', async (missing) => {
    const f = await fixture()
    try {
      const view = f.changes(S1)
      if (missing === 'no scope') f.sessions.scope.mockReturnValue(undefined)
      expect(view.addReviewToInput({ source: { kind: 'local', scope: 'branch' }, comment: { path: 'a', side: 'L', startLine: 1, endLine: 1, body: 'Comment', hunk: '' } })).toBe(false)
    } finally { await f.dispose() }
  })
  it('immediately closes an already-aborted occurrence and reports failed removal', async () => {
    const f = await fixture()
    try {
      const lifetime = new AbortController()
      lifetime.abort()
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('storage denied') })
      expect(f.changes(S1).reviewQueue({ id: 'closed' as TabId, signal: lifetime.signal }).getSnapshot().comments).toEqual([])
      expect(f.notice()).toMatchObject({ key: 'review.saveFailed' })
    } finally { await f.dispose() }
  })
  it.each(['local', 'change'] as const)('retains %s records across Session switches and clears only the closed tab', async (kind) => {
    const f = await fixture()
    const lifetime = new AbortController()
    const tab = { id: 'review-tab' as TabId, signal: lifetime.signal }
    const selection: ReviewSelection = { source: kind === 'local' ? { kind, scope: 'branch' }
      : { kind, url: 'https://github.com/octo/demo/pull/7', headSha: 'a'.repeat(40) },
    comment: { path: 'a.ts', side: 'R', startLine: 1, endLine: 1, body: 'Check this', hunk: '@@ -1 +1 @@\n-old\n+new' } }
    const queue = f.changes(S1).reviewQueue(tab)
    queue.recordAgent(selection)
    if (kind === 'change') queue.add(selection)
    queue.summarize('Summary', 'comment')
    const otherTab = { id: 'other-tab' as TabId, signal: new AbortController().signal }
    const other = f.changes(S1).reviewQueue(otherTab)
    other.recordAgent(selection)
    expect(f.changes(S2).reviewQueue({ id: tab.id, signal: new AbortController().signal }).getSnapshot().records).toEqual([])
    expect(f.changes(S1).reviewQueue(tab)).toBe(queue)
    expect(queue.getSnapshot().records).toHaveLength(1)
    lifetime.abort()
    expect(queue.getSnapshot()).toMatchObject({ comments: [], records: [], body: '', uncertain: null })
    expect(other.getSnapshot().records).toHaveLength(1)
    const reopened = f.changes(S1).reviewQueue({ id: tab.id, signal: new AbortController().signal })
    expect(reopened).not.toBe(queue)
    expect(reopened.getSnapshot()).toMatchObject({ comments: [], records: [], body: '' })
    expect(queue.recordAgent(selection)).toBe(false)
    await f.dispose()
  })
  it('reads the changes of the Session through the Remote and shares its panel stream', async () => {
    const f = await fixture()
    const view = f.changes(S1)
    expect(view.keyedHooks.panel('visible')).toBe(f.tab(S1).hooks.panel)
    expect(view.keyedHooks.panel('inactive')).toBeUndefined()
    const signal = new AbortController().signal
    expect(await view.localDiff({ kind: 'staged' }, signal)).toEqual({ ok: true, value: LOCAL })
    expect(await view.localText({ kind: 'staged' }, 'src/a.ts')).toEqual({ ok: true, value: 'a\n' })
    expect(await view.changeRequestDiff('https://github.com/octo/demo/pull/7', signal)).toEqual({ ok: true, value: CHANGE })
    expect(await view.changeRequestText('https://github.com/octo/demo/pull/7', 'a'.repeat(40), 'src/a.ts')).toEqual({ ok: true, value: 'b\n' })
    expect(f.forgePanel.localDiff).toHaveBeenCalledWith(S1, { kind: 'staged' }, signal)
    expect(f.forgePanel.localText).toHaveBeenCalledWith(S1, { kind: 'staged' }, 'src/a.ts')
    expect(f.forgePanel.changeRequestDiff).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', signal)
    expect(f.forgePanel.changeRequestText).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', 'a'.repeat(40), 'src/a.ts')
    view.reconnect()
    expect(f.forgePanel.follow).not.toHaveBeenCalled()
    await f.dispose()
  })

  it('opens links outside the app, reports what the view asks for, and copies paths', async () => {
    const f = await fixture()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    f.changes(S1).openLink('https://github.com/octo/demo/blob/main/a.ts')
    expect(open).toHaveBeenCalledWith('https://github.com/octo/demo/blob/main/a.ts', '_blank', 'noopener,noreferrer')
    f.changes(S1).report('toast.expandStale')
    expect(f.notice()).toMatchObject({ key: 'toast.expandStale', tone: 'failure', params: {} })
    f.changes(S1).report('toast.expandFailed', { message: 'gone' })
    expect(f.notice()).toMatchObject({ key: 'toast.expandFailed', tone: 'failure', params: { message: 'gone' } })

    f.changes(S1).report('review.submitted')
    expect(f.notice()).toMatchObject({ key: 'review.submitted', tone: 'success' })
    f.changes(S1).report('review.published')
    expect(f.notice()).toMatchObject({ key: 'review.published', tone: 'success' })

    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    f.changes(S1).copyPath('src/a.ts')
    await settle()
    expect(writeText).toHaveBeenCalledWith('src/a.ts')
    expect(f.notice()).toMatchObject({ key: 'toast.pathCopied', tone: 'success' })
    await f.dispose()
  })

  it('sends the request for a change request to the Session as a message and confirms it', async () => {
    const f = await fixture()
    const send = vi.fn(async (_text: string) => {})
    const scope = f.sessions.scope(S1)!
    vi.spyOn(scope, 'get').mockImplementation(name => name === 'conversation' ? { send } as never : undefined)
    f.changes(S1).createChangeRequest()
    await settle()
    const text = send.mock.calls[0]?.[0]
    expect([en['changes.local.prompt'], zh['changes.local.prompt']]).toContain(text)
    expect(f.notice()).toMatchObject({ key: 'toast.prompted', tone: 'success', params: { text } })

    send.mockRejectedValueOnce(new Error('rejected'))
    f.tab(S1).createChangeRequest()
    await settle()
    expect(send).toHaveBeenCalledTimes(2)
    expect(f.notice()).toMatchObject({ key: 'toast.promptFailed', tone: 'failure' })
    await f.dispose()
  })

  it.each(['no scope', 'no conversation'] as const)('reports a prompt failure with %s', async (missing) => {
    const f = await fixture()
    const view = f.changes(S1)
    if (missing === 'no scope') f.sessions.scope.mockReturnValue(undefined)
    else vi.spyOn(f.sessions.scope(S1)!, 'get').mockReturnValue(undefined)
    view.createChangeRequest()
    expect(f.notice()).toMatchObject({ key: 'toast.promptFailed', tone: 'failure' })
    await f.dispose()
  })
})
