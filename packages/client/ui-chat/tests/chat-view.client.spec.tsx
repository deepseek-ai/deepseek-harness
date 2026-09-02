// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import type {
  AssistantMessageNode, ChatNode, ChatNodeOwnerProps, ChatNodeViewProps, ChatSnapshot,
  ChatViewSlotProps, CommandNode, CompactionSummaryNode, ContextMessageNode, ConversationNode,
  LegacyConversationSlice, ModelRetryNode, RunningToolCall, SelectionTarget, SteeringMessageNode,
  ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode, UseChatNodeTurnData,
  TranscriptViewMode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  SessionListState, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationLocationDataStore, ConversationTurnDataMap,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { KeyedSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { EMPTY_CONVERSATION_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import { ChatNodeSeat } from '../src/client/chat/ChatNodeSeat.tsx'
import { useTurnDataValue } from '../src/client/chat/use-turn-data.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantNodeView } from '../src/client/chat/AssistantNodeView.tsx'
import { CommandNodeView, ManualCompactionNodeView } from '../src/client/chat/CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from '../src/client/chat/MessageItem.tsx'
import { TurnTailNodeView } from '../src/client/chat/TurnTailNodeView.tsx'
import { TurnProcessNodeView } from '../src/client/chat/TurnProcessNodeView.tsx'
import { SystemPromptNodeView } from '../src/client/chat/SystemPromptRow.tsx'
import { formatRunDuration } from '../src/client/chat/message-chrome.ts'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import type { TurnProcessSpec } from '../src/client/contract/turn-process.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
// Keyless create() persists under the bare declared key; clear between cases
// so one harness's selection cannot rehydrate into the next.
beforeEach(() => {
  localStorage.clear()
})

const SID = 's1' as SessionId
type RoutedChatNodeOwner = ChatNodeOwnerProps & { readonly node: ChatNode }

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SID,
    queue: [],
    pendingSubmissions: [],
    running: false,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
    ...overrides,
  }
}

/** Scripted Session source: set() swaps the top-level object like the real Controller binding. */
function makeSessionSource(init: Partial<SessionSnapshot> = {}) {
  let snap = sessionSnapshot(init)
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<SessionSnapshot>) => {
      snap = { ...snap, ...next }
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

type ChatSlice = Partial<LegacyConversationSlice> & {
  readonly turnUsages?: NonNullable<Parameters<typeof chatSnapshotFixture>[0]>['turnUsages']
}
type HarnessUpdate = ChatSlice & Partial<SessionSnapshot> & { readonly chat?: ChatSnapshot }

/** Scripted Chat target source, independent from Session lifecycle state. */
function makeChatSource(init: ChatSlice = {}, snapshot?: ChatSnapshot) {
  let snap = snapshot ?? chatSnapshotFixture(init)
  const subs = new Set<() => void>()
  return {
    set: (next: ChatSlice) => {
      snap = chatSnapshotFixture({ ...snap.legacy, ...next }, snap)
      for (const fn of [...subs]) fn()
    },
    replace: (next: ChatSnapshot) => {
      snap = next
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

const user = (seq: number, text: string): UserMessageNode => ({
  kind: 'user',
  seq,
  time: seq * 1000,
  content: [{ type: 'text', text }] as never,
  source: null,
})
const userInTurn = (seq: number, text: string, turn: number): ConversationNode => ({
  ...user(seq, text),
  // The production Location index owns this association. The legacy fixture
  // accepts the extra coordinate so component tests can build the same view.
  turn,
} as unknown as ConversationNode)
const assistant = (seq: number, text: string, turn = 1, step = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step, blocks: [{ kind: 'text', text }],
})
const reasoningAssistant = (seq: number, text: string, turn = 1, step = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step, blocks: [{ kind: 'reasoning', text }],
})
const context = (seq: number, text: string, turn?: number): ContextMessageNode & { turn?: number } => ({
  kind: 'context', seq, time: seq * 1_000, content: [{ type: 'text', text }], source: null,
  provenance: { role: 'inject', label: null }, form: null,
  ...(turn === undefined ? {} : { turn }),
})
const steering = (seq: number, text: string, turn: number): SteeringMessageNode & { turn: number } => ({
  kind: 'steering', messageId: `steering-${String(seq)}` as SteeringMessageNode['messageId'],
  seq, time: seq * 1_000, turn, content: [{ type: 'text', text }], source: null,
})
const retry = (seq: number): ModelRetryNode => ({
  kind: 'model-retry', retryId: 'chat-view-retry' as ModelRetryNode['retryId'],
  seq, time: seq * 1_000, turn: 1, step: 0,
  retryState: 'scheduled',
  provider: 'mock', mode: 'normal', policyKey: 'mock-normal',
  retry: 1, maxRetries: 2, delayMs: 450,
  failure: { code: 'TRANSPORT', message: '连接被重置' },
})
const turnError = (seq: number, code?: string): TurnErrorNode => ({
  kind: 'turn-error', seq, time: seq * 1_000, turn: 1, step: 0,
  message: seq === 2 ? 'API key is invalid' : 'plugin exploded',
  ...(code === undefined ? {} : { code }),
})
const turnMaxTokens = (seq: number): TurnMaxTokensNode => ({
  kind: 'turn-max-tokens', seq, time: seq * 1_000, turn: 1, step: 0,
})
const toolResult = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: `{"command":"cmd-${callId}","description":"run ${callId}"}` },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, subCalls: [],
})
const runningCall = (callId: string, name = 'bash'): RunningToolCall => ({
  callId, name, argsRaw: `{"command":"cmd-${callId}"}`, turn: 2, step: 1, time: 1_000, subCalls: [],
})
const command = (over: Partial<CommandNode> = {}): CommandNode => ({
  kind: 'command', seq: 5, time: 5_000, commandId: 'cmd-1' as CommandNode['commandId'],
  name: 'plan', args: '', outcome: { kind: 'success', text: '已进入 plan mode' },
  ...over,
})
const compaction = (over: Partial<CompactionSummaryNode> = {}): CompactionSummaryNode => ({
  kind: 'compaction', seq: 8, time: 8_000,
  summary: '## 压缩摘要\n\n保留的事实。',
  summaryEventSeq: 7,
  shadowedItemCount: 16,
  shadowedTokenCount: 11_309,
  ...over,
})

/** Empty sessions-list hook for the global standard-kit seat. */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

function bindKeyedSnapshotSelector<Value>(
  resolve: (key: string) => ObservableSnapshot<Value>,
): KeyedSnapshotSelectorHook<Value> {
  const hooks = new WeakMap<object, SnapshotSelectorHook<Value>>()
  return ((key: string, selector?: (value: Value) => unknown, equal?: (left: unknown, right: unknown) => boolean) => {
    const source = resolve(key)
    let useValue = hooks.get(source)
    if (useValue === undefined) {
      useValue = bindSnapshotSelector(source)
      hooks.set(source, useValue)
    }
    return useValue(selector ?? ((value: Value) => value), equal)
  }) as KeyedSnapshotSelectorHook<Value>
}

