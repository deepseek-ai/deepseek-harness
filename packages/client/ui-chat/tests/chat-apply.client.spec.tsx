// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
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
  ChatFlowInjected, ChatNodeInjected, ChatSnapshot, TranscriptViewRowInjected, UseChatNodeTurnData, UseDisclosure,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { QuotaNoticeInjected } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PerformanceUsageRowInjected } from '../src/client/settings/PerformanceUsageRow.tsx'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'
import { ActivityPill, UsagePill } from '../src/client/chat/StatsPills.tsx'
import { createFlowMotion } from '../src/client/chat/flow-motion.ts'
import { CHAT_FLOW_INJECT, CHAT_NODE_INJECT } from '../src/client/apply.ts'

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
    expect(entry).not.toHaveProperty('CHAT_FLOW_INJECT')
    expect(entry).not.toHaveProperty('CHAT_NODE_INJECT')
    expect(entry).not.toHaveProperty('ChatFlow')
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
      .toEqual(['activity', 'usage'])
    expect(b.runtime.slots.entries('settings.general.item').map(row => row.options.id))
      .toEqual(['transcript-view', 'link-opening', 'composer-enter', 'performance-usage'])
    await b.runtime.dispose()
  })

  it('owns node and image rendering through the flow slot with the shared Chat store', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    expect(b.runtime.slots.spec('conversation.chat.flow')).toMatchObject({ kind: 'single', scope: 'session' })
    const view = b.runtime.slots.entries('conversation.view')[0]
    const flow = b.runtime.slots.entries('conversation.chat.flow')[0]
    expect(view?.children?.['conversation.chat.flow']).toBeDefined()
    expect(view?.children?.['conversation.chat.node']).toBeUndefined()
    expect(view?.children?.['conversation.message.images']).toBeUndefined()
    expect(flow?.children?.['conversation.chat.node']).toBeDefined()
    expect(flow?.children?.['conversation.message.images']).toBeDefined()
    expect(flow?.store).toBeDefined()
    expect(flow?.store).toBe(view?.store)
    await b.chat.dispose()
    expect(b.runtime.slots.spec('conversation.chat.flow')).toBeUndefined()
    expect(b.runtime.slots.spec('conversation.chat.node')).toBeUndefined()
    expect(b.runtime.slots.spec('conversation.message.images')).toBeUndefined()
  })

  it('lets another registrant replace one composer stats pill by id', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    function PluginActivity() { return null }
    const dispose = b.runtime.ctx.slots.register({
      name: 'conversation.composer.dock', id: 'activity', order: 0, priority: -1,
    }, PluginActivity)
    const winners = (): Record<string, unknown> => Object.fromEntries(
      b.runtime.slots.entriesOfSlot('conversation.composer.dock')
        .map((entry): [string, unknown] => [entry.options.id ?? '', entry.component]),
    )
    expect(winners()).toEqual({ activity: PluginActivity, usage: UsagePill })
    dispose()
    expect(winners()).toEqual({ activity: ActivityPill, usage: UsagePill })
  })

  it.each([
    { desktop: false, initial: 'detailed', choice: 'standard' },
    { desktop: true, initial: 'standard', choice: 'detailed' },
  ] as const)('mirrors the Host transcript preference into its Settings row (desktop: $desktop)', async ({ desktop, initial, choice }) => {
    if (desktop) {
      vi.stubGlobal('dshDesktop', {})
      onTestFinished(() => { vi.unstubAllGlobals() })
    }
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const row = b.runtime.slots.entries('settings.general.item')
      .find(entry => entry.options.id === 'transcript-view')!
    const face = (row.inject as unknown as () => TranscriptViewRowInjected)()

    expect(face.hooks.transcriptView.getSnapshot()).toBe(initial)
    face.setTranscriptView(choice)
    expect(face.hooks.transcriptView.getSnapshot()).toBe(choice)
    expect(b.chatSettings.set).toHaveBeenCalledWith('transcriptView', choice)

    b.chatSettings.publish({
      status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed' }, revision: 1, writable: true,
    })
    expect(face.hooks.transcriptView.getSnapshot()).toBe('compact')
  })

  it('resets in-memory collapse timing when the Chat plugin remounts', async () => {
    const b = await bench()
    try {
      const row = b.runtime.slots.entries('settings.general.item')
        .find(entry => entry.options.id === 'transcript-view')!
      const face = row.inject!()
      const hooks = face.hooks as TranscriptViewRowInjected['hooks']
      const setCollapseTiming = face.setCollapseTiming as TranscriptViewRowInjected['setCollapseTiming']
      expect(hooks.collapseTiming.getSnapshot()).toBe('completion')
      setCollapseTiming('next-input')
      expect(hooks.collapseTiming.getSnapshot()).toBe('next-input')
      expect(b.chatSettings.set).not.toHaveBeenCalled()
      b.chatSettings.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'standard', performanceUsage: 'detailed' }, revision: 1, writable: true })
      expect(hooks.transcriptView.getSnapshot()).toBe('standard')
      expect(hooks.collapseTiming.getSnapshot()).toBe('next-input')
      expect(b.runtime.slots.entries('settings.general.item').map(entry => entry.options.id))
        .toEqual(['transcript-view', 'link-opening', 'composer-enter', 'performance-usage'])

      await b.chat.dispose()
      expect(b.runtime.slots.entries('settings.general.item').some(entry => entry.options.id === 'transcript-view')).toBe(false)
      await b.runtime.mount({ inject: [...injectChat], apply: applyChat })
      const remountedRow = b.runtime.slots.entries('settings.general.item')
        .find(entry => entry.options.id === 'transcript-view')!
      const remounted = remountedRow.inject!()
      const remountedHooks = remounted.hooks as TranscriptViewRowInjected['hooks']
      expect(remountedHooks.collapseTiming).not.toBe(hooks.collapseTiming)
      expect(remountedHooks.collapseTiming.getSnapshot()).toBe('completion')
      expect(remountedHooks.transcriptView.getSnapshot()).toBe('standard')
      expect(b.chatSettings.set).not.toHaveBeenCalled()
      expect(b.runtime.slots.entries('settings.general.item').map(entry => entry.options.id))
        .toEqual(['transcript-view', 'link-opening', 'composer-enter', 'performance-usage'])
    } finally {
      await b.runtime.dispose()
    }
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
      ...b.runtime.slots.entries('conversation.composer.dock'),
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
      { turnData: data, disclosureReset: createSnapshotStore(0), useGroupAction: () => { throw new Error('unused group action') } },
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
      { turnData: undefined, disclosureReset: createSnapshotStore(0), useGroupAction: () => { throw new Error('unused group action') } },
    )} />)
    expect(view.getByText('missing')).toBeTruthy()
    expect(useChat).not.toHaveBeenCalled()

    view.unmount()
    await b.runtime.dispose()
  })

  it('binds process hiding to each render context without sharing viewport motion', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const spec = b.runtime.slots.spec('conversation.chat.flow') as { inject: ChatFlowInjected }
    const nodeSpec = b.runtime.slots.spec('conversation.chat.node') as { inject: ChatNodeInjected }
    expect(spec.inject).toBe(CHAT_FLOW_INJECT)
    expect(nodeSpec.inject).toBe(CHAT_NODE_INJECT)
    type UseGroupAction = ReturnType<ChatFlowInjected['hooks']['groupAction']>
    type UseGroupHeaderAction = ReturnType<ChatFlowInjected['hooks']['groupHeaderAction']>
    const standard = { sessionId: SID } as Parameters<ChatFlowInjected['hooks']['groupAction']>[0]
    const reserveFirst = vi.fn<(px: number) => void>()
    const reserveSecond = vi.fn<(px: number) => void>()
    const first = createFlowMotion(reserveFirst, () => {})
    const second = createFlowMotion(reserveSecond, () => {})
    const useFirst = spec.inject.hooks.groupAction(standard, { motion: first })
    const useSecond = spec.inject.hooks.groupAction(standard, { motion: second })
    const useFirstHeader = spec.inject.hooks.groupHeaderAction(standard, { motion: first })
    const useSecondHeader = spec.inject.hooks.groupHeaderAction(standard, { motion: second })
    expect(nodeSpec.inject.hooks.groupAction(standard, {
      turnData: undefined, disclosureReset: createSnapshotStore(0), useGroupAction: useFirst,
    })).toBe(useFirst)
    const reveal = vi.fn()
    function Probe({ useHidden, hidden, label }: { useHidden: UseGroupAction; hidden: boolean; label: string }) {
      const ref = useHidden(hidden, reveal)
      return <div ref={ref} data-testid={label}>{label}</div>
    }
    function Header({ useHeader, hidden, label }: { useHeader: UseGroupHeaderAction; hidden: boolean; label: string }) {
      const ref = useRef<HTMLDivElement>(null)
      useHeader(ref, hidden)
      return <div ref={ref} data-testid={label}>{label}</div>
    }
    const rows = (firstHidden: boolean, secondHidden: boolean, firstHeaderHidden = false, secondHeaderHidden = false) => (
      <div data-chat-motion="">
        <Probe useHidden={useFirst} hidden={firstHidden} label="first" />
        <Probe useHidden={useSecond} hidden={secondHidden} label="second" />
        <Header useHeader={useFirstHeader} hidden={firstHeaderHidden} label="first-header" />
        <Header useHeader={useSecondHeader} hidden={secondHeaderHidden} label="second-header" />
      </div>
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let view: ReturnType<typeof render> | undefined
    try {
      view = render(rows(false, false))
      const firstRow = view.getByTestId('first')
      const secondRow = view.getByTestId('second')
      const firstHeader = view.getByTestId('first-header')
      const secondHeader = view.getByTestId('second-header')
      Object.defineProperty(firstHeader, 'offsetHeight', { value: 30 })
      Object.defineProperty(secondHeader, 'offsetHeight', { value: 40 })
      Object.defineProperty(firstRow, 'offsetHeight', { value: 80 })
      Object.defineProperty(secondRow, 'offsetHeight', { value: 90 })
      view.rerender(rows(true, false))
      expect(firstRow.hasAttribute('hidden')).toBe(false)
      expect(first.foldActive()).toBe(true)
      expect(second.foldActive()).toBe(false)
      await act(async () => { await Promise.resolve() })
      expect(reserveFirst).toHaveBeenCalledExactlyOnceWith(80)
      expect(reserveSecond).not.toHaveBeenCalled()
      view.rerender(rows(true, true))
      expect(second.foldActive()).toBe(true)
      await act(async () => { await Promise.resolve() })
      expect(reserveFirst).toHaveBeenCalledExactlyOnceWith(80)
      expect(reserveSecond).toHaveBeenCalledExactlyOnceWith(90)
      const finished = new Event('transitionend', { bubbles: true })
      Object.defineProperty(finished, 'propertyName', { value: 'height' })
      act(() => { firstRow.dispatchEvent(finished) })
      expect(first.foldActive()).toBe(false)
      expect(second.foldActive()).toBe(true)
      expect(firstRow.getAttribute('hidden')).toBe('until-found')
      expect(secondRow.hasAttribute('hidden')).toBe(false)
      act(() => { vi.runAllTimers() })
      expect(secondRow.getAttribute('hidden')).toBe('until-found')
      expect(view.getByTestId('first')).toBe(firstRow)
      expect(view.getByTestId('second')).toBe(secondRow)
      act(() => { firstRow.dispatchEvent(new Event('beforematch')) })
      expect(reveal).toHaveBeenCalledOnce()
      view.rerender(rows(true, true, true, false))
      expect(first.foldActive()).toBe(true)
      expect(second.foldActive()).toBe(false)
      view.rerender(rows(true, true, true, true))
      expect(second.foldActive()).toBe(true)
      await act(async () => { await Promise.resolve() })
      act(() => { vi.runAllTimers() })
      expect(firstHeader.getAttribute('hidden')).toBe('')
      expect(secondHeader.getAttribute('hidden')).toBe('')
      view.rerender(rows(true, true, false, true))
      expect(firstHeader.dataset.chatMotion).toBe('reveal')
      expect(secondHeader.hasAttribute('data-chat-motion')).toBe(false)
    } finally {
      try {
        view?.unmount()
        first.clear()
        second.clear()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('injects local disclosures bound to their Chat seat reset source', async () => {
    const b = await bench()
    try {
      const spec = b.runtime.slots.spec('conversation.chat.node') as { inject: ChatNodeInjected }
      const reset = createSnapshotStore(0)
      const useDisclosure = spec.inject.hooks.disclosure(
        {} as Parameters<typeof spec.inject.hooks.disclosure>[0],
        { turnData: undefined, disclosureReset: reset, useGroupAction: () => { throw new Error('unused group action') } },
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
