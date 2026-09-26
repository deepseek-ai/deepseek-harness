// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  apply as applyConversation, inject as injectConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationLocationDataSource, ConversationLocationDataStore, ConversationTurnDataMap,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, EMPTY_CHAT_SNAPSHOT, inject as injectChat,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ChatNodeInjected, ChatSnapshot, TranscriptViewRowInjected, UseChatNodeTurnData, UseDisclosure,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { QuotaNoticeInjected } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PerformanceUsageRowInjected } from '../src/client/settings/PerformanceUsageRow.tsx'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    metric: number
  }
}

usePinnedBrowserLanguages('zh-CN')

const SID = 'session-1' as SessionId

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const chatSettings = stubConfigForm<ChatSettings>()
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (namespace: string) => namespace === CHAT_SETTINGS_NAMESPACE
      ? chatSettings.scope
      : stubConfigForm().scope,
  } as never)
  runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
  runtime.ctx.provide('sidebarRightTabs', {
    register: vi.fn(() => () => {}),
    get: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {}),
  } as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  const openSession = vi.fn<(id: SessionId) => void>()
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      openSession(SID)
    }),
    openSession,
  } as never)
  runtime.remote.provideNamespaces({
    session: { openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })) },
  })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.approval.detail': { kind: 'single', scope: 'session' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, (_props: { renderSlot?: unknown }) => null)
  const conversation = await runtime.mount({
    inject: [...injectConversation],
    apply: applyConversation,
  })
  const provide = vi.spyOn(runtime.ctx.uiSession, 'provide')
  const chat = await runtime.mount({ inject: [...injectChat], apply: applyChat })
  const sourceDescriptor = provide.mock.calls[0]?.[0]
  if (sourceDescriptor === undefined) throw new Error('ui-chat did not provide its standard source')
  return { runtime, conversation, chat, chatSettings, sourceDescriptor }
}

function storeOf(runtime: SlotTestRuntime, key: 'conversation.session' | 'conversation.session.header' | 'conversation.view') {
  return (runtime.slots.entries(key)[0] as { store?: unknown } | undefined)?.store
}