function makeHarness(
  init: HarnessUpdate = {},
  sessionOverrides: Partial<SessionSnapshot> = {},
  chatSnapshot?: ChatSnapshot,
) {
  const {
    chat: initialChat, nodes, partial, runningCalls, turnTimings, turnEnds, turnUsages,
    ...sessionInit
  } = init
  const chatSlice: ChatSlice = {
    ...(nodes === undefined ? {} : { nodes }),
    ...(partial === undefined ? {} : { partial }),
    ...(runningCalls === undefined ? {} : { runningCalls }),
    ...(turnTimings === undefined ? {} : { turnTimings }),
    ...(turnEnds === undefined ? {} : { turnEnds }),
    ...(turnUsages === undefined ? {} : { turnUsages }),
  }
  const session = makeSessionSource({ ...sessionInit, ...sessionOverrides })
  const chatSource = makeChatSource(chatSlice, initialChat ?? chatSnapshot)
  const useChatNode = bindKeyedSnapshotSelector(
    key => chatSource.source.getSnapshot().nodes.source(key),
  )
  const useChatNodeProcess = bindKeyedSnapshotSelector(
    key => chatSource.source.getSnapshot().nodes.processSource(key),
  )
  const openDetails = vi.fn<(t: SelectionTarget) => void>()
  const openFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const loadOlder = vi.fn()
  const loadThrough = vi.fn<(seq: number) => Promise<void>>().mockResolvedValue(undefined)
  // Mutable outline holder: tests swap the value and drive a re-render via set().
  let outlineValue: unknown
  const openView = vi.fn<(view: string, focus: string) => void>()
  // In-memory scroll memory matching the apply.ts per-session map contract.
  let savedScroll: ReturnType<ChatViewSlotProps['chatScroll']['read']> = null
  const chatScroll: ChatViewSlotProps['chatScroll'] = {
    save: (position) => { savedScroll = position },
    read: () => savedScroll,
  }
  const forkAt = vi.fn()
  // Rows and the harness must observe the same chat-store instance.
  const chat = createChatStore().create()
  const transcriptView = createSnapshotStore<TranscriptViewMode>('compact')
  const t = makeTranslate(zh, commonZh)
  const toolOwners: Array<{
    callId: string
    toolName: string
    block: ToolCallBlock
    selectedCallId: string | undefined
    openFile: ChatNodeOwnerProps['openFile']
    inspectCall: ChatNodeOwnerProps['inspectCall']
  }> = []
  const renderCommandSlot = ((_key: string, _owner: object, opts?: { fallback?: React.ReactNode }) =>
    opts?.fallback ?? null) as unknown as React.ComponentProps<typeof CommandNodeView>['renderSlot']
  const renderTurnTail = ((_key: string, _owner: object) => null) as unknown as
    React.ComponentProps<typeof TurnTailNodeView>['renderSlotChain']
  const renderTurnTailSlot = (() => null) as unknown as
    React.ComponentProps<typeof TurnTailNodeView>['renderSlot']
  let nodeSlotOverride: React.ComponentProps<typeof ChatNodeSeat>['renderSlot'] | undefined
  const renderNodeSlot = ((key: string, owner: object, opts?: {
    fallback?: React.ReactNode
    hookContext?: unknown
  }) => {
    if (nodeSlotOverride !== undefined) return nodeSlotOverride(key as never, owner as never, opts as never)
    if (key !== 'conversation.chat.node') return opts?.fallback ?? null
    const nodeOwner = owner as RoutedChatNodeOwner
    const turnData = opts?.hookContext as
      ConversationLocationDataStore<ConversationTurnDataMap> | undefined
    const useTurnData: UseChatNodeTurnData = dataKey => useTurnDataValue(turnData, dataKey)
    const nodeProps = <Kind extends ChatNode['kind']>(): ChatNodeViewProps<Kind> => (
      { ...props, ...nodeOwner, useTurnData } as unknown as ChatNodeViewProps<Kind>
    )
    switch (nodeOwner.node.kind) {
      case 'user':
      case 'steering':
        return <UserMessageNodeView {...nodeProps<'user' | 'steering'>()} />
      case 'context':
        return <ContextMessageNodeView {...nodeProps<'context'>()} />
      case 'assistant-step':
        return <AssistantNodeView {...nodeProps<'assistant-step'>()} />
      case 'command':
        return (
          <CommandNodeView
            {...nodeProps<'command'>()}
            renderSlot={renderCommandSlot}
            SessionProvider={props.SessionProvider}
          />
        )
      case 'manual-compaction':
        return <ManualCompactionNodeView {...nodeProps<'manual-compaction'>()} />
      case 'compaction':
        return <CompactionNodeView {...nodeProps<'compaction'>()} />
      case 'model-retry':
        return <RetryNodeView {...nodeProps<'model-retry'>()} />
      case 'turn-error':
        return <TurnErrorNodeView {...nodeProps<'turn-error'>()} />
      case 'turn-max-tokens':
        return <TurnMaxTokensNodeView {...nodeProps<'turn-max-tokens'>()} />
      case 'turn-process':
        return <TurnProcessNodeView {...nodeProps<'turn-process'>()} />
      case 'system-prompt':
        return <SystemPromptNodeView {...nodeProps<'system-prompt'>()} />
      case 'turn-tail':
        return (
          <TurnTailNodeView
            {...nodeProps<'turn-tail'>()}
            renderSlot={renderTurnTailSlot}
            renderSlotChain={renderTurnTail}
            SessionProvider={props.SessionProvider}
          />
        )
      case 'unknown':
        return <UnknownNodeView {...nodeProps<'unknown'>()} />
      case 'tool-call': {
        const block = nodeOwner.node.data.root
        const toolName = 'kind' in block ? block.call?.name ?? '' : block.name
        const tool = {
          callId: block.callId,
          toolName,
          block,
          selectedCallId: nodeOwner.selectedCallId,
          openFile: nodeOwner.openFile,
          inspectCall: nodeOwner.inspectCall,
        }
        toolOwners.push(tool)
        return (
          <div
            data-testid={`tool-seat-${tool.callId}`}
            data-chat-anchor-key={`call:${tool.callId}`}
            data-chat-call-id={tool.callId}
          >
            {tool.toolName || '(unnamed)'}:{tool.callId}
          </div>
        )
      }
      default:
        return opts?.fallback ?? null
    }
  }) as unknown as React.ComponentProps<typeof ChatNodeSeat>['renderSlot']
  const renderSlot = renderNodeSlot
  // SessionProvider seat arrives with the session-scope child declaration;
  // ChatView never invokes it (pass-through stub).
  const SessionProviderStub: ChatViewSlotProps['SessionProvider'] = ({ children }) => <>{children}</>
  const props: ChatViewSlotProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector(session.source),
    useChat: bindSnapshotSelector(chatSource.source),
    useChatNode,
    useChatNodeProcess,
    useConversation: bindSnapshotSelector(createSnapshotStore(EMPTY_CONVERSATION_SNAPSHOT)),
    useTrajectory: (() => { throw new Error('unused') }),
    useSessions: emptySessions(),
    useSessionPendingInteraction: bindSnapshotSelector(
      createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()),
    ),
    useWorkspaces: emptyWorkspaces(),
    useProjection: () => outlineValue,
    useInput: (() => { throw new Error('unused') }),
    inputActions: {
      setDraft: () => {},
      addImages: () => true,
      removeImage: () => {},
      pruneImages: () => {},
      submit: () => {},
    },
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    useTranscriptView: bindSnapshotSelector(transcriptView),
    renderSlot,
    SessionProvider: SessionProviderStub,
    viewRequest: null,
    openView,
    completeViewRequest: () => {},
    openDetails,
    openFile,
    loadOlder,
    loadThrough,
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    chatScroll,
    forkAt,
    // Absent-service default; mention tests override with a real resolver.
    fileMentions: () => undefined,
    t,
  }
  const set = (next: HarnessUpdate): void => {
    const {
      chat: explicitChat, nodes, partial, runningCalls, turnTimings, turnEnds,
      ...sessionUpdate
    } = next
    if (explicitChat !== undefined) chatSource.replace(explicitChat)
    else if (nodes !== undefined || partial !== undefined || runningCalls !== undefined
      || turnTimings !== undefined || turnEnds !== undefined) {
      chatSource.set({
        ...(nodes === undefined ? {} : { nodes }),
        ...(partial === undefined ? {} : { partial }),
        ...(runningCalls === undefined ? {} : { runningCalls }),
        ...(turnTimings === undefined ? {} : { turnTimings }),
        ...(turnEnds === undefined ? {} : { turnEnds }),
      })
    }
    session.set(sessionUpdate)
  }
  const setSelection = (next: SelectionTarget | null): void => { chat.actions.select(next) }
  return {
    set, setSession: session.set, setChat: chatSource.set, ChatView, props,
    openDetails, openFile, loadOlder, loadThrough, openView,
    setOutline: (value: unknown) => { outlineValue = value },
    chatScroll, forkAt, setSelection, toolOwners,
    setTranscriptView: (mode: TranscriptViewMode) => { transcriptView.set(mode) },
    setNodeRenderer: (renderer: React.ComponentProps<typeof ChatNodeSeat>['renderSlot']) => {
      nodeSlotOverride = renderer
    },
  }
}

/** Simulate reader input (any device): a delivered position that deviates
 * from the observed-top ledger of programmatic writes. */
function readerScroll(element: HTMLElement, top: number): void {
  element.scrollTop = top
  fireEvent.scroll(element)
  fireEvent(element, new Event('scrollend'))
}

function turnProcessControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-turn-process]')
}

function withSystemPrompt(
  snapshot: ChatSnapshot,
  builder = new ChatSnapshotBuilder(),
  text = '# System',
): ChatSnapshot {
  const turn = snapshot.timeline.turns.get(1)
  if (turn === undefined) throw new Error('fixture lacks Turn 1')
  const prompt: ChatNode<'system-prompt'> = {
    key: 'fixture:system-prompt:1',
    id: '1',
    target: 'chat',
    kind: 'system-prompt',
    anchorSeq: 1,
    location: { kind: 'turn', turn },
    visibility: 'visible',
    data: { text },
  }
  return builder.replace({
    nodes: [prompt, ...snapshot.nodes.values()],
    timeline: snapshot.timeline,
  })
}

function renderedFlowKinds(container: HTMLElement): Array<string | undefined> {
  return [...container.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')]
    .map(row => row.dataset.chatFlowKind)
}

function installScrollMetrics(element: HTMLElement, initialHeight: number, clientHeight: number) {
  let scrollHeight = initialHeight
  let scrollTop = 0
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight)) },
  })
  return {
    setHeight: (value: number) => { scrollHeight = value },
    setLayout: (height: number, top: number) => {
      scrollHeight = height
      scrollTop = Math.max(0, Math.min(top, scrollHeight - clientHeight))
    },
  }
}

describe('Chat node rendering', () => {

  it('threads the injected file-mention vocabulary into the closing prose only', () => {
    const wrote = (seq: number, callId: string): ToolResultNode => ({
      ...toolResult(seq, callId, 'write'),
    })
    const h = makeHarness({
      nodes: [
        user(1, 'build it'),
        assistant(2, 'writing `report.html` now', 1),
        wrote(3, 'w'),
        assistant(4, 'Wrote `report.html`; `notes.md` untouched.', 1),
      ],
      turnEnds: new Map([[1, 4]]),
    })
    h.props.fileMentions = owner => ({
      resolve: (value) => {
        if (value !== 'report.html') return undefined
        return {
          open: () => { void h.openFile(`for-seq-${String(owner.seq)}/site/report.html`) },
          label: '打开 site/report.html',
          title: 'site/report.html',
        }
      },
    })
    const view = render(<h.ChatView {...h.props} />)
    // Exactly one live mention: the closing message links, the mid-turn
    // narration stays inert code, and the unknown file resolves to nothing.
    const mentions = view.container.querySelectorAll('code button')
    expect(mentions).toHaveLength(1)
    const mention = view.getByRole('button', { name: '打开 site/report.html' })
    expect(mention.getAttribute('title')).toBe('site/report.html')
    fireEvent.click(mention)
    // The vocabulary was built from the closing message's own owner currency.
    expect(h.openFile).toHaveBeenCalledWith('for-seq-4/site/report.html')
  })

  it('formatRunDuration localizes units and floors partial seconds', () => {
    const t = makeTranslate(zh, commonZh)
    expect(formatRunDuration(0, t)).toBe('0秒')
    expect(formatRunDuration(-500, t)).toBe('0秒')
    expect(formatRunDuration(15_999, t)).toBe('15秒')
    expect(formatRunDuration(125_000, t)).toBe('2分05秒')
  })

})

