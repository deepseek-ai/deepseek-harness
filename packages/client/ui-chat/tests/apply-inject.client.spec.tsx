// @vitest-environment jsdom
/** Chat inject factories exercised over independently mounted Conversation and Chat plugins. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ISession, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import {
  apply as applyConversation, inject as injectConversation,
  type GroupKey,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat, type ChatViewInjected,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createChatStore } from '../src/client/stores.ts'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'
import type { LinkOpeningRowInjected } from '../src/client/settings/LinkOpeningRow.tsx'

usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId
const ATTACHMENT = {
  attachmentId: AttachmentId('image-1'),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
} as const

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>
type ChatActions = ChatInstance['actions']

function sessionFakeFor() {
  return {
    loadOlder: vi.fn<ISession['loadOlder']>(() => Promise.resolve()),
    loadThrough: vi.fn<ISession['loadThrough']>(() => Promise.resolve()),
    readAttachment: vi.fn<ISession['readAttachment']>(() => Promise.resolve({
      ok: true,
      value: { attachment: ATTACHMENT, data: Uint8Array.of(1) },
    })),
    prompt: vi.fn<ISession['prompt']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
  } satisfies SessionBehaviorOverrides
}

async function bench(initialSettings?: ChatSettings, withBrowserRegistry = true, withProcessGroups = true) {
  const runtime = await SlotTestRuntime.create()
  const chatSettings = stubConfigForm<ChatSettings>()
  if (initialSettings !== undefined) chatSettings.publish({ value: initialSettings })
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (id: string) => id === CHAT_SETTINGS_NAMESPACE ? chatSettings.scope : stubConfigForm().scope,
  } as never)
  const layout = { closeRightbar: vi.fn(), openRightbar: vi.fn() }
  runtime.ctx.provide('layout', layout as never)
  const sidebarRight = {
    openResource: vi.fn<(address: string) => void>(),
    openTab: vi.fn<(kind: string, options?: unknown) => void>(),
  }
  runtime.ctx.provide('sidebarRight', sidebarRight as never)
  const browserAvailable = createSnapshotStore(true)
  const sidebarRightTabs = {
    get: vi.fn<(kind: string) => object | undefined>(() => browserAvailable.getSnapshot() ? {} : undefined),
    subscribe: (listener: () => void) => browserAvailable.subscribe(listener),
    register: vi.fn(() => () => {}),
  }
  if (withBrowserRegistry) runtime.ctx.provide('sidebarRightTabs', sidebarRightTabs as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  const openWorkspacePath = vi.fn<ClientRemote['session']['openWorkspacePath']>(
    () => Promise.resolve({ ok: true, value: { opened: true } }),
  )
  runtime.remote.provideNamespaces({ session: { openWorkspacePath } })
  const openSession = vi.fn<(id: SessionId) => void>()
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(ROOT)
      openSession(ROOT)
    }),
    openSession,
  } as never)
  const session = sessionFakeFor()
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session,
  })
  const rootReference = runtime.sessions.retain(ROOT)
  await rootReference.ready
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, (_props: { renderSlot?: unknown }) => null)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  const registerGroups = withProcessGroups ? undefined
    : vi.spyOn(runtime.ctx.uiConversation.groups, 'register').mockImplementation(() => () => {})
  const chat = await runtime.mount({ inject: [...injectChat], apply: applyChat })
  registerGroups?.mockRestore()
  runtime.renderRoot()

  const chatViewApi = (reference: SessionReference) => {
    const id = reference.sessionId
    const entry = runtime.slots.entries('conversation.view')[0]!
    const instance = runtime.storeOf('conversation.view', reference) as ChatInstance
    const injected = (entry.inject as unknown as (
      sessionId: SessionId,
      actions: ChatActions,
    ) => ChatViewInjected)(id, instance.actions)
    return { instance, injected }
  }
  return {
    get linkPreference() {
      const row = runtime.slots.entries('settings.general.item').find(entry => entry.options.id === 'link-opening')!
      const preference: object = row.inject!()
      return preference as LinkOpeningRowInjected
    },
    runtime, chat, chatSettings, browserAvailable,
    layout, openWorkspacePath, sidebarRight, sidebarRightTabs, session, chatViewApi, rootReference, openSession,
  }
}

describe('Chat inject API', () => {
  it('resolves keyed Group sources across registration, activation, and removal', async () => {
    const b = await bench(undefined, true, false)
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      const key = 'injected-group' as GroupKey
      expect(injected.keyedHooks.chatGroup(key)).toBeUndefined()
      const conversation = b.runtime.ctx.uiConversation
      const remove = conversation.groups.register({
        kind: 'test-group', target: 'chat',
        create: () => null,
        update: () => null,
        buildGroups: () => ({
          entries: [{ kind: 'group', key }],
          groups: { kind: 'replace', snapshots: [{
            key, data: { turn: 1, closed: true, summary: { counts: [], running: undefined, runningDetail: '' } }, members: [],
          }] },
        }),
      })
      await Promise.resolve()
      conversation.binding(b.rootReference.binding).activate('chat')
      const source = injected.keyedHooks.chatGroup(key)
      expect(source?.getSnapshot()?.data.turn).toBe(1)
      expect(injected.keyedHooks.chatGroup(key)).toBe(source)
      remove()
      await Promise.resolve()
      expect(source?.getSnapshot()).toBeUndefined()
      expect(injected.keyedHooks.chatGroup(key)).toBeUndefined()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('loads older history and forks through the Session Controller', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    injected.loadOlder()
    expect(b.session.loadOlder).toHaveBeenCalledOnce()

    void injected.loadThrough(SessionSeq(42))
    expect(b.session.loadThrough).toHaveBeenCalledWith(42)

    injected.forkAt(17)
    await vi.waitFor(() => {
      expect(b.openSession).toHaveBeenCalledWith(ROOT)
    })
    expect(b.runtime.sessions.calls).toContainEqual({
      method: 'fork', args: [{ sessionId: ROOT, atSeq: 17, increaseTitle: true }],
    })

    const fork = vi.spyOn(b.runtime.sessions, 'fork').mockRejectedValueOnce(new Error('fork failed'))
    injected.forkAt(18)
    await vi.waitFor(() => {
      expect(fork).toHaveBeenCalledWith({ sessionId: ROOT, atSeq: 18, increaseTitle: true })
    })
    await b.runtime.dispose()
  })

  it('addresses file paths under the Session\'s scope and opens them in the right Sidebar', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    await injected.openFile('src/a.ts')
    // Files stay in the product: a relative path is handed to the Sidebar as an
    // address under this session's scope, not to a desktop opener.
    expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/session/root-1/src/a.ts')
    expect(b.openWorkspacePath).not.toHaveBeenCalled()

    // An absolute path inside the session's workspace is the same session-relative address.
    await injected.openFile('/proj/src/a.ts')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a.ts')

    // A name a URL would otherwise mangle survives the round trip.
    await injected.openFile('src/a b#c.ts')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a%20b%23c.ts')

    // A line travels as the `file` type's navigation parameter, not in the address.
    await injected.openFile('src/a.ts', { line: 7 })
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-1/src/a.ts', { params: { line: 7 } })
    await b.runtime.dispose()
  })

  it('opens message HTTP(S) links in Sidebar Browser tabs', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    injected.openExternalLink('http://example.test/path')
    injected.openExternalLink('https://example.test/path')
    expect(b.sidebarRight.openTab.mock.calls).toEqual([
      ['browser', { params: { url: 'http://example.test/path' } }],
      ['browser', { params: { url: 'https://example.test/path' } }],
    ])
    await b.runtime.dispose()
  })

  it('opens message HTTP(S) links in the system browser when no Sidebar Browser is registered', async () => {
    const b = await bench()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      b.sidebarRightTabs.get.mockReturnValue(undefined)
      const { injected } = b.chatViewApi(b.rootReference)
      injected.openExternalLink('https://example.test/path')
      expect(b.sidebarRight.openTab).not.toHaveBeenCalled()
      expect(open).toHaveBeenCalledWith('https://example.test/path', '_blank', 'noopener,noreferrer')
    } finally {
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('applies restored and live link destinations without remounting the Chat view', async () => {
    const settings: ChatSettings = { transcriptView: 'compact', performanceUsage: 'detailed', linkOpening: 'new-tab' }
    const b = await bench(settings)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      const source = b.linkPreference.hooks.linkOpening
      expect(source.getSnapshot()).toBe('new-tab')
      injected.openExternalLink('https://example.test/restored')
      expect(open).toHaveBeenLastCalledWith('https://example.test/restored', '_blank', 'noopener,noreferrer')
      expect(b.sidebarRight.openTab).not.toHaveBeenCalled()

      b.chatSettings.publish({ value: { ...settings, linkOpening: 'sidebar' } })
      expect(source.getSnapshot()).toBe('sidebar')
      injected.openExternalLink('http://example.test/live')
      expect(b.sidebarRight.openTab).toHaveBeenLastCalledWith('browser', { params: { url: 'http://example.test/live' } })

      b.linkPreference.setLinkOpening('new-tab')
      expect(b.chatSettings.set).toHaveBeenCalledWith('linkOpening', 'new-tab')
      injected.openExternalLink('http://example.test/selected')
      expect(open).toHaveBeenLastCalledWith('http://example.test/selected', '_blank', 'noopener,noreferrer')

      await b.chat.dispose()
      expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(false)
      b.chatSettings.publish({ value: { ...settings, linkOpening: 'sidebar' } })
      expect(source.getSnapshot()).toBe('new-tab')
    } finally {
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('follows browser registration and routes absent browsers externally', async () => {
    const b = await bench()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const available = b.linkPreference.hooks.browserAvailable
    const changed = vi.fn()
    const unsubscribe = available.subscribe(changed)
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      expect(available.getSnapshot()).toBe(true)
      b.browserAvailable.set(false)
      expect(available.getSnapshot()).toBe(false)
      expect(changed).toHaveBeenCalledOnce()
      injected.openExternalLink('https://example.test/disabled')
      expect(open).toHaveBeenCalledWith('https://example.test/disabled', '_blank', 'noopener,noreferrer')
      b.browserAvailable.set(true)
      injected.openExternalLink('https://example.test/enabled')
      expect(b.sidebarRight.openTab).toHaveBeenCalledWith('browser', { params: { url: 'https://example.test/enabled' } })
      expect(b.linkPreference.hooks.linkOpening.getSnapshot()).toBe('sidebar')
    } finally {
      unsubscribe()
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('keeps Chat available while the optional tab registry appears and leaves', async () => {
    const b = await bench(undefined, false)
    try {
      expect(b.runtime.slots.entries('conversation.view')).toHaveLength(1)
      expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(false)
      const registry = await b.runtime.mount({
        apply(ctx) { ctx.provide('sidebarRightTabs', b.sidebarRightTabs as never) },
      })
      await vi.waitFor(() => {
        expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(true)
      })
      await registry.dispose()
      expect(b.runtime.slots.entries('settings.general.item').some(row => row.options.id === 'link-opening')).toBe(false)
      expect(b.runtime.slots.entries('conversation.view')).toHaveLength(1)
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps local link choices usable when settings cannot persist', async () => {
    const b = await bench()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      const { injected } = b.chatViewApi(b.rootReference)
      b.chatSettings.publish({ mode: 'memory', status: 'unavailable' })
      b.chatSettings.set.mockResolvedValueOnce(false)
      b.linkPreference.setLinkOpening('new-tab')
      b.chatSettings.publish({ value: undefined })
      injected.openExternalLink('https://example.test/local')
      expect(open).toHaveBeenCalledWith('https://example.test/local', '_blank', 'noopener,noreferrer')
      expect(b.sidebarRight.openTab).not.toHaveBeenCalled()

      b.chatSettings.set.mockRejectedValueOnce(new Error('settings unavailable'))
      b.linkPreference.setLinkOpening('sidebar')
      await Promise.resolve()
      injected.openExternalLink('https://example.test/local-sidebar')
      expect(b.sidebarRight.openTab).toHaveBeenCalledWith('browser', { params: { url: 'https://example.test/local-sidebar' } })
    } finally {
      open.mockRestore()
      await b.runtime.dispose()
    }
  })

  it('routes sent skill previews through the viewed Session source and tolerates an absent provider', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    injected.openSkill('review')
    const openReference = vi.fn(() => true)
    const sessionOf = vi.fn(() => ({ openReference }))
    b.runtime.ctx.provide('inputTriggers', { sessionOf } as never)
    injected.openSkill('review')
    expect(sessionOf).toHaveBeenCalledWith(b.runtime.sessions.scope(ROOT))
    expect(openReference).toHaveBeenCalledWith('skill', { ref: '/review' })
    vi.spyOn(b.runtime.sessions, 'scope').mockReturnValueOnce(undefined)
    injected.openSkill('review')
    expect(openReference).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('keeps a relative path under the Session without a cwd, and addresses a path outside the workspace absolutely', async () => {
    const b = await bench()
    const NO_CWD = 'root-2' as SessionId
    await b.runtime.sessions.add({
      id: NO_CWD,
      summary: { title: 'N', displayTitle: 'N' },
      session: sessionFakeFor(),
    })
    using reference = b.runtime.sessions.retain(NO_CWD)
    const { injected } = b.chatViewApi(reference)
    // The Host resolves the relative path against the root it holds for the
    // Session; the Client need not know it.
    await injected.openFile('src/a.ts')
    expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/session/root-2/src/a.ts')
    // An absolute path outside every known root still names its Session.
    await injected.openFile('/abs/a.ts')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/root-2//abs/a.ts')
    await b.runtime.dispose()
  })

  it('fails loud when a Chat View inject resolves no Session', async () => {
    const b = await bench()
    const entry = b.runtime.slots.entries('conversation.view')[0]!
    const injectView = entry.inject as unknown as (
      sessionId: SessionId,
      actions: ChatActions,
    ) => ChatViewInjected
    expect(() => injectView('never-listed' as SessionId, {} as ChatActions))
      .toThrow(/unknown session/)
    await b.runtime.dispose()
  })

  it('owns image loading, scroll memory, and optional closing-file mentions', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(b.rootReference)
    const owner = {} as never

    expect(injected.keyedHooks.chatNode('missing')).toBeDefined()
    expect(injected.keyedHooks.chatNodeProcess('missing')).toBeDefined()

    expect(injected.fileMentions(owner)).toBeUndefined()
    const mentions = { resolve: vi.fn() } as never
    const forClosing = vi.fn(() => mentions)
    b.runtime.ctx.provide('chatFileMentions', { forClosing } as never)
    expect(injected.fileMentions(owner)).toBe(mentions)
    expect(forClosing).toHaveBeenCalledWith(owner, ROOT)

    expect(injected.chatScroll.read()).toBeNull()
    const position = { anchorKey: 'node-1', anchorTop: 4, scrollTop: 12 }
    injected.chatScroll.save(position)
    expect(injected.chatScroll.read()).toEqual(position)
    injected.chatScroll.save(null)
    expect(injected.chatScroll.read()).toBeNull()

    const loaded = await injected.loadImage(ATTACHMENT)
    expect(loaded).toEqual(expect.any(String))
    expect(b.session.readAttachment).toHaveBeenCalledWith(ATTACHMENT.attachmentId)
    expect(injected.loadImage.peek?.(ATTACHMENT)).toBe(loaded)
    await b.runtime.dispose()
  })
})