describe('Chat apply wiring', () => {
  it('keeps presentation-policy helpers out of the public browser entry', async () => {
    const entry = await import('../src/client/index.ts')
    expect(entry).not.toHaveProperty('derivePresentationPolicy')
    expect(entry).not.toHaveProperty('presentationPolicyFor')
  })

  it('registers the frame-wide quota notice host and keeps the failure row injection-free', async () => {
    const b = await bench()
    try {
      const host = b.runtime.slots.entries('shell.overlay').find(entry => entry.options.id === 'chat.quota-notice')
      expect(host).toBeDefined()
      expect(b.runtime.slots.spec('shell.quota-notice')).toMatchObject({ kind: 'chain', scope: 'root' })
      const inject: ((...args: never[]) => Record<string, unknown>) | undefined = host?.inject
      if (inject === undefined) throw new Error('ui-chat did not register the quota notice host')
      const face = inject()
      expect(face.hooks).toBeDefined()
      const notice = (face.hooks as QuotaNoticeInjected['hooks']).notice
      expect(notice.getSnapshot()).toBeNull()
      ;(face.dismissNotice as QuotaNoticeInjected['dismissNotice'])()
      expect(notice.getSnapshot()).toBeNull()
      // The turn-error row carries neither a transient notice nor a chain child.
      const row = b.runtime.slots.entries('conversation.chat.node').find(entry => entry.options.key === 'turn-error')!
      expect(row.inject).toBeUndefined()
      expect(row.children).toBeUndefined()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('contributes Chat View, node renderers, and stats', async () => {
    const b = await bench()
    const views = b.runtime.slots.entries('conversation.view')
    expect(views.map(row => row.options.id)).toEqual(['chat'])
    expect(resolveSlotLabel(views[0]?.options.label)).toBe('对话')
    expect(b.runtime.slots.spec('conversation.chat.node'))
      .toMatchObject({ kind: 'keyed', scope: 'session' })
    expect(b.runtime.slots.entries('conversation.composer.dock').map(row => row.options.id))
      .toEqual(['stats'])
    expect(b.runtime.slots.entries('settings.general.item').map(row => row.options.id))
      .toEqual(['transcript-view', 'performance-usage', 'link-opening', 'composer-enter'])
    await b.runtime.dispose()
  })

  it('mirrors the Host transcript preference into its Settings row', async () => {
    const b = await bench()
    const row = b.runtime.slots.entries('settings.general.item')
      .find(entry => entry.options.id === 'transcript-view')!
    const face = (row.inject as unknown as () => TranscriptViewRowInjected)()

    expect(face.hooks.transcriptView.getSnapshot()).toBe('standard')
    face.setTranscriptView('detailed')
    expect(face.hooks.transcriptView.getSnapshot()).toBe('detailed')
    expect(b.chatSettings.set).toHaveBeenCalledWith('transcriptView', 'detailed')

    b.chatSettings.publish({
      status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed' }, revision: 1, writable: true,
    })
    expect(face.hooks.transcriptView.getSnapshot()).toBe('compact')
    await b.runtime.dispose()
  })

  it('shares the accepted performance preference with settings, composer, and turn tails', async () => {
    const b = await bench()
    const row = b.runtime.slots.entries('settings.general.item').find(entry => entry.options.id === 'performance-usage')!
    const face = (row.inject as unknown as () => PerformanceUsageRowInjected)()
    expect(face.hooks.performanceUsage.getSnapshot()).toBe('detailed')
    face.setPerformanceUsage('compact')
    expect(b.chatSettings.set).toHaveBeenCalledWith('performanceUsage', 'compact')
    b.chatSettings.publish({ value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'compact' } })
    expect(face.hooks.performanceUsage.getSnapshot()).toBe('compact')
    for (const entry of [
      b.runtime.slots.entries('conversation.composer.dock').find(entry => entry.options.id === 'stats')!,
      b.runtime.slots.entries('conversation.chat.node').find(entry => entry.options.key === 'turn-tail')!,
    ]) {
      const injected = (entry.inject as () => Pick<PerformanceUsageRowInjected, 'hooks'>)()
      expect(injected.hooks.performanceUsage).toBe(face.hooks.performanceUsage)
    }
    await b.runtime.dispose()
  })

  it('shares one Chat store while keeping it distinct from Conversation state', async () => {
    const b = await bench()
    const conversationStore = storeOf(b.runtime, 'conversation.session')
    const chatStore = storeOf(b.runtime, 'conversation.view')
    expect(storeOf(b.runtime, 'conversation.session.header')).toBe(conversationStore)
    expect(chatStore).toBeDefined()
    expect(chatStore).not.toBe(conversationStore)
    await b.runtime.dispose()
  })

  it('removes only Chat contributions when Chat unloads', async () => {
    const b = await bench()
    await b.chat.dispose()
    expect(b.runtime.slots.entries('conversation.view')).toHaveLength(0)
    expect(b.runtime.slots.spec('conversation.chat.node')).toBeUndefined()
    expect(b.runtime.slots.entries('main').map(row => row.options.key)).toEqual(['conversation'])
    expect(b.runtime.slots.entries('main.conversation')).toHaveLength(1)
    expect(b.runtime.ctx.get('uiConversation')).toBeDefined()
    await b.runtime.dispose()
  })

  it('keeps the Chat standard source total while its target enters and leaves', async () => {
    const b = await bench()
    await b.runtime.sessions.add({ id: SID })
    using reference = b.runtime.sessions.retain(SID)
    const binding = reference.binding
    const resolveSource = (owner: SessionBinding): ObservableSnapshot<ChatSnapshot> => {
      const contribution = b.sourceDescriptor.resolve(owner) as {
        hooks: { chat: ObservableSnapshot<ChatSnapshot> }
      }
      return contribution.hooks.chat
    }
    const source = b.runtime.ctx.uiSession.adapter.bindingSource(reference).getSnapshot().hooks.chat as
      ObservableSnapshot<ChatSnapshot>
    expect(resolveSource(binding)).toBe(source)
    expect(resolveSource(binding)).toBe(source)
    const listener = vi.fn()
    const off = source.subscribe(listener)

    expect(source.getSnapshot()).toBeDefined()
    await b.chat.dispose()
    expect(source.getSnapshot()).toBe(EMPTY_CHAT_SNAPSHOT)

    off()
    await b.runtime.dispose()
  })

  it('binds Turn data directly to its keyed Location source', async () => {
    const b = await bench()
    const spec = b.runtime.slots.spec('conversation.chat.node') as unknown as {
      inject: ChatNodeInjected
    }
    let value: number | undefined = 42
    const listeners = new Set<() => void>()
    const source: ConversationLocationDataSource<number | undefined> = {
      getSnapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const data = {
      get: () => value,
      source: () => source,
    } as unknown as ConversationLocationDataStore<ConversationTurnDataMap>
    const useChat = vi.fn(() => { throw new Error('Turn data must not read the Chat snapshot') })
    const useTurnData = spec.inject.hooks.turnData(
      { useChat } as unknown as Parameters<typeof spec.inject.hooks.turnData>[0],
      { turnData: data, disclosureReset: createSnapshotStore(0) },
    )
    const Probe = ({ useData }: { useData: UseChatNodeTurnData }) => (
      <output>{useData('metric') ?? 'missing'}</output>
    )
    const view = render(<Probe useData={useTurnData} />)

    expect(view.getByText('42')).toBeTruthy()
    expect(useChat).not.toHaveBeenCalled()

    act(() => {
      value = 43
      for (const listener of [...listeners]) listener()
    })
    expect(view.getByText('43')).toBeTruthy()

    view.rerender(<Probe useData={spec.inject.hooks.turnData(
      { useChat } as unknown as Parameters<typeof spec.inject.hooks.turnData>[0],
      { turnData: undefined, disclosureReset: createSnapshotStore(0) },
    )} />)
    expect(view.getByText('missing')).toBeTruthy()
    expect(useChat).not.toHaveBeenCalled()

    view.unmount()
    await b.runtime.dispose()
  })

  it('injects local disclosures bound to their Chat seat reset source', async () => {
    const b = await bench()
    try {
      const spec = b.runtime.slots.spec('conversation.chat.node') as { inject: ChatNodeInjected }
      const reset = createSnapshotStore(0)
      const useDisclosure = spec.inject.hooks.disclosure(
        {} as Parameters<typeof spec.inject.hooks.disclosure>[0],
        { turnData: undefined, disclosureReset: reset },
      )
      function Probe({ useDisclosure }: { useDisclosure: UseDisclosure }) {
        const { expanded, toggle } = useDisclosure()
        return <button aria-expanded={expanded} onClick={toggle}>Details</button>
      }
      const view = render(<Probe useDisclosure={useDisclosure} />)
      try {
        const button = view.getByRole('button', { name: 'Details' })
        fireEvent.click(button)
        expect(button.getAttribute('aria-expanded')).toBe('true')
        act(() => { reset.set(1) })
        expect(button.getAttribute('aria-expanded')).toBe('false')
        expect(view.getByRole('button', { name: 'Details' })).toBe(button)
      } finally {
        view.unmount()
      }
    } finally {
      await b.runtime.dispose()
    }
  })
})