describe('ChatView', () => {
  it('leaves the turn rail unrendered when an unrelated Chat update commits', () => {
    const snapshot = chatSnapshotFixture({
      nodes: [
        userInTurn(1, 'first prompt', 1),
        assistant(2, 'first response', 1),
        userInTurn(4, 'second prompt', 2),
        assistant(5, 'second response', 2),
      ],
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    const h = makeHarness({}, {}, snapshot)
    // The rail asks for its own accessible name once per render, so counting
    // that key counts renders without reaching into the component.
    let railRenders = 0
    const translate = h.props.t
    const counting = ((key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.turnNavigation.label') railRenders += 1
      return (translate as (k: string, v?: Record<string, unknown>) => string)(key, vars)
    }) as ChatViewSlotProps['t']
    render(<h.ChatView {...h.props} t={counting} />)
    const afterMount = railRenders
    expect(afterMount).toBeGreaterThan(0)

    act(() => { h.setSelection({ turnSeq: 3, callId: 'a', toolName: 'bash' }) })

    expect(railRenders).toBe(afterMount)
  })

  it('projects loaded turns into prompt and response navigation previews', () => {
    const snapshot = chatSnapshotFixture({
      nodes: [
        userInTurn(1, 'first prompt', 1),
        assistant(2, 'first response', 1),
        userInTurn(4, 'second prompt', 2),
        assistant(5, 'second response', 2),
      ],
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    expect(snapshot.navigation.items()).toEqual([
      { turn: 1, anchorKey: 'fixture:user:1', prompt: 'first prompt', response: 'first response' },
      { turn: 2, anchorKey: 'fixture:user:4', prompt: 'second prompt', response: 'second response' },
    ])
    const h = makeHarness({}, {}, snapshot)
    const view = render(<h.ChatView {...h.props} />)
    const navigation = view.getByRole('navigation', { name: '轮次导航' })
    expect(navigation.style.getPropertyValue('--turn-natural-height')).toBe('22px')
    const first = view.getByRole('button', { name: '跳转到第 1 轮' })
    const second = view.getByRole('button', { name: '跳转到第 2 轮' })
    expect(first.parentElement?.style.getPropertyValue('--turn-natural-position')).toBe('0px')
    expect(second.parentElement?.style.getPropertyValue('--turn-natural-position')).toBe('10px')
    expect(second.getAttribute('aria-current')).toBe('true')
    fireEvent.focus(first)
    const preview = view.getByRole('tooltip')
    expect(preview.textContent).toContain('first prompt')
    expect(preview.textContent).toContain('first response')
  })

  it('jumps to a turn anchor and reflows stable marks after an older page arrives', () => {
    const later = [
      userInTurn(4, 'second prompt', 2), assistant(5, 'second response', 2),
      userInTurn(7, 'third prompt', 3), assistant(8, 'third response', 3),
    ]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const second = view.getByRole('button', { name: '跳转到第 2 轮' })
    const secondPosition = second.parentElement as HTMLElement
    expect(secondPosition.style.getPropertyValue('--turn-natural-position')).toBe('0px')

    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    metrics.setLayout(1_000, 700)
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 300 } as DOMRect)
    const secondRow = view.container.querySelector('[data-chat-flow-key="fixture:user:4"]') as HTMLElement
    vi.spyOn(secondRow, 'getBoundingClientRect').mockReturnValue({ top: -500, bottom: -440 } as DOMRect)
    fireEvent.click(second)
    expect(scroller.scrollTop).toBe(176)
    expect(second.getAttribute('aria-current')).toBe('true')

    act(() => {
      h.setChat({
        nodes: [userInTurn(1, 'first prompt', 1), assistant(2, 'first response', 1), ...later],
        turnTimings: new Map([[1, { startTime: 1_000 }], [2, { startTime: 4_000 }], [3, { startTime: 7_000 }]]),
      })
    })
    const movedSecond = view.getByRole('button', { name: '跳转到第 2 轮' })
    expect(movedSecond.parentElement).toBe(secondPosition)
    // Fixed pitch: the mark moves one slot down and never compresses.
    expect(secondPosition.style.getPropertyValue('--turn-natural-position')).toBe('10px')
  })

  it('extends the rail with unloaded outline turns, pages on click, and falls back when nothing lands', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt from outline', response: 'first answer from outline' },
      { turn: 2, seq: 4, prompt: 'second prompt from outline', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: 'third response' },
    ])
    const view = render(<h.ChatView {...h.props} />)
    const first = view.getByRole('button', { name: '加载并跳转到第 1 轮' })
    view.getByRole('button', { name: '加载并跳转到第 2 轮' })
    const third = view.getByRole('button', { name: '跳转到第 3 轮' })
    expect(third.getAttribute('aria-current')).toBe('true')
    fireEvent.focus(first)
    // An unloaded turn previews both sides from the outline.
    expect(view.getByRole('tooltip').textContent).toContain('first prompt from outline')
    expect(view.getByRole('tooltip').textContent).toContain('first answer from outline')

    fireEvent.click(first)
    expect(h.loadThrough).toHaveBeenCalledWith(0)
    expect(first.getAttribute('aria-busy')).toBe('true')

    // The fake loader never delivers rows: settlement repages once for the
    // unmoved head, then lands on the nearest rendered turn and un-busies.
    await act(async () => {})
    expect(h.loadThrough.mock.calls).toEqual([[0], [0]])
    expect(first.getAttribute('aria-busy')).toBeNull()
    expect(view.getByRole('button', { name: '跳转到第 3 轮' }).getAttribute('aria-current')).toBe('true')
  })

  it('a jump from the pinned tail releases bottom ownership so the follow snap cannot cancel it', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: '' },
    ])
    let releaseJump: (() => void) | undefined
    h.loadThrough.mockImplementation(() => new Promise<void>((resolve) => { releaseJump = resolve }))
    const view = render(<h.ChatView {...h.props} />)
    // Pinned to the tail on open: the back-to-bottom control is absent.
    expect(view.queryByRole('button', { name: '回到底部' })).toBeNull()

    const first = view.getByRole('button', { name: '加载并跳转到第 1 轮' })
    fireEvent.click(first)
    // The click itself leaves the tail...
    expect(view.getByRole('button', { name: '回到底部' })).toBeTruthy()
    // ...so a non-reader scroll delivery at the floor (the first prepend's
    // compensation fires one) no longer snaps to the tail and cancel the jump.
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLElement
    fireEvent.scroll(scroller)
    expect(first.getAttribute('aria-busy')).toBe('true')
    await act(async () => { releaseJump?.() })
  })

  it('holds a jump issued while a plain pull owns the pager and resumes it when the pull settles', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true, loadingOlder: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: '' },
    ])
    const view = render(<h.ChatView {...h.props} />)
    const first = view.getByRole('button', { name: '加载并跳转到第 1 轮' })
    fireEvent.click(first)
    // The session-side guard refuses the busy-pager jump instantly, yet the
    // mark stays busy instead of degrading to the nearest loaded turn.
    await act(async () => {})
    expect(h.loadThrough.mock.calls).toEqual([[0]])
    expect(first.getAttribute('aria-busy')).toBe('true')

    // The plain pull settles: the flip re-settles the jump, which repages.
    act(() => { h.setSession({ loadingOlder: false }) })
    await act(async () => {})
    expect(h.loadThrough.mock.calls).toEqual([[0], [0]])
    expect(first.getAttribute('aria-busy')).toBeNull()
  })

  it('scrolls the fixed-pitch rail inside its frame with gradient fades at the scrollable ends', () => {
    const h = makeHarness(
      { nodes: [userInTurn(8, 'latest prompt', 60), assistant(9, 'latest response', 60)] },
      { hasMore: true },
    )
    h.setOutline(Array.from({ length: 60 }, (_, index) => ({
      turn: index + 1,
      seq: index * 4,
      prompt: `p${String(index + 1)}`,
      response: '',
    })))
    const view = render(<h.ChatView {...h.props} />)
    const nav = view.getByRole('navigation', { name: '轮次导航' })
    // 60 marks at the fixed 10px pitch: the ladder keeps its natural height.
    expect(nav.style.getPropertyValue('--turn-natural-height')).toBe('602px')
    const scroller = nav.querySelector('[class*="scroller"]') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 602, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(scroller.className).toContain('fadeBottom')
    expect(scroller.className).not.toContain('fadeTop')

    scroller.scrollTop = 150
    fireEvent.scroll(scroller)
    expect(scroller.className).toContain('fadeTop')
    expect(scroller.className).toContain('fadeBottom')
    expect(nav.style.getPropertyValue('--turn-scroll-top')).toBe('150px')

    // Pointer mapping subtracts the rail scroll: y=94 with scrollTop 150 is
    // natural offset 238px → the 25th mark.
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
    fireEvent.pointerMove(nav, { clientY: 94 })
    expect(view.getByRole('tooltip').textContent).toContain('p25')
  })

  it('lands a jump on its turn once the paged rows commit', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: '' },
    ])
    let releaseJump: (() => void) | undefined
    h.loadThrough.mockImplementation(() => new Promise<void>((resolve) => { releaseJump = resolve }))
    const view = render(<h.ChatView {...h.props} />)

    fireEvent.click(view.getByRole('button', { name: '加载并跳转到第 1 轮' }))
    expect(h.loadThrough).toHaveBeenCalledWith(0)

    // The paged window commits: turn 1's rows and rail item enter the snapshot.
    act(() => {
      h.setChat({
        nodes: [userInTurn(0, 'first prompt', 1), assistant(1, 'first response', 1), ...later],
        turnTimings: new Map([[1, { startTime: 1_000 }], [3, { startTime: 8_000 }]]),
      })
    })
    const first = view.getByRole('button', { name: '跳转到第 1 轮' })
    expect(first.getAttribute('aria-current')).toBe('true')
    // The mark stays busy until the jump settles: the loader's completion
    // runs the final landing correction after the load-earlier button leaves.
    expect(first.getAttribute('aria-busy')).toBe('true')
    await act(async () => { releaseJump?.() })
    // Only the busy lifecycle is asserted after settlement: jsdom's zero
    // geometry makes the rAF active-turn resync read "at bottom" and hand the
    // mark to the last turn, so aria-current here is timing-dependent under
    // instrumentation; the landing position contract lives in the browser e2e.
    expect(first.getAttribute('aria-busy')).toBeNull()
  })

  it('hands a windowless tool result to the Tool seat with an empty tool name', () => {
    const h = makeHarness({
      nodes: [{ ...toolResult(3, 'w1'), call: null }],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('tool-seat-w1')).toBeTruthy()
    expect(h.toolOwners[0]).toMatchObject({ callId: 'w1', toolName: '' })
  })

  it('prepend keeps the reader\'s latest pending-request scroll position anchored', () => {
    const h = makeHarness(
      { nodes: [user(9, 'first visible'), user(10, 'next visible')] },
      { hasMore: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    const first = view.container.querySelector('[data-chat-flow-key="fixture:user:9"]') as HTMLDivElement
    const next = view.container.querySelector('[data-chat-flow-key="fixture:user:10"]') as HTMLDivElement
    let firstTop = 100
    let nextTop = 300
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 200 } as DOMRect),
    )
    vi.spyOn(first, 'getBoundingClientRect').mockImplementation(
      () => ({ top: firstTop, bottom: firstTop + 40 } as DOMRect),
    )
    vi.spyOn(next, 'getBoundingClientRect').mockImplementation(
      () => ({ top: nextTop, bottom: nextTop + 40 } as DOMRect),
    )
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    readerScroll(scroller, 50)
    fireEvent.click(view.getByText('加载更早'))
    // The reader moves after the request starts; this, not the click-time
    // row, is the intent the arriving page must preserve.
    firstTop = -200
    nextTop = 60
    readerScroll(scroller, 90)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1300, writable: true })
    nextTop = 560
    act(() => {
      h.setChat({ nodes: [assistant(2, 'older'), user(9, 'first visible'), user(10, 'next visible')] })
    })
    expect(scroller.scrollTop).toBe(590) // latest 90 + the anchored row's 500px prepend shift
  })

  it('bounds no-anchor hit testing before using the mounted-row fallback', () => {
    const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    const hitTest = vi.fn((): Element[] => [])
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: hitTest,
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'visible row')] })
      const view = render(<h.ChatView {...h.props} />)
      const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
      const anchor = view.container.querySelector('[data-chat-anchor-key="fixture:user:1"]') as HTMLElement
      installScrollMetrics(scroller, 4_000, 2_000)
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
        top: 0, bottom: 2_000, left: 0, right: 1_000,
      } as DOMRect)
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 140, left: 0, right: 1_000,
      } as DOMRect)

      readerScroll(scroller, 100)

      expect(hitTest).toHaveBeenCalledTimes(1)
      expect(h.chatScroll.read()?.anchorKey).toBe('fixture:user:1')
    } finally {
      if (originalHitTest !== undefined) {
        Object.defineProperty(document, 'elementsFromPoint', originalHitTest)
      } else {
        Reflect.deleteProperty(document, 'elementsFromPoint')
      }
    }
  })

  it('falls back to the first visible row when the viewport top hit-test misses', () => {
    const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    const nodes = Array.from({ length: 16 }, (_, index) => user(20 + index, `row ${String(index)}`))
    const h = makeHarness(
      { nodes },
      { hasMore: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-chat-flow-key]')]
    let prepended = false
    let rowRectCalls = 0
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 200 } as DOMRect),
    )
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
        rowRectCalls += 1
        const shift = prepended ? (index === 8 ? 400 : 500) : 0
        const top = 20 + (index - 8) * 60 + shift
        return { top, bottom: top + 40 } as DOMRect
      })
    })
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    readerScroll(scroller, 50)

    const hitTest = vi.fn((_x: number, _y: number): Element[] => [])
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: hitTest,
    })
    try {
      rowRectCalls = 0
      fireEvent.click(view.getByText('加载更早'))
      expect(hitTest).toHaveBeenCalledTimes(1)
      expect(hitTest.mock.calls[0]?.[1]).toBe(1)
      expect(rowRectCalls).toBeLessThanOrEqual(6)

      Object.defineProperty(scroller, 'scrollHeight', { value: 1_300, writable: true })
      prepended = true
      act(() => {
        h.setChat({ nodes: [assistant(2, 'older'), ...nodes] })
      })
      expect(scroller.scrollTop).toBe(450) // reader offset 50 + first visible row's 400px shift
    } finally {
      if (originalHitTest !== undefined) {
        Object.defineProperty(document, 'elementsFromPoint', originalHitTest)
      } else {
        Reflect.deleteProperty(document, 'elementsFromPoint')
      }
    }
  })

  it('renders the fixture main line as independently keyed business nodes', () => {
    const h = makeHarness({
      nodes: [user(1, 'do the thing'), assistant(2, 'running tools'), toolResult(3, 'a'), toolResult(4, 'b')],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('do the thing')).toBeTruthy()
    expect(view.getByText('running tools')).toBeTruthy()
    expect(view.getByTestId('tool-seat-a').textContent).toBe('bash:a')
    expect(view.getByTestId('tool-seat-b').textContent).toBe('bash:b')
    expect([...view.container.querySelectorAll('[data-chat-flow-key]')].map(row => ({
      key: row.getAttribute('data-chat-flow-key'),
      kind: row.getAttribute('data-chat-flow-kind'),
    }))).toEqual([
      { key: 'fixture:user:1', kind: 'user' },
      { key: 'fixture:turn-process:1', kind: 'turn-process' },
      { key: 'fixture:assistant:2', kind: 'assistant-step' },
      { key: 'fixture:tool:a', kind: 'tool-call' },
      { key: 'fixture:tool:b', kind: 'tool-call' },
    ])
    expect([...view.container.querySelectorAll('[data-chat-call-id]')].map(row => row.getAttribute('data-chat-call-id')))
      .toEqual(['a', 'b'])
    expect([...view.container.querySelectorAll('[data-chat-anchor-key]')].map(row => row.getAttribute('data-chat-anchor-key')))
      .toEqual([
        'fixture:user:1', 'fixture:turn-process:1', 'fixture:assistant:2',
        'fixture:tool:a', 'call:a', 'fixture:tool:b', 'call:b',
      ])
  })

  it('renders Host-pending steering at the flow tail and hands off to the durable node', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const pending = {
      id: 'steer-occurrence' as never,
      messageId: 'steer-message' as never,
      placement: 'steering' as const,
      content: [{ type: 'text' as const, text: 'interrupt now' }],
      preview: 'interrupt now',
      text: 'interrupt now',
    }
    const queued = {
      id: 'queued-occurrence' as never,
      messageId: 'queued-message' as never,
      placement: 'queued' as const,
      content: [{ type: 'text' as const, text: 'later' }],
      preview: 'later',
      text: 'later',
    }
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      { queue: [queued, pending], running: true },
    )
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getByText('interrupt now').closest('[data-pending-steering]')).not.toBeNull()
    expect(view.queryByText('later')).toBeNull()
    const pendingBubble = view.getByText('interrupt now').closest('[data-pending-steering]')
    expect(pendingBubble).not.toBeNull()
    fireEvent.click(within(pendingBubble as HTMLElement).getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('interrupt now')
    expect(within(pendingBubble as HTMLElement).queryByRole('button', { name: '在新对话中分支' })).toBeNull()
    expect(view.getByRole('status').compareDocumentPosition(view.getByText('interrupt now'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    act(() => {
      h.setSession({ queue: [queued] })
      h.setChat({
        nodes: [
          assistant(1, 'working'),
          {
            kind: 'steering', messageId: pending.messageId,
            seq: 2, time: 2_000,
            content: [{ type: 'text', text: 'interrupt now' }], source: null,
          },
        ],
      })
    })
    expect(view.getAllByText('interrupt now')).toHaveLength(1)
    expect(view.container.querySelector('[data-pending-steering]')).toBeNull()
    // Only the durable steering bubble: the turn is still running, so its
    // assistant narration owns no footer yet, and a steering bubble never
    // carries a branch action.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(1)
    const durableBubble = view.getByText('interrupt now').closest('[class*="userRow"]') as HTMLElement
    expect(within(durableBubble).queryByRole('button', { name: '在新对话中分支' })).toBeNull()

    act(() => {
      h.setSession({ running: false })
      h.setChat({ turnEnds: new Map([[1, 3]]) })
    })
    // The Turn Tail belongs to the closed Turn, independently of a later
    // steering bubble's placement in the Chat list.
    const branchButtons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(branchButtons).toHaveLength(1)
    expect(branchButtons[0]!.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(branchButtons[0]!)
    expect(h.forkAt).toHaveBeenCalledWith(1)
  })

  it('keeps a later pending occurrence visible when it reuses a durable MessageId', () => {
    const pending = {
      id: 'steer-occurrence-later' as never,
      messageId: 'shared-steer-message' as never,
      placement: 'steering' as const,
      content: [{ type: 'text' as const, text: 'same steering' }],
      preview: 'same steering',
      text: 'same steering',
    }
    const h = makeHarness({
      nodes: [{
        kind: 'user', seq: 2, time: 2_000,
        content: pending.content, source: null,
      }],
    }, { queue: [pending], running: true })
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getAllByText('same steering')).toHaveLength(2)
    expect(view.container.querySelectorAll('[data-pending-steering]')).toHaveLength(1)
  })

  it('renders local submission echoes at the flow tail and swaps atomically with the durable node', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        pendingSubmissions: [
          {
            requestId: 'req-1' as never, placement: 'transcript',
            time: 5_000, text: '即发即显', images: [],
          },
        ],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('即发即显').closest('[data-submission-echo]')).not.toBeNull()

    // The durable node arrives while the echo is STILL in the session
    // snapshot: the render-time rpcId dedupe keeps exactly one bubble.
    act(() => {
      h.setChat({
        nodes: [
          assistant(1, 'working'),
          {
            kind: 'user', seq: 2, time: 2_000,
            content: [{ type: 'text', text: '即发即显' }] as never,
            source: { kind: 'user', rpcId: 'req-1' },
          },
        ],
      })
    })
    expect(view.getAllByText('即发即显')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()

    // The delayed snapshot retirement changes nothing visible.
    act(() => { h.setSession({ pendingSubmissions: [] }) })
    expect(view.getAllByText('即发即显')).toHaveLength(1)
  })

  it('renders a local steer echo as pending steering before Host image admission completes', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        running: true,
        pendingSubmissions: [{
          requestId: 'req-steer' as never,
          placement: 'steering',
          time: 5_500,
          text: '带图纠偏',
          images: [{ previewUrl: 'blob:steer-preview', name: 'steer.png' }],
        }],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    const local = view.getByText('带图纠偏').closest('[data-submission-echo]')
    expect(local?.hasAttribute('data-pending-steering')).toBe(true)

    act(() => {
      h.setSession({
        queue: [{
          id: 'steer-occurrence' as never,
          messageId: 'steer-message' as never,
          placement: 'steering',
          rpcId: 'req-steer' as never,
          content: [{ type: 'text', text: '带图纠偏' }],
          preview: '带图纠偏',
          text: '带图纠偏',
        }],
      })
    })
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()
    expect(view.container.querySelector('[data-pending-steering]')).not.toBeNull()
  })

  it('keeps a queued echo out of the Chat flow before and after Host admission', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        running: true,
        pendingSubmissions: [
          {
            requestId: 'req-q' as never, placement: 'queued',
            time: 6_000, text: '排队中', images: [],
          },
        ],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText('排队中')).toBeNull()
    act(() => {
      h.setSession({
        queue: [{
          id: 'q-occurrence' as never,
          messageId: 'q-message' as never,
          placement: 'queued' as const,
          rpcId: 'req-q' as never,
          content: [{ type: 'text' as const, text: '排队中' }],
          preview: '排队中',
          text: '排队中',
        }],
      })
    })
    // The queued occurrence and its local predecessor both belong to the
    // queue dock, never the Chat flow.
    expect(view.queryByText('排队中')).toBeNull()
  })

  it('an image echo renders its previews through the message-image slot', () => {
    const h = makeHarness(
      { nodes: [] },
      {
        pendingSubmissions: [{
          requestId: 'req-img' as never,
          placement: 'transcript',
          time: 7_000,
          text: '',
          images: [
            { previewUrl: 'blob:echo-a', name: 'a.png', width: 4, height: 3 },
            { previewUrl: 'blob:echo-b' },
          ],
        }],
      },
    )
    const baseRenderSlot = h.props.renderSlot
    const renderSlot = ((key: string, owner: object, opts?: { fallback?: React.ReactNode }) => {
      if (key !== 'conversation.message.images') return baseRenderSlot(key as never, owner as never, opts as never)
      const images = (owner as { images: readonly unknown[] }).images
      return <div data-testid="echo-images" data-count={images.length} data-first={JSON.stringify(images[0])} />
    }) as unknown as ChatViewSlotProps['renderSlot']
    const view = render(<h.ChatView {...{ ...h.props, renderSlot }} />)
    const gallery = view.getByTestId('echo-images')
    expect(gallery.getAttribute('data-count')).toBe('2')
    expect(JSON.parse(gallery.getAttribute('data-first') ?? '{}')).toEqual({
      preview: { url: 'blob:echo-a', name: 'a.png', width: 4, height: 3 },
    })
  })

  it('animates only the latest unresolved model retry', () => {
    const retryNode = retry(2)
    const nextRetry = { ...retry(3), turn: 2, retry: 2 }
    const context = {
      kind: 'context', seq: 4, time: 4_000, content: [], source: null,
      provenance: { role: 'inject', label: null },
      form: null,
    } as const satisfies ConversationNode
    const h = makeHarness({ nodes: [user(1, 'try'), retryNode] }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    const disclosure = view.container.querySelector('details') as HTMLDetailsElement
    expect(disclosure.dataset.active).toBe('true')
    expect(within(disclosure).getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 1s')

    act(() => {
      h.setChat({ nodes: [user(1, 'try'), nextRetry] })
    })
    expect(within(disclosure).getAllByRole('status')).toHaveLength(1)
    expect(view.container.querySelector('details')).toBe(disclosure)
    expect(within(disclosure).getByRole('status').textContent).toBe('正在重试模型请求（2/2） · 1s')

    act(() => {
      h.setChat({
        nodes: [
          user(1, 'try'),
          { ...nextRetry, retryState: 'started' },
          context,
          assistant(5, 'done'),
        ],
      })
      h.setSession({ running: false })
    })
    expect(disclosure.dataset.active).toBeUndefined()
    expect(within(disclosure).getByRole('status').textContent).toBe('已重试模型请求（2/2） · 1s')

    act(() => {
      h.setChat({ nodes: [user(1, 'try'), { ...retry(6), retryState: 'cancelled' }] })
      h.setSession({ running: true })
    })
    const cancelledDisclosure = view.container.querySelector('details') as HTMLDetailsElement
    expect(cancelledDisclosure.dataset.active).toBeUndefined()
    expect(within(cancelledDisclosure).getByRole('status').textContent).toContain('重试已取消')
  })

  it('renders terminal turn failures inline with their durable message and optional code', () => {
    const h = makeHarness({ nodes: [user(1, 'try'), turnError(2, 'AUTH'), turnError(3)] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '本轮运行失败API 密钥无效AUTH',
      '本轮运行失败plugin exploded',
    ])
  })

  it('renders the max-tokens notice with localized guidance, distinct from turn errors', () => {
    const h = makeHarness({ nodes: [user(1, 'try'), assistant(2, 'truncated'), turnMaxTokens(3)] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '已达到输出 token 上限回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。',
    ])
    expect(view.queryByText('本轮运行失败')).toBeNull()
  })

  it('hands the trajectory callback to the Tool seat', () => {
    const h = makeHarness({
      nodes: [toolResult(3, 'a')],
    })
    render(<h.ChatView {...h.props} />)
    h.toolOwners[0]?.inspectCall('a')
    expect(h.openView).toHaveBeenCalledWith('trajectory', 'a')
  })

  it('shows assistant IconActions only on the last content message of each turn', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'mid-turn text', 1, 1),
        toolResult(3, 'a'),
        assistant(4, 'final answer', 1, 2),
        user(5, 'next'),
        assistant(6, 'second turn', 2),
      ],
      turnEnds: new Map([[1, 4], [2, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // Branch renders only under assistant answers; user bubbles keep copy alone.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(4)
    const branchButtons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(branchButtons).toHaveLength(2)
    expect(branchButtons.map(button => button.getAttribute('aria-disabled'))).toEqual([null, null])
  })

  it('folds Think and Tool rows before the final answer without unmounting them', () => {
    const first = {
      ...assistant(2, 'earlier reply', 1, 1),
      blocks: [
        { kind: 'reasoning' as const, text: 'inspect the repository' },
        { kind: 'text' as const, text: 'earlier reply' },
      ],
    }
    const second = assistant(5, 'final answer', 1, 2)
    const h = makeHarness({
      nodes: [
        user(1, 'question'),
        first,
        toolResult(3, 'a'),
        toolResult(4, 'b', 'subagent'),
        second,
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 5_000 }]]),
      turnEnds: new Map([[1, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const toggle = view.getByRole('button', { name: '1 次工具调用 · 1 条消息 · 1 个 subagent' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('data-turn-process-tool-calls')).toBe('1')
    expect(toggle.getAttribute('data-turn-process-messages')).toBe('1')
    expect(toggle.getAttribute('data-turn-process-subagents')).toBe('1')
    const members = [...view.container.querySelectorAll<HTMLElement>('[data-turn-process-member]')]
    expect(members).toHaveLength(3)
    expect(members.map(member => member.getAttribute('hidden')))
      .toEqual(['until-found', 'until-found', 'until-found'])
    expect(members[0]?.textContent).toContain('inspect the repository')
    expect(members[1]?.textContent).toContain('bash:a')
    expect(members[2]?.textContent).toContain('subagent:b')
    expect(view.getByText('final answer')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(members.map(member => member.getAttribute('hidden'))).toEqual([null, null, null])

    fireEvent.click(toggle)
    expect(members.map(member => member.getAttribute('hidden')))
      .toEqual(['until-found', 'until-found', 'until-found'])
    fireEvent(members[1]!, new Event('beforematch'))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(members.map(member => member.getAttribute('hidden'))).toEqual([null, null, null])

    act(() => { h.set({ nodes: [user(1, 'question'), first] }) })
    expect(view.getByRole('button', { name: '已思考' }).getAttribute('aria-expanded')).toBe('false')
    expect(members[0]?.getAttribute('hidden')).toBeNull()
    act(() => { h.set({
      nodes: [user(1, 'question'), first, toolResult(3, 'a'), toolResult(4, 'b', 'subagent'), second],
    }) })
    const renewedToggle = view.getByRole('button', { name: '1 次工具调用 · 1 条消息 · 1 个 subagent' })
    expect(renewedToggle.getAttribute('aria-expanded')).toBe('true')
    expect(members[0]?.getAttribute('hidden')).toBeNull()
  })

  it('folds injected Context in place with the rest of the Turn process', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'question'),
        context(2, 'runtime policy changed', 1),
        reasoningAssistant(3, 'inspect the repository', 1, 1),
        toolResult(4, 'a'),
        assistant(5, 'final answer', 1, 2),
      ],
      turnEnds: new Map([[1, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const contextRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="context"]')
    const members = [...view.container.querySelectorAll<HTMLElement>('[data-turn-process-member]')]

    expect(members).toHaveLength(3)
    expect(members.map(member => member.dataset.chatFlowKind)).toEqual(['context', 'assistant-step', 'tool-call'])
    expect(contextRow).not.toBeNull()
    expect(contextRow?.getAttribute('hidden')).toBe('until-found')
    fireEvent(contextRow!, new Event('beforematch'))
    expect(members.map(member => member.getAttribute('hidden'))).toEqual([null, null, null])
  })

  it('keeps the first System prompt above User and outside Process through completion and expansion', () => {
    const builder = new ChatSnapshotBuilder()
    const initial = withSystemPrompt(chatSnapshotFixture({
      nodes: [userInTurn(2, 'question', 1), context(3, 'runtime policy', 1)],
    }), builder)
    const h = makeHarness({ chat: initial }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    const promptRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="system-prompt"]')!

    expect(renderedFlowKinds(view.container)).toEqual(['system-prompt', 'user', 'context'])
    expect(promptRow.getAttribute('hidden')).toBeNull()
    expect(promptRow.hasAttribute('data-turn-process-member')).toBe(false)

    act(() => {
      h.set({
        chat: withSystemPrompt(chatSnapshotFixture({
          nodes: [
            userInTurn(2, 'question', 1),
            context(3, 'runtime policy', 1),
            reasoningAssistant(4, 'inspect', 1, 1),
          ],
        }), builder),
        running: true,
      })
    })
    expect(renderedFlowKinds(view.container)).toEqual([
      'system-prompt', 'user', 'turn-process', 'context', 'assistant-step',
    ])
    expect(view.container.querySelector('[data-chat-flow-kind="system-prompt"]')).toBe(promptRow)
    expect(promptRow.getAttribute('hidden')).toBeNull()

    act(() => {
      h.set({
        chat: withSystemPrompt(chatSnapshotFixture({
          nodes: [
            userInTurn(2, 'question', 1),
            context(3, 'runtime policy', 1),
            reasoningAssistant(4, 'inspect', 1, 1),
            assistant(6, 'final answer', 1, 2),
          ],
          turnEnds: new Map([[1, 7]]),
        }), builder),
        running: false,
      })
    })
    const toggle = turnProcessControl(view.container)!
    const members = [...view.container.querySelectorAll<HTMLElement>('[data-turn-process-member]')]
    expect(renderedFlowKinds(view.container)).toEqual([
      'system-prompt', 'user', 'turn-process', 'context', 'assistant-step', 'assistant-step', 'turn-tail',
    ])
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(promptRow.getAttribute('hidden')).toBeNull()
    expect(promptRow.hasAttribute('data-turn-process-member')).toBe(false)
    expect(members.map(member => member.dataset.chatFlowKind)).toEqual(['context', 'assistant-step'])
    expect(members.map(member => member.getAttribute('hidden'))).toEqual(['until-found', 'until-found'])

    fireEvent.click(toggle)
    expect(renderedFlowKinds(view.container)).toEqual([
      'system-prompt', 'user', 'turn-process', 'context', 'assistant-step', 'assistant-step', 'turn-tail',
    ])
    expect(promptRow.getAttribute('hidden')).toBeNull()
    expect(members.map(member => member.getAttribute('hidden'))).toEqual([null, null])
  })

  it('folds Context under the fallback title when every summary count is zero', () => {
    const h = makeHarness({
      nodes: [user(1, 'question'), context(2, 'runtime policy', 1), assistant(3, 'final answer', 1, 1)],
      turnEnds: new Map([[1, 4]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const toggle = view.getByRole('button', { name: '已思考' })
    const contextRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="context"]')

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('data-turn-process-tool-calls')).toBe('0')
    expect(toggle.getAttribute('data-turn-process-messages')).toBe('0')
    expect(toggle.getAttribute('data-turn-process-subagents')).toBe('0')
    expect(contextRow?.getAttribute('hidden')).toBe('until-found')
    fireEvent.click(toggle)
    expect(contextRow?.getAttribute('hidden')).toBeNull()
  })

  it('keeps ordinary spacing when steering separates the process control from its answer', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'question'),
        reasoningAssistant(2, 'inspect', 1, 1),
        steering(3, 'also mention safety', 1),
        assistant(4, 'final answer', 1, 2),
      ],
      turnEnds: new Map([[1, 5]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const answer = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="assistant-step"]:not([hidden])')

    expect(view.getByText('also mention safety')).toBeTruthy()
    expect(answer?.hasAttribute('data-turn-process-answer')).toBe(false)
  })

  it('keeps ordinary spacing when steering precedes the first process evidence', () => {
    const h = makeHarness({
      nodes: [
        steering(1, 'question', 1),
        steering(2, 'also mention safety', 1),
        reasoningAssistant(3, 'inspect', 1, 1),
        assistant(4, 'final answer', 1, 2),
      ],
      turnEnds: new Map([[1, 5]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const answer = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="assistant-step"]:not([hidden])')

    expect(view.getByText('also mention safety')).toBeTruthy()
    expect(answer?.hasAttribute('data-turn-process-answer')).toBe(false)
  })

  it('keeps a live Turn expanded and folds it once at turn/end', () => {
    const process = assistant(2, 'inspect', 1, 1)
    const h = makeHarness({
      nodes: [user(1, 'question'), process],
      partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'streaming answer' }] },
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(turnProcessControl(view.container)).toBeNull()
    const processRow = view.getByText('inspect').closest('[data-chat-flow-kind="assistant-step"]') as HTMLElement

    act(() => {
      h.set({
        nodes: [user(1, 'question'), process, assistant(4, 'settled answer', 1, 2)],
        partial: null,
        running: false,
        turnEnds: new Map([[1, 5]]),
      })
    })
    const toggle = turnProcessControl(view.container)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(processRow.getAttribute('hidden')).toBe('until-found')
  })

  it('switches completed Turns between the persisted Normal and Compact modes', () => {
    const process = assistant(2, 'inspect', 1, 1)
    const h = makeHarness({
      nodes: [user(1, 'question'), process, assistant(4, 'final answer', 1, 2)],
      turnEnds: new Map([[1, 5]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const processRow = view.getByText('inspect').closest('[data-chat-flow-kind="assistant-step"]') as HTMLElement

    expect(turnProcessControl(view.container)?.getAttribute('aria-expanded')).toBe('false')
    expect(processRow.getAttribute('hidden')).toBe('until-found')

    act(() => { h.setTranscriptView('normal') })
    expect(turnProcessControl(view.container)).toBeNull()
    expect(processRow.getAttribute('hidden')).toBeNull()

    act(() => { h.setTranscriptView('compact') })
    expect(turnProcessControl(view.container)?.getAttribute('aria-expanded')).toBe('false')
    expect(processRow.getAttribute('hidden')).toBe('until-found')
  })

  it('folds final-step reasoning under the fallback title when every summary count is zero', () => {
    const final = {
      ...assistant(3, 'final answer', 1, 1),
      blocks: [
        { kind: 'reasoning' as const, text: 'private analysis' },
        { kind: 'text' as const, text: 'final answer' },
      ],
    }
    const h = makeHarness({ nodes: [user(1, 'question'), final], turnEnds: new Map([[1, 4]]) })
    const view = render(<h.ChatView {...h.props} />)
    const toggle = view.getByRole('button', { name: '已思考' })
    const reasoning = view.container.querySelector<HTMLElement>('[data-turn-process-inline]')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(reasoning?.getAttribute('hidden')).toBe('until-found')
    expect(view.getByText('final answer')).toBeTruthy()
    fireEvent.click(toggle)
    expect(view.getByText('private analysis')).toBeTruthy()
  })

  it('folds a completed Turn even while the reader is away from the tail', () => {
    const first = assistant(2, 'first answer', 1, 1)
    const h = makeHarness({ nodes: [user(1, 'question'), first], running: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    const firstRow = view.getByText('first answer').closest('[data-chat-flow-kind="assistant-step"]') as HTMLElement
    readerScroll(scroller, 100)

    act(() => { h.set({
      nodes: [user(1, 'question'), first, assistant(4, 'new answer', 1, 2)],
      turnEnds: new Map([[1, 5]]),
    }) })
    const toggle = turnProcessControl(view.container)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(firstRow.getAttribute('hidden')).toBe('until-found')
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it('folds when the process controller first appears off-tail', () => {
    const h = makeHarness({
      nodes: [user(1, 'question'), context(2, 'runtime policy', 1)],
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    const contextRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="context"]')
    readerScroll(scroller, 100)

    act(() => { h.set({
      nodes: [
        user(1, 'question'),
        context(2, 'runtime policy', 1),
        assistant(3, 'final answer', 1, 1),
      ],
      running: false,
      turnEnds: new Map([[1, 4]]),
    }) })
    const toggle = turnProcessControl(view.container)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(contextRow?.getAttribute('hidden')).toBe('until-found')
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it('keeps a focused process row visible when a live Turn completes', () => {
    const h = makeHarness({
      nodes: [user(1, 'question'), context(2, 'runtime policy', 1)],
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    const contextToggle = view.getByRole('button', { name: '上下文注入' })
    const contextRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="context"]')
    contextToggle.focus()
    expect(document.activeElement).toBe(contextToggle)

    act(() => { h.set({
      nodes: [
        user(1, 'question'),
        context(2, 'runtime policy', 1),
        assistant(3, 'final answer', 1, 1),
      ],
      running: false,
      turnEnds: new Map([[1, 4]]),
    }) })
    const processToggle = turnProcessControl(view.container)!
    expect(processToggle.getAttribute('aria-expanded')).toBe('true')
    expect(contextRow?.getAttribute('hidden')).toBeNull()
    expect(document.activeElement).toBe(contextToggle)

    fireEvent.click(processToggle)
    expect(document.activeElement).toBe(processToggle)
    expect(processToggle.getAttribute('aria-expanded')).toBe('false')
    expect(contextRow?.getAttribute('hidden')).toBe('until-found')
  })

  it('keeps a foldable closed Turn fully visible while history is partial', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'question'),
        context(2, 'runtime policy', 1),
        assistant(3, 'working', 1, 1),
        assistant(4, 'final answer', 1, 2),
      ],
      turnEnds: new Map([[1, 5]]),
      hasMore: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    const contextRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="context"]')

    expect(turnProcessControl(view.container)).toBeNull()
    expect(contextRow?.getAttribute('hidden')).toBeNull()
    expect(contextRow?.hasAttribute('data-turn-process-member')).toBe(false)

    act(() => { h.set({ hasMore: false }) })
    const toggle = turnProcessControl(view.container)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(contextRow?.getAttribute('hidden')).toBe('until-found')
  })

  it('withholds process controls for partial history and folds final-page groups', () => {
    const h = makeHarness({
      nodes: [user(9, 'visible question'), assistant(10, 'visible answer', 2)],
      hasMore: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(turnProcessControl(view.container)).toBeNull()

    act(() => {
      h.set({
        nodes: [
          user(1, 'older question'),
          assistant(2, 'older first answer', 1, 1),
          assistant(4, 'older final answer', 1, 2),
          user(9, 'visible question'),
          assistant(10, 'visible answer', 2),
        ],
        turnEnds: new Map([[1, 5]]),
        hasMore: false,
      })
    })

    const toggle = turnProcessControl(view.container)!
    const member = view.container.querySelector<HTMLElement>('[data-turn-process-member]')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(member?.getAttribute('hidden')).toBe('until-found')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(member?.getAttribute('hidden')).toBeNull()
  })

  it('refreshes process layout without reordering when the final page only changes Turn data', () => {
    const source = chatSnapshotFixture({
      nodes: [
        user(1, 'question'),
        context(2, 'runtime policy', 1),
        assistant(3, 'working', 1, 1),
        assistant(4, 'final answer', 1, 2),
      ],
      turnEnds: new Map([[1, 5]]),
    })
    const process = source.nodes.values()
      .find((candidate): candidate is ChatNode<'turn-process'> => candidate.kind === 'turn-process')
    if (process === undefined
      || (process.location.kind !== 'turn' && process.location.kind !== 'step')
      || process.data.answerAnchorSeq === null) throw new Error('fixture lacks a completed Turn process')
    const turnData = process.location.turn.data as typeof process.location.turn.data & {
      set(key: 'turn-process', value: TurnProcessSpec): void
      publish(): void
    }
    const partialSpec = { ...process.data, processStartSeq: process.data.answerAnchorSeq }
    turnData.set('turn-process', partialSpec)
    const partialProcess = { ...process, data: partialSpec }
    const builder = new ChatSnapshotBuilder()
    const partial = builder.replace({
      nodes: source.nodes.values().map(node => node.key === process.key ? partialProcess : node),
      timeline: source.timeline,
    })
    const h = makeHarness({ chat: partial, hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(turnProcessControl(view.container)).toBeNull()

    const beforeKeys = partial.locations.getTurn(1)
    const completeSpec = { ...partialSpec, processStartSeq: 2 }
    turnData.set('turn-process', completeSpec)
    const complete = builder.apply({
      upserts: [{ ...partialProcess, data: completeSpec }],
      timeline: source.timeline,
    })
    expect(complete.order).toBe(partial.order)
    expect(complete.nodes).toBe(partial.nodes)
    expect(complete.locations.getTurn(1)).not.toBe(beforeKeys)
    expect(complete.order.map(key => complete.nodes.get(key)?.kind)).toEqual([
      'user', 'turn-process', 'context', 'assistant-step', 'assistant-step', 'turn-tail',
    ])

    act(() => {
      turnData.publish()
      h.set({ chat: complete, hasMore: false })
    })
    expect(turnProcessControl(view.container)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps a manual expansion when the reader returns from another view', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2_000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const first = assistant(2, 'first answer', 1, 1)
      const h = makeHarness({
        nodes: [user(1, 'question'), first, assistant(4, 'new answer', 1, 2)],
        turnEnds: new Map([[1, 5]]),
      })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      fireEvent.click(turnProcessControl(view.container)!)
      expect(turnProcessControl(view.container)?.getAttribute('aria-expanded')).toBe('true')

      view.rerender(<div />)
      view.rerender(<h.ChatView {...h.props} />)
      expect(turnProcessControl(view.container)?.getAttribute('aria-expanded')).toBe('true')
    } finally {
      host.remove()
    }
  })

  it('withholds assistant IconActions while the turn is still running', () => {
    const h = makeHarness({
      runningCalls: [runningCall('a')],
      nodes: [
        user(1, 'first'),
        assistant(2, 'previous answer', 1),
        user(4, 'second'),
        assistant(5, 'mid-turn text', 2),
      ],
      // Boundary seqs follow the log: a turn/end is strictly after its own nodes.
      turnEnds: new Map([[1, 3]]),
    }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    // 2 user + the settled turn-1 tail, which keeps its seat while a later
    // turn runs; turn 2's narration stays chrome-free while its tool runs, so
    // the footer never appears and then moves.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(3)
    expect(view.getByText('mid-turn text')).toBeTruthy()
    // turn/end lands: the same node becomes the settled answer and takes the seat.
    act(() => {
      h.setSession({ running: false })
      h.setChat({ runningCalls: [], turnEnds: new Map([[1, 3], [2, 6]]) })
    })
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(4)
  })

  it('the actions-owning assistant footer shows the turn run time', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'), // time 1_000
        assistant(2, 'mid-turn text', 1, 1),
        assistant(16, 'final answer', 1, 2),
        toolResult(18, 'trailing'),
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 20_000 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // The exact turn/end includes trailing tool activity after the final text.
    expect(view.container.querySelector('[data-turn-tail="1"]')?.textContent).toContain('用时 19秒')
  })

  it('the settled footer exposes ttft, decode throughput, and usage as the details trigger', () => {
    const first: AssistantMessageNode = {
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'mid' }],
      timing: { stepStartTime: 1_000, firstTokenTime: 2_200, completedTime: 5_200 },
      usage: { outputTokens: 40 },
    }
    const second: AssistantMessageNode = {
      kind: 'assistant', seq: 16, time: 16_000, turn: 1, step: 2, blocks: [{ kind: 'text', text: 'final' }],
      timing: { stepStartTime: 10_000, firstTokenTime: 10_200, completedTime: 12_200 },
      usage: { outputTokens: 60 },
    }
    const h = makeHarness({
      nodes: [user(1, 'hi'), first, second],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 20_000 }]]),
      turnEnds: new Map([[1, 20]]),
      turnUsages: new Map([[1, {
        uncachedInputTokens: 5_060,
        cacheReadTokens: 4_940,
        outputTokens: 100,
        totalTokens: 10_100,
      }]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // The usage pill carries the compact total; cache hit stays dialog-only.
    const trigger = view.getByRole('button', { name: /用量 10\.1K tok/ })
    expect(trigger.textContent).toBe('用量 10.1K tok')
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('本轮用量')
    expect(dialog.firstChild?.textContent).toBe('本轮用量10,100 tok')
    expect(dialog.textContent).toContain('缓存命中49.4%')
    expect(dialog.textContent).toContain('未缓存输入5,060 tok')
    fireEvent.keyDown(document, { key: 'Escape' })
    // The time pill carries the run time; first-step ttft (1.2s) and 100
    // tokens over 5s of decode move into its dialog.
    const timeTrigger = view.getByRole('button', { name: /用时 19秒/ })
    expect(timeTrigger.textContent).toBe('用时 19秒')
    expect(view.queryByText(/速度 20 tok\/s|首 token/)).toBeNull()
    fireEvent.click(timeTrigger)
    const timeDialog = view.getByRole('dialog')
    expect(timeDialog.getAttribute('aria-label')).toBe('本轮用时和速度')
    expect(timeDialog.textContent).toContain('本轮总用时19秒')
    expect(timeDialog.textContent).toContain('输出速度（TPS）20 tok/s')
    expect(timeDialog.textContent).toContain('首 token 用时（TTFT）1.2秒')
  })

  it('withholds the usage-details trigger when turn usage is outside the window', () => {
    const settled: AssistantMessageNode = {
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'answer' }],
      timing: { stepStartTime: 1_000, firstTokenTime: 2_200, completedTime: 5_200 },
      usage: { outputTokens: 40 },
    }
    const h = makeHarness({
      nodes: [user(1, 'hi'), settled],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 20_000 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // Timing facts keep their pill, but with no usage in the window there is
    // no usage pill to click.
    expect(view.getByRole('button', { name: /用时/ })).toBeTruthy()
    expect(view.queryByRole('button', { name: /用量/ })).toBeNull()
  })

  it('withholds ttft and throughput while the turn is still running', () => {
    const settled: AssistantMessageNode = {
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'answer' }],
      timing: { stepStartTime: 1_000, firstTokenTime: 1_500, completedTime: 2_000 },
      usage: { outputTokens: 10 },
    }
    const h = makeHarness({
      nodes: [user(1, 'hi'), settled],
      turnTimings: new Map([[1, { startTime: 1_000 }]]),
      turnEnds: new Map(),
    }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/首 token|tok\/s/)).toBeNull()
  })

  it('keeps only the latest turn tail actions permanently visible', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'answer'),
        user(4, 'again'),
        assistant(5, 'later answer', 2),
      ],
      turnTimings: new Map([
        [1, { startTime: 1_000, endTime: 2_000 }],
        [2, { startTime: 4_000, endTime: 5_000 }],
      ]),
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const tails = view.container.querySelectorAll('[data-turn-tail]')
    expect(new Map([...tails].map(tail => [
      tail.getAttribute('data-turn-tail'), tail.getAttribute('data-actions-reveal'),
    ]))).toEqual(new Map([['1', 'hover'], ['2', 'always']]))
    expect(view.container.querySelectorAll('[data-chat-flow-kind="user"]')).toHaveLength(2)
  })

  it('the run-time label is withheld when the turn start is outside the window', () => {
    const h = makeHarness({
      nodes: [assistant(16, 'tail without trigger')],
      turnEnds: new Map([[1, 16]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/用时/)).toBeNull()
  })

  it('enables fork only on the finalized assistant at the completed transcript tail', () => {
    const h = makeHarness({
      nodes: [user(1, 'question'), assistant(2, 'answer')],
      turnEnds: new Map([[1, 3]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // The user bubble offers no branch; the settled answer's is live.
    const buttons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(buttons[0]!)
    expect(h.forkAt.mock.calls).toEqual([[2]])
  })

  it('disables fork when the indexed Turn has a later steering Node', () => {
    const base = chatSnapshotFixture({
      nodes: [user(1, 'question'), assistant(2, 'answer')],
      turnEnds: new Map([[1, 4]]),
    })
    const chat = {
      ...base,
      locations: {
        getTurn: (turn: number) => turn === 1
          ? [...base.locations.getTurn(turn), 'fixture:steering:later']
          : base.locations.getTurn(turn),
        getStep: (turn: number, step: number) => base.locations.getStep(turn, step),
      },
    }
    const h = makeHarness({}, {}, chat)
    const view = render(<h.ChatView {...h.props} />)
    const branch = view.getByRole('button', { name: '在新对话中分支' })
    expect(branch.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(branch)
    expect(h.forkAt).not.toHaveBeenCalled()
  })

  it('keeps final content actions but disables branch when Tool and interrupted Think follow it', () => {
    const interruptedThink: AssistantMessageNode = {
      kind: 'assistant', seq: 4.1, time: 4_100, turn: 1, step: 2,
      blocks: [{ kind: 'reasoning', text: 'bad path' }], interrupted: true,
    }
    const h = makeHarness({
      nodes: [user(1, 'question'), assistant(2, 'answer'), toolResult(3, 'a'), interruptedThink],
      turnEnds: new Map([[1, 5]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(2)
    const buttons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(buttons[0]!)
    expect(h.forkAt).not.toHaveBeenCalled()
  })

  it('renders assistant Markdown across history, streaming, final, and interrupted states while user text stays literal', () => {
    const markdown = '# Rendered\n\n- **one**\n- `two`'
    const h = makeHarness({ nodes: [user(1, markdown), assistant(2, markdown)] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelectorAll('h1')).toHaveLength(1)
    const literal = view.getByText((_content, element) => (
      element?.tagName === 'SPAN' && element.childElementCount === 0 && element.textContent === markdown
    ))
    expect(literal.querySelector('h1')).toBeNull()

    act(() => {
      h.setChat({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: markdown }] } })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"] h1')?.textContent).toBe('Rendered')

    act(() => {
      h.setChat({
        nodes: [user(1, markdown), assistant(2, markdown), assistant(3, markdown)],
        partial: null,
      })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"]')).toBeNull()

    act(() => {
      h.setChat({
        nodes: [
          user(1, markdown),
          assistant(2, markdown, 1, 1),
          { ...assistant(3, markdown, 1, 2), interrupted: true },
        ],
      })
    })
    expect(view.getByText('已停止')).toBeTruthy()
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
  })

  it('streaming partial frames update the tail without replacing a sibling Tool row', () => {
    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(2, 'old answer'), toolResult(3, 'a')],
    })
    const view = render(<h.ChatView {...h.props} />)
    const tool = view.getByTestId('tool-seat-a')
    const beforeHtml = tool.innerHTML
    act(() => {
      h.setChat({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'streaming…' }] } })
    })
    act(() => {
      h.setChat({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'streaming… more' }] } })
    })
    expect(view.getByText('streaming… more')).toBeTruthy()
    expect(view.getByTestId('tool-seat-a')).toBe(tool)
    expect(tool.innerHTML).toBe(beforeHtml)
  })

  it('streaming leaves neighbor tool rows and history items at zero re-renders', () => {
    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(2, 'old'), toolResult(3, 'a')],
    })
    // Count renderSlot invocations: the memo boundary holds when CallRow does
    // not re-render, so the row's renderSlot call count freezes during chunks.
    let rowRenders = 0
    h.setNodeRenderer(((key: string, owner: object) => {
      if (key !== 'conversation.chat.node'
        || (owner as RoutedChatNodeOwner).node.kind !== 'tool-call') return null
      rowRenders += 1
      return <div data-testid="counting-row" />
    }) as React.ComponentProps<typeof ChatNodeSeat>['renderSlot'])
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('counting-row')).toBeTruthy()
    const afterMount = rowRenders
    act(() => {
      h.setChat({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'chunk1' }] } })
    })
    act(() => {
      h.setChat({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'chunk1 chunk2' }] } })
    })
    expect(rowRenders).toBe(afterMount)
  })

  it('updates the selected call id handed to the Tool seat', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    render(<h.ChatView {...h.props} />)
    expect(h.toolOwners.at(-1)?.selectedCallId).toBeUndefined()
    act(() => { h.setSelection({ turnSeq: 3, callId: 'a', toolName: 'bash' }) })
    expect(h.toolOwners.at(-1)?.selectedCallId).toBe('a')
  })

  it('hands running calls to a live Tool group', () => {
    const h = makeHarness({ runningCalls: [runningCall('r1')] }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('tool-seat-r1')).toBeTruthy()
    expect(h.toolOwners[0]?.block).toMatchObject({ callId: 'r1', argsRaw: '{"command":"cmd-r1"}' })
    expect(view.getByRole('status').textContent).toBe('深度求索中...')
  })

  it('keeps the Tool renderer mounted when a running call settles into log order', () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    function StatefulToolNode({ node }: { readonly node: ChatNode<'tool-call'> }) {
      useEffect(() => {
        mounted()
        return () => { unmounted() }
      }, [])
      const root = node.data.root
      return (
        <div data-testid="stateful-tool" data-state={'kind' in root ? 'settled' : 'running'}>
          {root.callId}
        </div>
      )
    }

    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(4, 'later')],
      runningCalls: [runningCall('r1')],
    }, { running: true })
    h.props.renderSlot = ((key: string, owner: object, opts?: { fallback?: React.ReactNode }) => {
      const routed = owner as RoutedChatNodeOwner
      return key === 'conversation.chat.node' && routed.node.kind === 'tool-call'
        ? <StatefulToolNode node={routed.node} />
        : opts?.fallback ?? null
    }) as React.ComponentProps<typeof ChatNodeSeat>['renderSlot']
    const view = render(<h.ChatView {...h.props} />)
    const tool = view.getByTestId('stateful-tool')
    const row = view.container.querySelector('[data-chat-flow-key="fixture:tool:r1"]')
    expect(tool.dataset.state).toBe('running')
    expect(mounted).toHaveBeenCalledTimes(1)

    act(() => {
      h.setChat({
        nodes: [user(1, 'q'), toolResult(3, 'r1'), assistant(4, 'later')],
        runningCalls: [],
      })
      h.setSession({ running: false })
    })

    expect(view.getByTestId('stateful-tool')).toBe(tool)
    expect(view.container.querySelector('[data-chat-flow-key="fixture:tool:r1"]')).toBe(row)
    expect(tool.dataset.state).toBe('settled')
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
  })

  it('the running clock uses turn/start, ignores steering, and stays out of the live region', () => {
    const startTime = Date.now() - 125_000
    const trigger: UserMessageNode = { ...user(1, 'go'), time: startTime + 1 }
    const h = makeHarness(
      { nodes: [trigger], turnTimings: new Map([[1, { startTime }]]) },
      { running: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    // Freshly mounted (as after a reload) yet already past the 15s gate.
    const status = view.getByRole('status')
    expect(status.textContent).toMatch(/^深度求索中\.\.\.2分0\d秒$/)
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull()
    act(() => {
      h.setSession({ queue: [{
        id: 'steering-occurrence' as never,
        messageId: 'steering-message' as never,
        placement: 'steering',
        content: [{ type: 'text', text: 'also' }],
        preview: 'also',
        text: 'also',
      }] })
    })
    expect(status.textContent).toMatch(/^深度求索中\.\.\.2分0\d秒$/)
  })

  it('hands each ordered root call to the keyed business-node slot', () => {
    const block = toolResult(3, 'a')
    const h = makeHarness({ nodes: [block] })
    const calls: { key: string; owner: object; entryKey?: string }[] = []
    h.setNodeRenderer(((key: string, owner: object, opts?: { entryKey?: string; fallback?: React.ReactNode }) => {
      calls.push({ key, owner, ...(opts?.entryKey !== undefined ? { entryKey: opts.entryKey } : {}) })
      return opts?.fallback ?? null
    }) as React.ComponentProps<typeof ChatNodeSeat>['renderSlot'])
    render(<h.ChatView {...h.props} />)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      key: 'conversation.chat.node',
      owner: { node: { kind: 'tool-call' }, selectedCallId: undefined },
      entryKey: 'tool-call',
    })
    const owner = calls[0]?.owner as RoutedChatNodeOwner
    expect((owner.node.data as { readonly root: ToolCallBlock }).root).toBe(block)
    expect(owner.openFile).not.toBe(h.openFile)
    owner.openFile('src/a.ts')
    expect(h.openFile).toHaveBeenCalledWith('src/a.ts')
    owner.inspectCall('a')
    expect(h.openView).toHaveBeenCalledWith('trajectory', 'a')
  })

  it('shows a Host open refusal with the reason and retries the same path', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('xdg-open is not available'))
      .mockResolvedValueOnce(undefined)
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('src/a.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' })).toBeTruthy()
    })
    expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('xdg-open is not available')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(openFile).toHaveBeenCalledTimes(2)
    expect(openFile).toHaveBeenNthCalledWith(1, 'src/a.ts')
    expect(openFile).toHaveBeenNthCalledWith(2, 'src/a.ts')
  })

  it('keeps a non-Error Host refusal visible and dismisses it on cancel', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce('permission denied')
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('notes.md') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('permission denied')
    })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it('substitutes the unknown-open copy when the Host refusal has no text', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error(''))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('empty.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('无法打开此文件')
    })
  })

  it('names a workspace-folder Host refusal as a folder', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error(''))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('.') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件夹' }).textContent).toContain('无法打开此文件夹')
    })
  })

  it('ignores a Host refusal that settles after the dialog is dismissed', async () => {
    let rejectRetry!: (error: unknown) => void
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first refusal'))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectRetry = reject
      }))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('src/a.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('first refusal')
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { rejectRetry(new Error('late refusal')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ignores a Host open that succeeds after the dialog is dismissed', async () => {
    let resolveRetry!: () => void
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first refusal'))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveRetry = () => { resolve() }
      }))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('src/a.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('first refusal')
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await act(async () => { resolveRetry() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('prepend preserves a semantic row; a trailing user node force-scrolls', () => {
    const h = makeHarness(
      { nodes: [user(5, 'later'), assistant(6, 'a')] },
      { hasMore: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    // jsdom has no layout: fake the metrics the anchor math reads.
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, writable: true })
    const anchored = view.container.querySelector('[data-chat-flow-key="fixture:user:5"]') as HTMLDivElement
    let anchoredTop = 100
    vi.spyOn(anchored, 'getBoundingClientRect').mockImplementation(
      () => ({ top: anchoredTop, bottom: anchoredTop + 40 } as DOMRect),
    )
    readerScroll(scroller, 80)
    // Arm the paging anchor, then deliver an older page (head seq decreases).
    fireEvent.click(view.getByText('加载更早'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1600, writable: true })
    anchoredTop = 700
    act(() => {
      h.setChat({ nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a')] })
    })
    expect(scroller.scrollTop).toBe(680) // reader offset 80 + the anchored row's 600px shift
    // A new trailing user bubble (own words) force-scrolls to the bottom.
    act(() => {
      h.setChat({
        nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a'), user(9, 'mine')],
      })
    })
    expect(scroller.scrollTop).toBe(1600)
  })

  it('back-to-bottom cancels an in-flight paging anchor', () => {
    const h = makeHarness({ nodes: [user(9, 'late')] }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    readerScroll(scroller, 50)
    fireEvent.click(view.getByText('加载更早'))
    fireEvent.click(view.getByLabelText('回到底部'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_300, writable: true })
    act(() => { h.setChat({ nodes: [assistant(2, 'older'), user(9, 'late')] }) })
    expect(scroller.scrollTop).toBe(1_300)
    expect(h.chatScroll.read()).toBeNull()
  })

  it('scrolling away disables follow and shows the back-to-bottom button; clicking returns', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    readerScroll(scroller, 100) // far from bottom
    const backButton = view.getByLabelText('回到底部')
    expect(backButton).toBeTruthy()
    // Streaming growth must NOT drag a scrolled-away reader down.
    act(() => {
      h.setChat({ partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'grow' }] } })
    })
    expect(scroller.scrollTop).toBe(100)
    fireEvent.click(backButton)
    expect(scroller.scrollTop).toBe(1000)
    // At the bottom again: follow re-arms and the button unmounts.
    expect(view.queryByLabelText('回到底部')).toBeNull()
  })

  it('keeps following when a stream-finalization shrink clamp delivers its scroll', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)

    // Stream finalization shrinks the column: the browser clamps the pinned
    // position onto the new floor and delivers a scroll event. The clamp
    // lands exactly on the ledger's floor min, so it is not reader input.
    metrics.setLayout(800, 700)
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    expect(scroller.scrollTop).toBe(500)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()

    metrics.setHeight(1_200)
    act(() => { h.setSession({ running: true }) })
    expect(scroller.scrollTop).toBe(900)
  })

  it('uses the last delivered top when compositor scrolling precedes scroll delivery', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)

    // Chromium advances compositor geometry before delivering the event:
    // attribution must compare against the observed-top ledger, never a
    // baseline sampled from already-moved raw geometry.
    scroller.scrollTop = 500
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it('one ResizeObserver owns pinned dynamic-height follow and ignores growth while away', () => {
    let notify: (() => void) | undefined
    const observe = vi.fn()
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = observe
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(1_200)
    readerScroll(scroller, 200)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_400, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(200)
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('pinned dynamic-height updates select the latest Turn without reading row geometry', () => {
    let notify: (() => void) | undefined
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1
      frames.set(nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 0, bottom: 40 } as DOMRect)
    const h = makeHarness({
      nodes: [
        userInTurn(1, 'first', 1), assistant(2, 'first answer', 1),
        userInTurn(4, 'second', 2), assistant(5, 'second answer', 2),
      ],
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    })
    rect.mockClear()

    metrics.setHeight(1_200)
    act(() => { notify?.() })
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    })

    expect(scroller.scrollTop).toBe(900)
    expect(view.getByRole('button', { name: '跳转到第 2 轮' }).getAttribute('aria-current')).toBe('true')
    expect(rect).not.toHaveBeenCalled()
  })

  it('entering the at-bottom threshold does not snap the remaining scroll distance', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    // Inside FOLLOW_THRESHOLD (24) but not flush with the floor — the chrome
    // re-render from setAtBottom must not force scrollTop to scrollHeight.
    readerScroll(scroller, 690) // distance-to-bottom = 10
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(scroller.scrollTop).toBe(690)
  })

  it('under data-conversation-scroll, bottom-follow targets the host scrollport', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // Open jump uses the host, not the local .scroll node.
      expect(host.scrollTop).toBe(2000)
      readerScroll(host, 100)
      expect(view.getByLabelText('回到底部')).toBeTruthy()
      fireEvent.click(view.getByLabelText('回到底部'))
      expect(host.scrollTop).toBe(2000)
    } finally {
      host.remove()
    }
  })

  it('a remount restores the saved semantic row after width reflow', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    let anchorTop = 80
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 500 } as DOMRect),
    )
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:1') {
        return { top: anchorTop, bottom: anchorTop + 40 } as DOMRect
      }
      return { top: 0, bottom: 40 } as DOMRect
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      // Fresh open (nothing saved): the bottom jump stands.
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(2000)
      // Reader scrolls up; the position is recorded continuously.
      readerScroll(host, 100)
      // View-tab switch away and back: the view unmounts, then remounts.
      view.rerender(<div />)
      anchorTop = 560
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(580) // approximate 100 + the row's 480px reflow shift
      // The restored position is above the floor: follow stays disarmed.
      expect(view.getByLabelText('回到底部')).toBeTruthy()
    } finally {
      rect.mockRestore()
      host.remove()
    }
  })

  it('normalizes a semantic restore clamped to the bottom before an immediate remount', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2_000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    let scrollTop = 0
    Object.defineProperty(host, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.min(value, 1_500) },
    })
    document.body.appendChild(host)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:1') return { top: 300, bottom: 340 } as DOMRect
      return { top: 0, bottom: 500 } as DOMRect
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      h.chatScroll.save({ anchorKey: 'fixture:user:1', anchorTop: 80, scrollTop: 1_400 })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(1_500)
      expect(h.chatScroll.read()).toBeNull()
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(1_500)
    } finally {
      rect.mockRestore()
      host.remove()
    }
  })

  it('a remount while pinned to the bottom keeps the bottom jump', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // At the bottom: the scroll event records the pinned state (null).
      fireEvent.scroll(host)
      expect(h.chatScroll.read()).toBeNull()
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(2000)
    } finally {
      host.remove()
    }
  })

  it('paging button loads older and shows its busy label', () => {
    const h = makeHarness({ nodes: [user(5, 'later')] }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByText('加载更早'))
    expect(h.loadOlder).toHaveBeenCalledTimes(1)
    act(() => { h.setSession({ loadingOlder: true }) })
    expect(view.getByText('加载中…')).toBeTruthy()
  })

  it('shows open error and loading states', () => {
    const h = makeHarness({}, {
      openState: 'error',
      openError: { code: 'gateway/internal', message: 'boom' } as never,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText(/历史加载失败：boom/)).toBeTruthy()
    const loading = makeHarness({}, { openState: 'loading' })
    const lv = render(<loading.ChatView {...loading.props} />)
    expect(lv.getByText('载入历史…')).toBeTruthy()
  })

  it('renders command nodes as durable rows: settled text, error state, executing spinner, run-less soft-fall', () => {
    // Settled success: the bare command name is the title, the outcome text
    // the summary — neither the dispatched `/` nor its arguments reach the row
    // (the settlement text already says what the command did).
    const settled = makeHarness({ nodes: [user(1, 'hi'), command({ args: ' now' })] })
    const view = render(<settled.ChatView {...settled.props} />)
    expect(view.getByText('plan')).toBeTruthy()
    expect(view.queryByText('/plan')).toBeNull()
    expect(view.queryByText('/plan now')).toBeNull()
    expect(view.getByText('已进入 plan mode')).toBeTruthy()

    // Error outcome flips the row state; a text-less error gets the default copy.
    const failed = makeHarness({
      nodes: [command({ seq: 6, commandId: 'cmd-2' as CommandNode['commandId'], outcome: { kind: 'error' } })],
    })
    const fv = render(<failed.ChatView {...failed.props} />)
    expect(fv.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(fv.getByText('指令失败')).toBeTruthy()
    expect(fv.getByText('失败')).toBeTruthy()

    // Still executing: running state with the executing copy.
    const executing = makeHarness({
      nodes: [command({ seq: 7, commandId: 'cmd-3' as CommandNode['commandId'], outcome: null })],
    })
    const xv = render(<executing.ChatView {...executing.props} />)
    expect(xv.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(xv.getByText('执行中…')).toBeTruthy()
    expect(xv.getByText('运行中')).toBeTruthy()

    // Cross-window soft-fall (run page truncated): generic title, outcome preserved.
    const orphan = makeHarness({
      nodes: [command({ seq: 8, commandId: 'cmd-4' as CommandNode['commandId'], name: null, args: null, outcome: { kind: 'success' } })],
    })
    const ov = render(<orphan.ChatView {...orphan.props} />)
    expect(ov.getByText('指令')).toBeTruthy()
    expect(ov.getByText('已完成')).toBeTruthy()
  })

  it('renders /compact as one stateful disclosure from running through completion', () => {
    const running = command({
      commandId: 'cmd-compact' as CommandNode['commandId'],
      name: 'compact',
      outcome: null,
    })
    const h = makeHarness({ nodes: [running] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('正在压缩…')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()

    act(() => {
      h.setChat({
        nodes: [{
          ...running,
          outcome: {
            kind: 'success',
            text: 'Compacted 16 history items (~11309 tokens).',
            sourceEventSeq: 7,
          },
        }, compaction()],
      })
    })

    expect(view.queryByText('正在压缩…')).toBeNull()
    expect(view.queryByText('上下文已压缩')).toBeNull()
    expect(view.getByText('已压缩 16 条历史记录（约 11309 tokens）')).toBeTruthy()
    const row = view.getByRole('button', { name: /compact/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.querySelector('[data-compaction-icon="context"]')).not.toBeNull()
    expect(row.querySelector('[data-compaction-disclosure="collapsed"]')).not.toBeNull()
    expect(view.queryByText('保留的事实。')).toBeNull()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('[data-compaction-disclosure="expanded"]')).not.toBeNull()
    expect(view.getByRole('heading', { name: '压缩摘要' })).toBeTruthy()
  })

  it('keeps /compact no-history and error settlements on the generic command row', () => {
    const noHistory = makeHarness({
      nodes: [command({
        name: 'compact',
        outcome: { kind: 'success', text: 'No compactable history yet.' },
      })],
    })
    const noHistoryView = render(<noHistory.ChatView {...noHistory.props} />)
    expect(noHistoryView.getByText('No compactable history yet.')).toBeTruthy()
    expect(noHistoryView.queryByRole('button')).toBeNull()

    const failed = makeHarness({
      nodes: [command({
        commandId: 'cmd-compact-failed' as CommandNode['commandId'],
        name: 'compact',
        outcome: { kind: 'error', text: 'Compaction cancelled.' },
      })],
    })
    const failedView = render(<failed.ChatView {...failed.props} />)
    expect(failedView.getByText('Compaction cancelled.')).toBeTruthy()
    expect(failedView.container.querySelector('[data-state="error"]')).not.toBeNull()
  })
})
