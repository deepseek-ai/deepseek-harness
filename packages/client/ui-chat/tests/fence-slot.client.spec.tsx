// @vitest-environment jsdom
/** Chat's Markdown fence Slot over the assembled Conversation and Chat plugins. */
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyChat, inject as injectChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import { LlmAttemptId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../src/chat-settings.ts'

usePinnedBrowserLanguages('zh-CN')

const SID = 'fence-session' as SessionId

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')

// jsdom has neither ResizeObserver nor font-loading events; the composer row observes both.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', fonts)
})

function AppRoot({ renderSlot }: PropsRenderSlots<'main'>) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

const turnStart: SessionEventLikeEntry[] = [
  { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } },
  { type: 'event', event: { type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } } },
]

/** A settled Turn whose one assistant message carries `text`. */
function settledReply(text: string): SessionEventLikeEntry[] {
  return [
    ...turnStart,
    { type: 'event', event: { type: 'assistant/message', seq: SessionSeq(3), time: 3, surfaceOp: 'append', data: {
      turn: 1, step: 1, stream: [], message: {
        id: MessageId('reply'), role: 'assistant', content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      },
    } } },
    { type: 'event', event: { type: 'turn/end', seq: SessionSeq(4), time: 4, data: { turn: 1, reason: { kind: 'completed' } } } },
  ]
}

/** An open Turn whose assistant text has streamed `text` so far. */
function streamingReply(text: string): SessionEventLikeEntry[] {
  return [
    ...turnStart,
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: SessionSeq(3), time: 3, data: {
      attemptId: LlmAttemptId('fence-attempt'), turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text },
    } } },
  ]
}

async function renderChat(events: readonly SessionEventLikeEntry[]) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  runtime.ctx.provide('fileDrag', { actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} }, read: () => undefined })
  const chatSettings = stubConfigForm<ChatSettings>()
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (namespace: string) => namespace === CHAT_SETTINGS_NAMESPACE ? chatSettings.scope : stubConfigForm().scope,
  } as never)
  runtime.ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
  runtime.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
  runtime.ctx.provide('sidebarRightTabs', { register: vi.fn(() => () => {}), get: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) } as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  runtime.remote.provideNamespaces({ session: { openWorkspacePath: vi.fn() } })
  let mainReference: ReturnType<typeof runtime.sessions.retain> | undefined
  const openSession = (id: SessionId): void => {
    const next = runtime.sessions.retain(id, { source: 'mainView' })
    mainReference?.release()
    mainReference = next
  }
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      openSession(SID)
    }),
    openSession,
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'F', displayTitle: 'F', cwd: '/proj' },
    session: { loadOlder: vi.fn<ISession['loadOlder']>() },
    events,
  })
  openSession(SID)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  return runtime.renderRoot()
}

describe('Chat Markdown fence Slot', () => {
  it('typesets a settled math fence through the math layer', async () => {
    const view = await renderChat(settledReply('```math\nx^2\n```'))
    expect(view.container.querySelector('[data-slot="conversation.chat.markdown.fence"] .katex')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="conversation.chat.markdown.fence"] .md-code-block')).toBeNull()
  })

  it('keeps a streaming math fence as its code block', async () => {
    const view = await renderChat(streamingReply('```math\nx^2\n'))
    const seat = view.container.querySelector('[data-slot="conversation.chat.markdown.fence"]')
    expect(seat?.querySelector('.md-code-block pre')?.textContent).toBe('x^2')
    expect(seat?.querySelector('.katex')).toBeNull()
  })

  it('draws diff rows through the diff layer', async () => {
    const view = await renderChat(settledReply('```diff\n@@ -1 +1 @@\n-old\n+new\n```'))
    const seat = view.container.querySelector('[data-slot="conversation.chat.markdown.fence"]')
    expect(seat?.querySelectorAll('[class*="_diffAdd_"]')).toHaveLength(1)
    expect(seat?.querySelector('pre')?.textContent).toBe('@@ -1 +1 @@\n-old\n+new')
  })

  it('renders a fence without a layer as the plain code block', async () => {
    const view = await renderChat(settledReply('```ts\n+const a = 1\n```'))
    const seat = view.container.querySelector('[data-slot="conversation.chat.markdown.fence"]')
    expect(seat?.querySelector('.md-code-block pre')?.textContent).toBe('+const a = 1')
    expect(seat?.querySelector('[class*="_diffAdd_"]')).toBeNull()
  })
})
