// @vitest-environment jsdom

import type { ProcessGroupData } from '../src/client/contract/process-groups.ts'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import type {
  AssistantMessageNode, ChatNode, ChatNodeHookContext, ChatNodeOwnerProps, ChatSnapshot,
  ChatViewSlotProps, CommandNode, CompactionSummaryNode, ContextMessageNode, ConversationNode,
  LegacyConversationSlice, ModelRetryNode, StartedToolCall, SteeringMessageNode,
  ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode, UseChatNodeTurnData,
  TranscriptViewMode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  SessionListState, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationGroupedView,
  ConversationSnapshot, ConversationViewSnapshotStore, GroupKey, GroupSnapshot, NodeKey, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { KeyedSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { EMPTY_CONVERSATION_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { derivePresentationPolicy } from '../src/client/presentation-policy.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import { ChatNodeSeat } from '../src/client/chat/ChatNodeSeat.tsx'
import { useTurnDataValue } from '../src/client/chat/use-turn-data.ts'
import { bindDisclosure } from '../src/client/chat/use-disclosure.ts'
import { en, zh } from '../src/client/locale.ts'
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
import { ProcessState } from '../src/client/conversation-nodes/process-groups.ts'
import type { TurnProcessSpec } from '../src/client/contract/turn-process.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { installTurnNavigatorObserver } from './turn-navigator-fixture.ts'
import { ConversationGroupStore } from '../../ui-conversation/src/client/conversation/group-store.ts'

function installGroupedSnapshot(
  builder: ChatSnapshotBuilder, state: ProcessState, groups: ConversationGroupStore<ProcessGroupData>, source: ChatSnapshot,
): ChatSnapshot {
  const snapshot = builder.replace({ nodes: source.nodes.values(), timeline: source.timeline })
  const input = builder.groupInput()
  state.accept(input)
  const update = state.output()
  if (update !== null) groups.prepareAndInstall(update, input.readNode)
  builder.publish()
  groups.publish()
  return snapshot
}

// Every session-scope fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
// Keyless create() persists under the bare declared key; clear between cases
// so one harness's selection cannot rehydrate into the next.
beforeEach(() => {
  localStorage.clear()
  installTurnNavigatorObserver()
})

const SID = 's1' as SessionId
type RoutedChatNodeOwner = ChatNodeOwnerProps & { readonly node: ChatNode }

interface TestSessionSnapshot extends SessionSnapshot {
  readonly testInbox?: InboxState
}

function sessionSnapshot(overrides: Partial<TestSessionSnapshot> = {}): TestSessionSnapshot {
  return {
    sessionId: SID,
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
function makeSessionSource(init: Partial<TestSessionSnapshot> = {}) {
  let snap = sessionSnapshot(init)
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<TestSessionSnapshot>) => {
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
type HarnessUpdate = ChatSlice & Partial<TestSessionSnapshot> & { readonly chat?: ChatSnapshot }

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
  producer: { role: 'inject', label: null }, form: null,
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
const runningCall = (callId: string, name = 'bash'): StartedToolCall => ({
  phase: 'start' as const, callId, name, argsRaw: `{"command":"cmd-${callId}"}`, turn: 2, step: 1, time: 1_000, subCalls: [],
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
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
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
  sessionOverrides: Partial<TestSessionSnapshot> = {},
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
  const useTestSession = bindSnapshotSelector(session.source)
  const chatSource = makeChatSource(chatSlice, initialChat ?? chatSnapshot)
  const useChatNode = bindKeyedSnapshotSelector(
    key => chatSource.source.getSnapshot().nodes.source(key),
  )
  const useChatNodeProcess = bindKeyedSnapshotSelector(
    key => chatSource.source.getSnapshot().nodes.processSource(key),
  )
  let grouped: ConversationGroupedView<ProcessGroupData> | undefined
  const absentGroup = createSnapshotStore<GroupSnapshot<ProcessGroupData> | undefined>(undefined)
  const conversation = createSnapshotStore<ConversationSnapshot>({
    ...EMPTY_CONVERSATION_SNAPSHOT,
    views: {
      ...EMPTY_CONVERSATION_SNAPSHOT.views,
      grouped: (() => grouped) as ConversationViewSnapshotStore['grouped'],
    },
  })
  const useChatGroup = bindKeyedSnapshotSelector(
    key => grouped?.groupSource(key as GroupKey) ?? absentGroup,
  )
  const openFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const openSkill = vi.fn<(name: string) => void>()
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
  const performanceUsage = createSnapshotStore<'compact' | 'detailed'>('detailed')
  const t = makeTranslate(zh, commonZh)
  const toolOwners: Array<{
    callId: string
    toolName: string
    block: ToolCallBlock
    openFile: ChatNodeOwnerProps['openFile']
    inspectCall: ChatNodeOwnerProps['inspectCall']
  }> = []
  const renderCommandSlot = ((_key: string, _owner: object, opts?: { fallback?: React.ReactNode }) =>
    opts?.fallback ?? null) as React.ComponentProps<typeof CommandNodeView>['renderSlot']
  const renderTurnTailSlot = (() => null) as
    React.ComponentProps<typeof TurnTailNodeView>['renderSlot']
  let nodeSlotOverride: React.ComponentProps<typeof ChatNodeSeat>['renderSlot'] | undefined
  const renderNodeSlot = ((key: string, owner: object, opts?: {
    fallback?: React.ReactNode
    hookContext?: unknown
  }) => {
    if (nodeSlotOverride !== undefined) return nodeSlotOverride(key as never, owner as never, opts as never)
    if (key !== 'conversation.chat.node') return opts?.fallback ?? null
    const nodeOwner = owner as RoutedChatNodeOwner
    const { turnData, disclosureReset } = opts?.hookContext as ChatNodeHookContext
    const useTurnData: UseChatNodeTurnData = dataKey => useTurnDataValue(turnData, dataKey)
    const useDisclosure = bindDisclosure(disclosureReset)
    const nodeProps = { ...props, ...nodeOwner, useTurnData, useDisclosure, __renders: undefined }
    switch (nodeOwner.node.kind) {
      case 'user':
        return <UserMessageNodeView {...nodeProps} node={nodeOwner.node} />
      case 'steering':
        return <UserMessageNodeView {...nodeProps} node={nodeOwner.node} />
      case 'context':
        return <ContextMessageNodeView {...nodeProps} node={nodeOwner.node} />
      case 'assistant-step':
        return <AssistantNodeView {...nodeProps} node={nodeOwner.node} usePresentation={props.usePresentation} />
      case 'command':
        return (
          <CommandNodeView
            {...nodeProps}
            node={nodeOwner.node}
            renderSlot={renderCommandSlot}
            SessionProvider={props.SessionProvider}
          />
        )
      case 'manual-compaction':
        return <ManualCompactionNodeView {...nodeProps} node={nodeOwner.node} />
      case 'compaction':
        return <CompactionNodeView {...nodeProps} node={nodeOwner.node} />
      case 'model-retry':
        return <RetryNodeView {...nodeProps} node={nodeOwner.node} />
      case 'turn-error':
        return <TurnErrorNodeView {...nodeProps} node={nodeOwner.node} />
      case 'turn-max-tokens':
        return <TurnMaxTokensNodeView {...nodeProps} node={nodeOwner.node} />
      case 'turn-process':
        return <TurnProcessNodeView {...nodeProps} node={nodeOwner.node} />
      case 'system-prompt':
        return <SystemPromptNodeView {...nodeProps} node={nodeOwner.node} />
      case 'turn-tail':
        return (
          <TurnTailNodeView
            usePerformanceUsage={bindSnapshotSelector(performanceUsage)}
            {...nodeProps}
            node={nodeOwner.node}
            renderSlot={renderTurnTailSlot}
            SessionProvider={props.SessionProvider}
          />
        )
      case 'unknown':
        return <UnknownNodeView {...nodeProps} node={nodeOwner.node} />
      case 'tool-call': {
        const block = nodeOwner.node.data.root
        const toolName = 'kind' in block ? block.call?.name ?? '' : block.name
        const tool = {
          callId: block.callId,
          toolName,
          block,
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
  }) as React.ComponentProps<typeof ChatNodeSeat>['renderSlot']
  const renderSlot = renderNodeSlot
  // SessionProvider seat arrives with the session-scope child declaration;
  // ChatView never invokes it (pass-through stub).
  const SessionProviderStub: ChatViewSlotProps['SessionProvider'] = ({ children }) => <>{children}</>
  const props: ChatViewSlotProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    sessionId: SID,
    useSession: bindSnapshotSelector(session.source),
    useChat: bindSnapshotSelector(chatSource.source),
    useChatNode,
    useChatNodeProcess,
    useChatGroup,
    useConversation: bindSnapshotSelector(conversation),
    useTrajectory: (() => { throw new Error('unused') }),
    useSessions: emptySessions(),
    useSessionRetainInfo: () => undefined,
    useResource,
    useSessionStatus: bindSnapshotSelector(
      createSnapshotStore<SessionStatusSnapshot>(new Map()),
    ),
    useWorkspaces: emptyWorkspaces(),
    useProjection: (key: string) => {
      const inbox = useTestSession(snapshot => snapshot.testInbox)
      return key === 'inbox' ? inbox : outlineValue
    },
    useInput: (() => { throw new Error('unused') }),
    inputActions: {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => false,
      setDraft: () => {},
      addAttachments: () => true,
      removeAttachment: () => {},
      pruneAttachments: () => {},
      submit: () => {},
    },
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    usePresentation: bindSnapshotSelector(derivePresentationPolicy(transcriptView)),
    renderSlot,
    SessionProvider: SessionProviderStub,
    inspectCall: (callId: string) => { openView('trajectory', callId) },
    viewRequest: null,
    openView,
    completeViewRequest: () => {},
    openFile,
    openSkill,
    openExternalLink: vi.fn(),
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
  return {
    set, setSession: session.set, setChat: chatSource.set, ChatView, props,
    openFile, openSkill, loadOlder, loadThrough, openView,
    setOutline: (value: unknown) => { outlineValue = value },
    chatScroll, forkAt, toolOwners,
    setPerformanceUsage: (mode: 'compact' | 'detailed') => { performanceUsage.set(mode) },
    setGrouped: (value: ConversationGroupedView<ProcessGroupData> | undefined) => {
      grouped = value
      conversation.set({ ...conversation.getSnapshot() })
    },
    setTranscriptView: (mode: TranscriptViewMode) => { transcriptView.set(mode) },
    setNodeRenderer: (renderer: React.ComponentProps<typeof ChatNodeSeat>['renderSlot']) => {
      nodeSlotOverride = renderer
    },
  }
}

/** Simulate reader input (any device): a delivered position that deviates
 * from the observed-top ledger of programmatic writes. */
function readerScroll(element: HTMLElement, top: number): void {
  fireEvent.wheel(element)
  element.scrollTop = top
  fireEvent.scroll(element)
  fireEvent(element, new Event('scrollend'))
}

function turnProcessControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-turn-process]')
}

function withClock(time: number, run: () => void): () => void {
  return () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(time)
      run()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  }
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
  const next = builder.replace({
    nodes: [prompt, ...snapshot.nodes.values()],
    timeline: snapshot.timeline,
  })
  builder.publish()
  return next
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

  it('opens Markdown references to unmodified files with line navigation', () => {
    const h = makeHarness({
      nodes: [user(1, 'explain'), assistant(2, '[source](src/index.ts#L24-L30)', 1)],
      turnEnds: new Map([[1, 2]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByRole('button', { name: 'source' }))
    expect(h.openFile).toHaveBeenCalledWith('src/index.ts', { line: 24 })
  })

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
    // The hour rolls at exactly 3600s, never at 60 displayed minutes.
    expect(formatRunDuration(3_599_999, t)).toBe('59分59秒')
    expect(formatRunDuration(3_600_000, t)).toBe('1小时00分00秒')
    expect(formatRunDuration(3_903_000, t)).toBe('1小时05分03秒')
    expect(formatRunDuration(7_261_000, t)).toBe('2小时01分01秒')
  })

  it('formatRunDuration uses the English hour template', () => {
    const t = makeTranslate(en, commonEn)
    expect(formatRunDuration(3_903_000, t)).toBe('1h 05m 03s')
  })

})

describe('ChatView', () => {
  it('renders only referenced Nodes without deleting unreferenced Node data', () => {
    const snapshot = chatSnapshotFixture({ nodes: [user(1, 'included'), user(2, 'omitted')] })
    const h = makeHarness({}, {}, snapshot)
    const [included, omitted] = snapshot.order
    if (included === undefined || omitted === undefined) throw new Error('expected two Nodes')
    const groupStore = new ConversationGroupStore<ProcessGroupData>()
    groupStore.prepareAndInstall({
      entries: [{ kind: 'node', key: included as NodeKey }],
      groups: { kind: 'replace', snapshots: [] },
    }, id => snapshot.nodes.get(id))
    h.setGrouped(groupStore)

    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('included')).toBeTruthy()
    expect(view.queryByText('omitted')).toBeNull()
    expect(snapshot.nodes.get(omitted)).toBeDefined()
  })

  it('keeps grouped Node instances mounted across presentation modes and group data updates', () => {
    const snapshot = chatSnapshotFixture({ nodes: [user(1, 'outside'), userInTurn(2, 'inside', 1)] })
    const h = makeHarness({}, {}, snapshot)
    const [outside, inside] = snapshot.order.map(key => ({ kind: 'node' as const, key: key as NodeKey }))
    if (outside === undefined || inside === undefined) throw new Error('expected two Nodes')
    const key = 'process' as GroupKey
    const groupStore = new ConversationGroupStore<ProcessGroupData>()
    const record = { key, data: { turn: 1, closed: false, summary: { counts: [], running: undefined, runningDetail: '' } }, members: [inside] }
    groupStore.prepareAndInstall({
      entries: [outside, { kind: 'group', key }],
      groups: { kind: 'replace', snapshots: [record] },
    }, id => snapshot.nodes.get(id))
    groupStore.publish()
    h.setGrouped(groupStore)
    h.setNodeRenderer(((slot: string, owner: object) => {
      if (slot !== 'conversation.chat.node' || !('node' in owner)) return null
      const node = (owner as RoutedChatNodeOwner).node
      return <input aria-label={node.key} defaultValue={node.kind} />
    }) as ChatViewSlotProps['renderSlot'])
    const view = render(<h.ChatView {...h.props} />)
    const groupHeader = view.container.querySelector<HTMLButtonElement>('[data-chat-group-key] [data-process-activity]')!
    fireEvent.click(groupHeader)
    const input = view.getByRole('textbox', { name: inside.key }) as HTMLInputElement
    const parent = input.closest('[data-chat-group-key]')
    expect(parent).not.toBeNull()
    expect(parent?.tagName).toBe('DIV')
    fireEvent.change(input, { target: { value: 'retained local input' } })
    const observe = vi.spyOn(ResizeObserver.prototype, 'observe')
    for (const mode of ['standard', 'detailed', 'compact'] as const) {
      act(() => { h.setTranscriptView(mode) })
      expect(view.getByRole('textbox', { name: inside.key })).toBe(input)
      expect(input.value).toBe('retained local input')
      expect(input.closest('[data-chat-group-key]')).toBe(parent)
      expect(observe).not.toHaveBeenCalled()
    }
    fireEvent.click(groupHeader)
    expect(groupHeader.getAttribute('aria-expanded')).toBe('false')
    act(() => { h.setTranscriptView('detailed') })
    expect(view.getByRole('textbox', { name: inside.key })).toBe(input)
    act(() => { h.setTranscriptView('compact') })
    expect(view.queryByRole('textbox', { name: inside.key })).toBeNull()
    expect(groupHeader.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(groupHeader)
    expect(view.getByRole('textbox', { name: inside.key })).toBe(input)
    act(() => {
      groupStore.prepareAndInstall({ groups: { kind: 'apply', upserts: [{ ...record, data: { ...record.data, closed: true } }], removes: [] } }, id => snapshot.nodes.get(id))
      groupStore.publish()
    })
    expect(view.getByRole('textbox', { name: inside.key })).toBe(input)
    expect(view.getByRole('textbox', { name: outside.key }).closest('[data-chat-group-key]')).toBeNull()
    act(() => {
      groupStore.clear()
      groupStore.publish()
    })
    expect(view.queryByRole('textbox', { name: inside.key })).toBeNull()
    act(() => { h.setGrouped(groupStore) })
    expect(view.queryByRole('textbox', { name: outside.key })).toBeNull()
  })

  it('expands only the running Turn groups when switching work-details modes', () => {
    const nodes = [
      userInTurn(1, 'old question', 1), reasoningAssistant(2, 'old analysis', 1, 1),
      assistant(3, 'old progress', 1, 2), steering(4, 'old direction', 1),
      reasoningAssistant(5, 'old follow-up analysis', 1, 3), assistant(6, 'old answer', 1, 4),
      userInTurn(8, 'current question', 2), reasoningAssistant(9, 'current analysis', 2, 1),
    ]
    const builder = new ChatSnapshotBuilder()
    const groups = new ConversationGroupStore<ProcessGroupData>()
    const state = new ProcessState()
    const project = (closed: boolean) => installGroupedSnapshot(builder, state, groups, chatSnapshotFixture({
      nodes: closed ? [...nodes, assistant(10, 'current answer', 2, 2)] : nodes,
      turnTimings: new Map([[1, { startTime: 0 }], [2, { startTime: 8_000 }]]),
      turnEnds: new Map(closed ? [[1, 7], [2, 11]] : [[1, 7]]),
    }))
    const h = makeHarness({ chat: project(false) }, { running: true })
    h.setGrouped(groups)
    const view = render(<h.ChatView {...h.props} />)
    const roots = [...view.container.querySelectorAll<HTMLElement>('[data-chat-group-key]')]
    const headers = roots.map(root => root.querySelector<HTMLButtonElement>('[data-process-activity]')!)
    const bodies = roots.map(root => root.querySelector<HTMLElement>('[data-step-process-body]')!)
    expect(roots).toHaveLength(3)
    expect(bodies.map(body => body.hasAttribute('hidden'))).toEqual([true, true, true])
    fireEvent.click(headers[0]!)

    for (const mode of ['standard', 'detailed', 'compact', 'detailed'] as const) {
      act(() => { h.setTranscriptView(mode) })
      expect(bodies.map(body => body.hasAttribute('hidden'))).toEqual([false, true, mode !== 'detailed'])
      expect(headers.map(header => header.closest('[hidden]') !== null)).toEqual([false, false, mode === 'detailed'])
      expect([...view.container.querySelectorAll('[data-chat-group-key]')]).toEqual(roots)
    }

    act(() => { h.set({ chat: project(true), running: false }) })
    const control = view.container.querySelector<HTMLButtonElement>('[data-turn-process="2"]')!
    expect(control.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(control)
    expect(roots[2]!.closest('[hidden]')).toBeNull()
    expect(headers[2]!.closest('[hidden]')).toBeNull()
    expect(bodies[2]!.hasAttribute('hidden')).toBe(true)
    expect(bodies[0]!.hasAttribute('hidden')).toBe(false)
    expect(bodies[1]!.hasAttribute('hidden')).toBe(true)

    act(() => { h.setTranscriptView('verbose') })
    expect(roots.every(root => root.closest('[hidden]') === null)).toBe(true)
    expect(headers.every(header => header.closest('[hidden]') !== null)).toBe(true)
    expect(bodies.every(body => !body.hasAttribute('hidden'))).toBe(true)
    expect(control.disabled).toBe(true)
    expect(control.textContent).toContain(h.props.t('message.turnProcess.took', { duration: formatRunDuration(3_000, h.props.t) }))
    fireEvent.click(control)
    expect(bodies.every(body => !body.hasAttribute('hidden'))).toBe(true)
    expect([...view.container.querySelectorAll<HTMLElement>('[data-chat-group-key]')]).toEqual(roots)
  })

  it.each([
    { initialHeight: 200, closed: true },
    { initialHeight: 600, closed: true },
    { initialHeight: 600, closed: false },
  ])('opens and follows a $initialHeight px process group with closed=$closed', ({ initialHeight, closed }) => {
    const observers = new Set<Observer>()
    class Observer implements ResizeObserver {
      readonly targets = new Set<Element>()
      constructor(readonly callback: ResizeObserverCallback) { observers.add(this) }
      observe(target: Element): void { this.targets.add(target) }
      unobserve(target: Element): void { this.targets.delete(target) }
      disconnect(): void { observers.delete(this) }
    }
    vi.stubGlobal('ResizeObserver', Observer)
    const snapshot = chatSnapshotFixture({ nodes: [user(1, 'inside')] })
    const h = makeHarness({}, {}, snapshot)
    const key = 'observed-process' as GroupKey
    const groups = new ConversationGroupStore<ProcessGroupData>()
    const group: GroupSnapshot<ProcessGroupData> = {
      key, members: [{ kind: 'node', key: snapshot.order[0] as NodeKey }],
      data: { turn: 1, closed, summary: { counts: [], running: undefined, runningDetail: '' } },
    }
    groups.prepareAndInstall({
      entries: [{ kind: 'group', key }],
      groups: { kind: 'replace', snapshots: [group] },
    }, key => snapshot.nodes.get(key))
    h.setGrouped(groups)
    const view = render(<h.ChatView {...h.props} />)
    const header = view.container.querySelector<HTMLButtonElement>('[data-process-activity]')!
    const body = view.container.querySelector<HTMLElement>('[data-step-process-body]')!
    let reads = 0
    let top = 0
    let height = initialHeight
    let animatedTop: number | null = null
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      if (options.behavior === 'smooth') animatedTop = options.top ?? top
      else { animatedTop = null; top = options.top ?? top }
    })
    const finishScroll = (): void => {
      top = animatedTop ?? top
      animatedTop = null
      fireEvent.scroll(body)
      fireEvent(body, new Event('scrollend'))
    }
    Object.defineProperties(body, {
      scrollTop: { get: () => { reads++; return top }, set: (value: number) => { top = value } },
      clientHeight: { get: () => { reads++; return 200 } },
      scrollHeight: { get: () => { reads++; return height } },
      scrollTo: { value: scrollTo },
    })

    fireEvent.click(header)
    expect(reads).toBe(0)
    const observer = [...observers].find(observer => observer.targets.has(body))!
    expect(observer).toBeDefined()
    act(() => { observer.callback([], observer) })
    expect(top).toBe(closed ? 0 : initialHeight - 200)
    expect(body.hasAttribute('data-scroll-up')).toBe(!closed && initialHeight > 200)
    expect(body.hasAttribute('data-scroll-down')).toBe(closed && initialHeight > 200)

    height = 800
    act(() => { observer.callback([], observer) })
    finishScroll()
    expect(top).toBe(closed ? 0 : 600)

    top = 400
    fireEvent.scroll(body)
    expect(body.hasAttribute('data-scroll-up')).toBe(true)
    expect(body.hasAttribute('data-scroll-down')).toBe(true)
    height = 1_000
    act(() => { observer.callback([], observer) })
    expect(top).toBe(400)

    top = 800
    fireEvent.scroll(body)
    height = 1_200
    act(() => { observer.callback([], observer) })
    finishScroll()
    expect(top).toBe(1_000)
    expect(body.hasAttribute('data-scroll-down')).toBe(false)

    height = 1_400
    act(() => { observer.callback([], observer) })
    expect(animatedTop).toBe(1_200)
    const beforeNestedEnd = reads
    fireEvent(body.firstElementChild!, new Event('scrollend', { bubbles: true }))
    expect(reads).toBe(beforeNestedEnd)
    // Find/focus can reposition the body without firing its input handlers.
    top = 900
    animatedTop = null
    const requests = scrollTo.mock.calls.length
    finishScroll()
    expect(animatedTop).toBeNull()
    expect(scrollTo).toHaveBeenCalledTimes(requests)
    height = 1_600
    act(() => { observer.callback([], observer) })
    expect(top).toBe(900)
    expect(scrollTo).toHaveBeenCalledTimes(requests)
    const measured = reads
    fireEvent.click(header)
    expect(reads).toBe(measured)
    expect(observers.has(observer)).toBe(false)

    height = 1_400
    fireEvent.click(header)
    expect(reads).toBe(measured)
    const reopened = [...observers].find(observer => observer.targets.has(body))!
    act(() => { reopened.callback([], reopened) })
    expect(top).toBe(closed ? 0 : 1_200)
    expect(body.hasAttribute('data-scroll-down')).toBe(closed)

    top = 400
    fireEvent.scroll(body)
    act(() => {
      groups.prepareAndInstall({ groups: { kind: 'apply', removes: [], upserts: [{
        ...group, data: { ...group.data, closed: true },
      }] } }, key => snapshot.nodes.get(key))
      groups.publish()
    })
    expect(top).toBe(400)
    expect(observers.has(reopened)).toBe(true)
    height = 1_600
    act(() => { reopened.callback([], reopened) })
    expect(top).toBe(400)
    fireEvent.click(header)
    fireEvent.click(header)
    const historical = [...observers].find(observer => observer.targets.has(body))!
    act(() => { historical.callback([], historical) })
    expect(top).toBe(0)

    top = 300
    fireEvent.scroll(body)
    fireEvent.click(header)
    fireEvent(body, new Event('beforematch'))
    const found = [...observers].find(observer => observer.targets.has(body))!
    act(() => { found.callback([], found) })
    expect(top).toBe(300)
  })

  it('does not recalculate settled group titles when work-details mode changes', () => {
    const snapshot = chatSnapshotFixture({ nodes: Array.from({ length: 41 }, (_, index) => user(index + 1, `member ${index}`)) })
    const h = makeHarness({}, {}, snapshot)
    const groupStore = new ConversationGroupStore<ProcessGroupData>()
    const groups = snapshot.order.map((nodeKey, index): GroupSnapshot<ProcessGroupData> => ({
      key: `settled-${index}` as GroupKey,
      data: {
        turn: 1, closed: index < 40,
        summary: { counts: [], running: index < 40 ? undefined : 'commands', runningDetail: index < 40 ? '' : 'pwd' },
      },
      members: [{ kind: 'node', key: nodeKey as NodeKey }],
    }))
    groupStore.prepareAndInstall({
      entries: groups.map(group => ({ kind: 'group', key: group.key })),
      groups: { kind: 'replace', snapshots: groups },
    }, key => snapshot.nodes.get(key))
    h.setGrouped(groupStore)
    const translate = vi.fn(h.props.t)
    const view = render(<h.ChatView {...h.props} t={translate} />)
    const allHeaders = [...view.container.querySelectorAll('[data-process-activity]')]
    const headers = allHeaders.slice(0, 40)
    expect(headers).toHaveLength(40)
    const titles = headers.map(header => header.textContent)

    for (const mode of ['standard', 'detailed', 'compact'] as const) {
      translate.mockClear()
      act(() => { h.setTranscriptView(mode) })
      expect(translate.mock.calls.filter(([key]) => key === 'message.stepProcess.thinking')).toHaveLength(0)
      expect([...view.container.querySelectorAll('[data-process-activity]')]).toEqual(allHeaders)
      expect(headers.map(header => header.textContent)).toEqual(titles)
      const liveLabel = h.props.t('message.stepProcess.commands')
      expect(allHeaders[40]?.textContent).toBe(mode === 'compact' ? liveLabel
        : `${liveLabel}${h.props.t('message.turnProcess.separator')}pwd`)
    }
    const running = groups[40]!
    act(() => {
      groupStore.prepareAndInstall({ groups: { kind: 'apply', removes: [], upserts: [{
        ...running, data: { ...running.data, closed: true },
      }] } }, key => snapshot.nodes.get(key))
      groupStore.publish()
    })
    translate.mockClear()
    act(() => { h.setTranscriptView('standard') })
    expect(translate.mock.calls.filter(([key]) => key.startsWith('message.stepProcess.'))).toHaveLength(0)
  })

  it('passes independently keyed group parts to business Node renderers', () => {
    const snapshot = chatSnapshotFixture({ nodes: [assistant(1, 'answer')] })
    const h = makeHarness({}, {}, snapshot)
    const nodeKey = snapshot.order.find(key => snapshot.nodes.get(key)?.kind === 'assistant-step') as NodeKey
    const key = 'parts' as GroupKey
    const groupStore = new ConversationGroupStore<ProcessGroupData>()
    groupStore.prepareAndInstall({
      entries: [{ kind: 'group', key }, { kind: 'node', key: nodeKey, groupPart: 'response' }],
      groups: { kind: 'replace', snapshots: [{ key, data: { turn: 1, closed: false, summary: { counts: [], running: undefined, runningDetail: '' } }, members: [{ kind: 'node', key: nodeKey, groupPart: 'reasoning' }] }] },
    }, id => snapshot.nodes.get(id))
    h.setGrouped(groupStore)
    h.setNodeRenderer(((slot: string, owner: object) => {
      if (slot !== 'conversation.chat.node' || !('node' in owner)) return null
      return <span>{(owner as RoutedChatNodeOwner).groupPart}</span>
    }) as ChatViewSlotProps['renderSlot'])
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('reasoning').closest('[data-chat-group-key]')).not.toBeNull()
    expect(view.getByText('response').closest('[data-chat-group-key]')).toBeNull()
    const anchors = [...view.container.querySelectorAll('[data-chat-group-part]')]
      .map(element => element.getAttribute('data-chat-flow-key'))
    expect(new Set(anchors).size).toBe(2)
    expect([...view.container.querySelectorAll('[data-chat-group-part]')]
      .map(element => element.getAttribute('data-chat-node-key'))).toEqual([nodeKey, nodeKey])
  })

  it('rebinds grouped members when registry rebuilding replaces the Node store', () => {
    const snapshot = chatSnapshotFixture({ nodes: [user(1, 'before rebuild')] })
    const h = makeHarness({}, {}, snapshot)
    const key = 'retained-group' as GroupKey
    const members = snapshot.order.map(id => ({ kind: 'node' as const, key: id as NodeKey }))
    const groups = new ConversationGroupStore<ProcessGroupData>()
    groups.prepareAndInstall({
      entries: [{ kind: 'group', key }],
      groups: { kind: 'replace', snapshots: [{ key, data: { turn: 1, closed: false, summary: { counts: [], running: undefined, runningDetail: '' } }, members }] },
    }, id => snapshot.nodes.get(id))
    groups.publish()
    h.setGrouped(groups)
    const view = render(<h.ChatView {...h.props} />)
    const original = view.getByText('before rebuild').closest('[data-chat-anchor-key]')
    const builder = new ChatSnapshotBuilder()
    const replacement = builder.replace({ nodes: snapshot.nodes.values(), timeline: snapshot.timeline })
    act(() => { h.set({ chat: replacement }) })
    const current = replacement.nodes.get(members[0]!.key) as ChatNode<'user'>
    act(() => {
      builder.apply({
        upserts: [{ ...current, data: { ...current.data, content: [{ type: 'text', text: 'after rebuild' }] } }],
        timeline: snapshot.timeline,
      })
      builder.publish()
    })
    expect(view.queryByText('before rebuild')).toBeNull()
    expect(view.getByText('after rebuild').closest('[data-chat-anchor-key]')).toBe(original)
    expect(groups.groupSource(key).getSnapshot()?.members).toBe(members)
  })

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

    act(() => { h.setTranscriptView('compact') })

    expect(railRenders).toBe(afterMount)
  })

  it('projects loaded turns into prompt and response navigation previews', async () => {
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
    const first = await view.findByRole('button', { name: '跳转到第 1 轮' })
    expect(within(navigation).getAllByRole('button').map(mark => mark.getAttribute('aria-label'))).toEqual([
      '跳转到第 1 轮', '跳转到第 2 轮',
    ])
    const second = view.getByRole('button', { name: '跳转到第 2 轮' })
    expect(second.getAttribute('aria-current')).toBe('true')
    fireEvent.focus(first)
    const preview = view.getByRole('tooltip')
    expect(preview.textContent).toContain('first prompt')
    expect(preview.textContent).toContain('first response')
  })

  it('jumps to a turn anchor and reflows stable marks after an older page arrives', async () => {
    const later = [
      userInTurn(4, 'second prompt', 2), assistant(5, 'second response', 2),
      userInTurn(7, 'third prompt', 3), assistant(8, 'third response', 3),
    ]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const second = await view.findByRole('button', { name: '跳转到第 2 轮' })

    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
    expect(movedSecond).toBe(second)
    expect(within(view.getByRole('navigation')).getAllByRole('button').map(mark => mark.getAttribute('aria-label'))).toEqual([
      '跳转到第 1 轮', '跳转到第 2 轮', '跳转到第 3 轮',
    ])
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
    const first = await view.findByRole('button', { name: '加载并跳转到第 1 轮' })
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
    await waitFor(() => { expect(first.getAttribute('aria-busy')).toBeNull() })
    expect(h.loadThrough.mock.calls).toEqual([[0], [0]])
    expect(view.getByRole('button', { name: '跳转到第 3 轮' }).getAttribute('aria-current')).toBe('true')
  })

  it('uses a known turn landing without hit testing or consuming rail scroll as transcript input', async () => {
    const original = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    const hitTest = vi.fn((): Element[] => [])
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: hitTest })
    try {
      const h = makeHarness({ nodes: [
        userInTurn(1, 'first', 1), assistant(2, 'first answer', 1),
        userInTurn(4, 'second', 2), assistant(5, 'second answer', 2),
      ] })
      const view = render(<h.ChatView {...h.props} />)
      const first = await view.findByRole('button', { name: '跳转到第 1 轮' })
      const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
      installScrollMetrics(scroller, 1_500, 300)
      const row = view.container.querySelector('[data-chat-anchor-key="fixture:user:1"]') as HTMLElement
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 300))
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 - scroller.scrollTop, 800, 40))
      readerScroll(scroller, 600)
      scroller.scrollTop = 500
      fireEvent.scroll(scroller)
      hitTest.mockClear()

      fireEvent.click(first)
      fireEvent.scroll(scroller)
      fireEvent(scroller, new Event('scrollend'))
      const rail = view.getByRole('navigation').firstElementChild as HTMLElement
      fireEvent.scroll(rail)
      fireEvent(rail, new Event('scrollend', { bubbles: true }))

      expect(scroller.scrollTop).toBe(76)
      expect(first.getAttribute('aria-current')).toBe('true')
      expect(hitTest).not.toHaveBeenCalled()
    } finally {
      if (original === undefined) Reflect.deleteProperty(document, 'elementsFromPoint')
      else Object.defineProperty(document, 'elementsFromPoint', original)
    }
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

    const first = await view.findByRole('button', { name: '加载并跳转到第 1 轮' })
    fireEvent.click(first)
    // The click itself leaves the tail...
    expect(view.getByRole('button', { name: '回到底部' })).toBeTruthy()
    // ...so a non-reader scroll delivery at the floor (the first prepend's
    // compensation fires one) no longer snaps to the tail and cancel the jump.
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLElement
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
    const first = await view.findByRole('button', { name: '加载并跳转到第 1 轮' })
    fireEvent.click(first)
    // The session-side guard refuses the busy-pager jump instantly, yet the
    // mark stays busy instead of degrading to the nearest loaded turn.
    await act(async () => {})
    expect(h.loadThrough.mock.calls).toEqual([[0]])
    expect(first.getAttribute('aria-busy')).toBe('true')

    // The plain pull settles: the flip re-settles the jump, which repages.
    act(() => { h.setSession({ loadingOlder: false }) })
    await waitFor(() => { expect(first.getAttribute('aria-busy')).toBeNull() })
    expect(h.loadThrough.mock.calls).toEqual([[0], [0]])
  })

  it('scrolls the fixed-pitch rail inside its frame with gradient fades at the scrollable ends', async () => {
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
    const scroller = nav.querySelector('[class*="scroller"]') as HTMLElement
    const latest = await within(nav).findByRole('button', { name: '跳转到第 60 轮' })
    expect(scroller.scrollTop).toBe(302)
    expect(within(nav).getAllByRole('button').length).toBeLessThan(60)
    expect(latest.getAttribute('aria-current')).toBe('true')
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(scroller.className).toContain('fadeBottom')
    expect(scroller.className).not.toContain('fadeTop')

    scroller.scrollTop = 150
    fireEvent.scroll(scroller)
    expect(scroller.className).toContain('fadeTop')
    expect(scroller.className).toContain('fadeBottom')
    fireEvent.pointerMove(within(nav).getByRole('button', { name: '加载并跳转到第 25 轮' }))
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
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:0') {
        const top = 100 - scroller.scrollTop
        return { top, bottom: top + 40 } as DOMRect
      }
      return { top: 0, bottom: 300 } as DOMRect
    })

    fireEvent.click(await view.findByRole('button', { name: '加载并跳转到第 1 轮' }))
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
    expect(scroller.scrollTop).toBe(76)
    // The mark stays busy until the jump settles: the loader's completion
    // runs the final landing correction after the load-earlier button leaves.
    expect(first.getAttribute('aria-busy')).toBe('true')
    await act(async () => { releaseJump?.() })
    await waitFor(() => { expect(first.getAttribute('aria-busy')).toBeNull() })
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(scroller.scrollTop).toBe(76)
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
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
    act(() => { h.set({ loadingOlder: true }) })
    // The reader moves after the request starts; this, not the click-time
    // row, is the intent the arriving page must preserve.
    firstTop = -200
    nextTop = 60
    readerScroll(scroller, 90)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1300, writable: true })
    nextTop = 560
    act(() => {
      h.set({ nodes: [assistant(2, 'older'), user(9, 'first visible'), user(10, 'next visible')], loadingOlder: false })
    })
    expect(scroller.scrollTop).toBe(590) // latest 90 + the anchored row's 500px prepend shift
  })

  it.each([
    { mode: 'compact', anchor: 'group' }, { mode: 'standard', anchor: 'group' },
    { mode: 'detailed', anchor: 'group' },
    { mode: 'compact', anchor: 'node' }, { mode: 'standard', anchor: 'node' }, { mode: 'detailed', anchor: 'node' },
  ] as const)(
    'keeps the first visible item in place when paging inserts a steering boundary ($mode, $anchor)', ({ mode, anchor }) => {
      const tool = (seq: number, id: string) => ({ ...toolResult(seq, id), turn: 1 })
      const initial = { nodes: [tool(4, 'retained'), assistant(6, 'answer', 1, 2)], turnEnds: new Map([[1, 7]]) }
      let source = chatSnapshotFixture(initial)
      const builder = new ChatSnapshotBuilder()
      const state = new ProcessState()
      const groups = new ConversationGroupStore<ProcessGroupData>()
      const h = makeHarness({ chat: installGroupedSnapshot(builder, state, groups, source), hasMore: true })
      h.setGrouped(groups)
      h.setTranscriptView(mode)
      const view = render(<h.ChatView {...h.props} />)
      const control = turnProcessControl(view.container)!
      const controlSeat = control.closest<HTMLElement>('[data-chat-flow-key]')!
      fireEvent.click(control)
      const group = view.container.querySelector<HTMLElement>('[data-chat-group-key]')!
      const header = group.querySelector<HTMLButtonElement>('[data-process-activity]')!
      if (anchor === 'node') fireEvent.click(header)
      const body = group.querySelector<HTMLElement>('[data-step-process-body]')!
      const old = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:tool:retained"]')!
      const pinned = anchor === 'group' ? group : old
      const expectedTop = anchor === 'group' ? 30 : 60
      const expectedScroll = anchor === 'group' ? 200 : 300
      const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement!
      installScrollMetrics(scroller, 1500, 400)
      let paged = false
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this === scroller) return new DOMRect(0, 0, 500, 400)
        const top = this === old ? 60 + (paged ? 300 : 0)
          : this === body ? 60 + (paged ? 200 : 0)
            : this === group ? 30 + (paged ? 200 : 0) : 0
        return new DOMRect(0, top - scroller.scrollTop, 500, 24)
      })
      Object.defineProperties(body, {
        clientHeight: { get: () => paged ? 200 : 100 },
        scrollHeight: { get: () => paged ? 200 : 100 },
      })
      fireEvent.click(view.getByText('加载更早'))
      expect(pinned.closest('[hidden]')).toBeNull()
      expect(pinned.hasAttribute('data-chat-paging-anchor')).toBe(true)
      expect(controlSeat.hasAttribute('data-chat-paging-anchor')).toBe(false)
      expect(group.hasAttribute('data-chat-paging-anchor')).toBe(anchor !== 'node')
      act(() => {
        paged = true
        source = chatSnapshotFixture({ ...initial, nodes: [
          tool(1, 'earlier'), steering(2, 'historical direction', 1), tool(3, 'before-retained'), ...initial.nodes,
        ] }, source)
        h.set({ chat: installGroupedSnapshot(builder, state, groups, source) })
        h.setGrouped(groups)
      })

      expect(pinned.getBoundingClientRect().top).toBe(expectedTop)
      expect(scroller.scrollTop).toBe(expectedScroll)
      expect(view.container.querySelector('[data-chat-node-key="fixture:tool:retained"]')).toBe(old)
      expect(old.closest('[data-chat-group-key]')).toBe(group)
      expect(control.disabled).toBe(true)
      expect(group.hasAttribute('hidden')).toBe(false)
      expect(header.getAttribute('aria-expanded')).toBe(String(anchor === 'node'))
      expect(view.container.querySelector('[data-chat-flow-kind="steering"]')?.closest('[data-chat-group-key]')).toBeNull()
      expect(h.chatScroll.read()?.anchorKey).toBe(pinned.dataset.chatAnchorKey)
    },
  )

  it.each([
    { mode: 'compact', hasProcess: false, hasSteering: false },
    { mode: 'standard', hasProcess: false, hasSteering: false },
    { mode: 'detailed', hasProcess: false, hasSteering: false },
    { mode: 'compact', hasProcess: true, hasSteering: false },
    { mode: 'standard', hasProcess: true, hasSteering: false },
    { mode: 'detailed', hasProcess: true, hasSteering: false },
    { mode: 'compact', hasProcess: false, hasSteering: true },
    { mode: 'standard', hasProcess: false, hasSteering: true },
    { mode: 'detailed', hasProcess: false, hasSteering: true },
  ] as const)('keeps the loaded message anchored when paging exposes steering inside a closed Turn ($mode, process=$hasProcess, steer=$hasSteering)', ({ mode, hasProcess, hasSteering }) => {
    const tool = (seq: number, id: string) => ({ ...toolResult(seq, id), turn: 1 })
    const initial = {
      nodes: [
        ...hasProcess ? [tool(4, 'loaded-work')] : [],
        ...hasSteering ? [steering(5, 'retained direction', 1)] : [],
        assistant(6, 'retained answer', 1, 2),
        userInTurn(9, 'next question', 2), assistant(10, 'next answer', 2),
        userInTurn(13, 'last question', 3), assistant(14, 'last answer', 3),
      ],
      turnEnds: new Map([[1, 7], [2, 11], [3, 15]]),
    }
    let source = chatSnapshotFixture(initial)
    const builder = new ChatSnapshotBuilder()
    const state = new ProcessState()
    const groups = new ConversationGroupStore<ProcessGroupData>()
    const h = makeHarness({ chat: installGroupedSnapshot(builder, state, groups, source), hasMore: true })
    h.setGrouped(groups)
    h.setTranscriptView(mode)
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement!
    const column = scroller.querySelector<HTMLElement>('[data-chat-flow]')!
    const answer = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:assistant:6"]')!
    const first = hasSteering ? view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:steering:5"]')! : answer
    const control = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:turn-process:1"]')!
    // jsdom has no layout; positions follow the actual committed row order and hidden state.
    const visibleRows = () => [...column.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element.hasAttribute('data-chat-flow-key')
      && !element.hasAttribute('hidden') && !element.matches(':empty'))
    Object.defineProperties(scroller, {
      clientHeight: { value: 200 },
      scrollHeight: { get: () => 40 + visibleRows().length * 40 },
    })
    scroller.scrollTop = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === scroller) return new DOMRect(0, 0, 500, 200)
      const index = visibleRows().indexOf(this)
      return new DOMRect(0, 40 + index * 40 - scroller.scrollTop, 500, index < 0 ? 0 : 40)
    })
    const top = first.getBoundingClientRect().top
    if (hasSteering) expect(visibleRows().indexOf(first)).toBeLessThan(visibleRows().indexOf(control))
    expect(control.hasAttribute('data-chat-paging-anchor')).toBe(false)
    fireEvent.click(view.getByText('加载更早'))

    act(() => {
      source = chatSnapshotFixture({ ...initial, nodes: [
        tool(1, 'earlier-work'), steering(2, 'earlier direction', 1), tool(3, 'following-work'), ...initial.nodes,
      ] }, source)
      h.set({ chat: installGroupedSnapshot(builder, state, groups, source) })
      h.setGrouped(groups)
    })

    const steer = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:steering:2"]')!
    const rows = visibleRows()
    expect(rows.indexOf(control)).toBeLessThan(rows.indexOf(steer))
    expect(rows.indexOf(steer)).toBeLessThan(rows.indexOf(answer))
    expect(first.getBoundingClientRect().top).toBe(top)
    expect(scroller.scrollTop).toBe(hasSteering ? 160 : 120)
    expect([...column.querySelectorAll('[data-chat-group-key]')].every(group => !group.hasAttribute('hidden'))).toBe(true)
    expect(h.chatScroll.read()?.anchorKey).toBe(first.dataset.chatAnchorKey)
    expect(first.isConnected).toBe(true)
    expect(view.container.querySelector('[data-chat-node-key="fixture:assistant:6"]')).toBe(answer)
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
      const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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

  it('anchors the first transcript row for paging regardless of the viewport reading line', () => {
    const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    const nodes = Array.from({ length: 16 }, (_, index) => user(20 + index, `row ${String(index)}`))
    const h = makeHarness(
      { nodes },
      { hasMore: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
      expect(hitTest).not.toHaveBeenCalled()
      expect(rowRectCalls).toBe(1)

      Object.defineProperty(scroller, 'scrollHeight', { value: 1_300, writable: true })
      prepended = true
      act(() => {
        h.setChat({ nodes: [assistant(2, 'older'), ...nodes] })
      })
      expect(scroller.scrollTop).toBe(550)
      expect(h.chatScroll.read()?.anchorKey).toBe('fixture:user:20')
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

  it('renders Host-pending steering at the flow tail and hands off to the durable node', withClock(2_000, () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const pending = {
      id: 'steer-occurrence' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [{ type: 'text' as const, text: 'interrupt now' }],
      preview: 'interrupt now',
      text: 'interrupt now',
    }
    const queued = {
      id: 'queued-occurrence' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [{ type: 'text' as const, text: 'later' }],
      preview: 'later',
      text: 'later',
    }
    const h = makeHarness(
      { nodes: [assistant(1, 'working')], turnTimings: new Map([[1, { startTime: 0 }]]) },
      { testInbox: { 'next-turn': [queued], 'next-step': [pending] }, running: true },
    )
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getByText('interrupt now').closest('[data-pending-steering]')).not.toBeNull()
    expect(view.queryByText('later')).toBeNull()
    const pendingBubble = view.getByText('interrupt now').closest('[data-pending-steering]')
    expect(pendingBubble).not.toBeNull()
    fireEvent.click(within(pendingBubble as HTMLElement).getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('interrupt now')
    expect(within(pendingBubble as HTMLElement).queryByRole('button', { name: '在新对话中分支' })).toBeNull()
    expect(turnProcessControl(view.container)?.textContent).toBe('深度求索中，用时2秒')
    expect(view.getByRole('status').compareDocumentPosition(view.getByText('interrupt now'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    act(() => {
      h.setSession({ testInbox: { 'next-turn': [queued], 'next-step': [] } })
      h.setChat({
        nodes: [
          assistant(1, 'working'),
          {
            kind: 'steering', messageId: pending.id,
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
    // The branch action sends the real turn/end seq (the exact inclusive
    // Host boundary), not the assistant node seq.
    expect(h.forkAt).toHaveBeenCalledWith(3)
  }))

  it('keeps a later pending occurrence visible when it reuses a durable MessageId', () => {
    const pending = {
      id: 'steer-occurrence-later' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [{ type: 'text' as const, text: 'same steering' }],
      preview: 'same steering',
      text: 'same steering',
    }
    const h = makeHarness({
      nodes: [{
        kind: 'user', seq: 2, time: 2_000,
        content: pending.content, source: null,
      }],
    }, { testInbox: { 'next-turn': [], 'next-step': [pending] }, running: true })
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
            time: 5_000, text: '即发即显', attachments: [],
          },
        ],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('即发即显').closest('[data-submission-echo]')).not.toBeNull()
    const echo = view.getByText('即发即显').closest('[data-submission-echo]')
    act(() => { h.setSession({ testInbox: { 'next-step': [], 'next-turn': [{
      id: 'idle-occurrence' as never, role: 'user', source: { kind: 'user', rpcId: 'req-1' as never },
      content: [{ type: 'text', text: '即发即显' }],
    }] } }) })
    expect(view.getByText('即发即显').closest('[data-submission-echo]')).toBe(echo)
    act(() => { h.setSession({ testInbox: { 'next-step': [], 'next-turn': [] } }) })
    expect(view.getByText('即发即显').closest('[data-submission-echo]')).toBe(echo)

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

  it.each(['compact', 'standard', 'detailed'] as const)(
    'keeps the opening echo above a new Turn title and steering below it (%s)', (mode) => {
      const opening = {
        requestId: 'opening' as never, placement: 'transcript' as const,
        time: 5_000, text: 'opening input', attachments: [],
      }
      const steer = {
        requestId: 'steer' as never, placement: 'steering' as const,
        time: 6_000, text: 'later steering', attachments: [],
      }
      const h = makeHarness({}, { pendingSubmissions: [opening, steer] })
      h.setTranscriptView(mode)
      const view = render(<h.ChatView {...h.props} />)
      const echo = view.getByText(opening.text).closest('[data-submission-echo]')!
      const steeringEcho = view.getByText(steer.text).closest('[data-submission-echo]')!
      act(() => { h.setChat({ turnTimings: new Map([[1, { startTime: 1_000 }]]) }) })
      const title = view.container.querySelector('[data-chat-flow-kind="turn-process"]')!
      expect(title).not.toBeNull()
      expect(view.getByText(opening.text).closest('[data-submission-echo]')).toBe(echo)
      expect(echo.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(title.compareDocumentPosition(steeringEcho) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const admitted: UserMessageNode & { turn: number } = {
        ...user(2, opening.text), turn: 1, source: { kind: 'user', rpcId: opening.requestId },
      }
      act(() => { h.setChat({ nodes: [admitted] }) })
      expect(view.getAllByText(opening.text)).toHaveLength(1)
      expect(view.getByText(steer.text).closest('[data-submission-echo]')).toBe(steeringEcho)
      expect(view.getByText(opening.text).compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    },
  )

  it('hands off an opening echo when the Turn and input arrive in one render', () => {
    const h = makeHarness({}, { pendingSubmissions: [{
      requestId: 'same-frame' as never, placement: 'transcript', time: 1_000, text: 'same frame', attachments: [],
    }] })
    const view = render(<h.ChatView {...h.props} />)
    const admitted: UserMessageNode & { turn: number } = {
      ...user(2, 'same frame'), turn: 1, source: { kind: 'user', rpcId: 'same-frame' },
    }
    act(() => { h.setChat({ nodes: [admitted], turnTimings: new Map([[1, { startTime: 1_000 }]]) }) })
    expect(view.getAllByText('same frame')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()
    expect(renderedFlowKinds(view.container)).toEqual(['user', 'turn-process'])
  })

  it.each(['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'])(
    'uses the first local opening echo until Host admission identifies the input (%s)', (hostOrder) => {
      const pending: SessionSnapshot['pendingSubmissions'] = ['A', 'B', 'C'].map(text => ({
        requestId: text as never, placement: 'transcript' as const,
        time: 1_000, text: `input ${text}`, attachments: [],
      }))
      const h = makeHarness({}, { pendingSubmissions: pending })
      const view = render(<h.ChatView {...h.props} />)
      const flow = () => [...view.container.querySelectorAll<HTMLElement>(
        '[data-submission-echo], [data-chat-flow-kind="user"], [data-chat-flow-kind="turn-process"]',
      )].map(element => element.matches('[data-chat-flow-kind="turn-process"]') ? 'title'
        : pending.find(input => element.textContent?.includes(input.text))!.requestId
          + (element.hasAttribute('data-submission-echo') ? '*' : ''))
      expect(flow()).toEqual(['A*', 'B*', 'C*'])
      const inbox: InboxState = { 'next-step': [], 'next-turn': hostOrder.split('').map(id => ({
        id: id as never, role: 'user', source: { kind: 'user', rpcId: id as never },
        content: [{ type: 'text', text: `input ${id}` }],
      })) }
      act(() => { h.setSession({ testInbox: inbox }) })
      act(() => { h.setChat({ turnTimings: new Map([[1, { startTime: 1_000 }]]) }) })
      expect(flow()).toEqual(['A*', 'title', 'B*', 'C*'])
      const admitted: UserMessageNode & { turn: number } = {
        ...user(2, `input ${hostOrder[0]}`), turn: 1,
        source: { kind: 'user', rpcId: hostOrder[0] },
      }
      act(() => { h.setChat({ nodes: [admitted] }) })
      expect(flow()).toEqual([hostOrder[0], 'title', ...pending
        .filter(input => input.requestId !== hostOrder[0]).map(input => `${input.requestId}*`)])
      act(() => { h.setSession({ pendingSubmissions: pending.filter(input => input.requestId !== hostOrder[0]) }) })
      expect(view.getAllByText(`input ${hostOrder[0]}`)).toHaveLength(1)
    },
  )

  it('leaves an opening echo below an empty historical Turn title', () => {
    const h = makeHarness({ turnTimings: new Map([[1, { startTime: 1_000 }]]), turnEnds: new Map([[1, 2]]) }, {
      pendingSubmissions: [{ requestId: 'opening' as never, placement: 'transcript',
        time: 3_000, text: 'next input', attachments: [] }],
    })
    const view = render(<h.ChatView {...h.props} />)
    const title = view.container.querySelector('[data-chat-flow-kind="turn-process"]')!
    const echo = view.getByText('next input').closest('[data-submission-echo]')!
    expect(title.compareDocumentPosition(echo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not pull the reader back to the tail when a local steer becomes Host-pending', () => {
    const h = makeHarness({ nodes: [assistant(1, 'working')] }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement!
    installScrollMetrics(scroller, 1_000, 300)
    act(() => { h.setSession({ pendingSubmissions: [{
      requestId: 'req-steer' as never, placement: 'steering', time: 5_000, text: 'continue here', attachments: [],
    }] }) })
    expect(scroller.scrollTop).toBe(700)
    readerScroll(scroller, 100)

    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [{
      id: 'steer-occurrence' as never, role: 'user', source: { kind: 'user', rpcId: 'req-steer' as never },
      content: [{ type: 'text', text: 'continue here' }],
    }] } }) })
    expect(view.getAllByText('continue here')).toHaveLength(1)
    expect(scroller.scrollTop).toBe(100)
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it.each(['compact', 'standard', 'detailed'] as const)(
    'hides an admitted local steer while its Inbox claim projection is delayed (%s)', (mode) => {
      const pending: InboxState['next-step'] = ['first', 'second'].map(text => ({
        id: text as never, role: 'user', source: { kind: 'user', rpcId: text as never },
        content: [{ type: 'text', text: `steer ${text}` }],
      }))
      const submissions: SessionSnapshot['pendingSubmissions'] = ['first', 'second'].map(text => ({
        requestId: text as never, placement: 'steering', time: 5_000,
        text: `steer ${text}`, attachments: [],
      }))
      const h = makeHarness({ nodes: [assistant(1, 'working')] }, {
        running: true, pendingSubmissions: submissions,
        testInbox: { 'next-turn': [], 'next-step': pending },
      })
      h.setTranscriptView(mode)
      const view = render(<h.ChatView {...h.props} />)
      const second = view.getByText('steer second').closest('[data-submission-echo]')
      expect(view.getAllByText('steer first')).toHaveLength(1)

      act(() => { h.setChat({ nodes: [assistant(1, 'working'), {
        ...steering(2, 'steer first', 1), source: pending[0]!.source,
      }] }) })
      expect(view.getAllByText('steer first')).toHaveLength(1)
      expect(view.getByText('steer first').closest('[data-pending-steering]')).toBeNull()
      expect(view.getByText('steer second').closest('[data-submission-echo]')).toBe(second)

      act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [pending[1]!] } }) })
      act(() => { h.setSession({ pendingSubmissions: [submissions[1]!] }) })
      expect(view.getAllByText('steer first')).toHaveLength(1)
      expect(view.getByText('steer second').closest('[data-submission-echo]')).toBe(second)
    },
  )

  it('retains the same local steer bubble through Host acceptance and claim until its durable node arrives', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        running: true,
        pendingSubmissions: [{
          requestId: 'req-steer' as never,
          placement: 'steering',
          time: 5_500,
          text: '带图纠偏',
          attachments: [{
            type: 'image', value: { previewUrl: 'blob:steer-preview', name: 'steer.png' },
          }],
        }],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    const local = view.getByText('带图纠偏').closest('[data-submission-echo]')
    expect(local?.hasAttribute('data-pending-steering')).toBe(true)

    act(() => {
      h.setSession({
        testInbox: { 'next-turn': [], 'next-step': [{
          id: 'steer-occurrence' as never,
          content: [{ type: 'text', text: '带图纠偏' }],

          role: 'user', source: { kind: 'user', rpcId: 'req-steer' as never },
        }] },
      })
    })
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBe(local)
    expect(view.container.querySelectorAll('[data-pending-steering]')).toHaveLength(1)

    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [] } }) })
    expect(view.container.querySelector('[data-submission-echo]')).toBe(local)
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)

    act(() => { h.setChat({ nodes: [assistant(1, 'working'), {
      ...steering(2, '带图纠偏', 1), source: { kind: 'user', rpcId: 'req-steer' as never },
    }] }) })
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()
    act(() => { h.setSession({ pendingSubmissions: [] }) })
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)
  })

  it('keeps Host Inbox order across local and other-client steering without remounting the local echo', () => {
    const h = makeHarness({ nodes: [assistant(1, 'working')] }, {
      running: true,
      pendingSubmissions: [{
        requestId: 'local-steer' as never, placement: 'steering', time: 5_000, text: 'local A', attachments: [],
      }],
    })
    const view = render(<h.ChatView {...h.props} />)
    const local = view.getByText('local A').closest('[data-submission-echo]')
    const first = {
      id: 'local-occurrence' as never, role: 'user' as const,
      source: { kind: 'user' as const, rpcId: 'local-steer' as never },
      content: [{ type: 'text' as const, text: 'local A' }],
    }
    const second = {
      id: 'remote-occurrence' as never, role: 'user' as const,
      source: { kind: 'user' as const, rpcId: 'remote-steer' as never },
      content: [{ type: 'text' as const, text: 'remote B' }],
    }
    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [first, second] } }) })
    const pendingText = () => [...view.container.querySelectorAll('[data-pending-steering]')]
      .map(element => element.textContent)
    expect(pendingText()).toEqual([expect.stringContaining('local A'), expect.stringContaining('remote B')])
    expect(view.getByText('local A').closest('[data-submission-echo]')).toBe(local)

    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [second, first] } }) })
    expect(pendingText()).toEqual([expect.stringContaining('remote B'), expect.stringContaining('local A')])
    expect(view.getByText('local A').closest('[data-submission-echo]')).toBe(local)

    act(() => { h.setSession({ pendingSubmissions: [] }) })
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()
    expect(pendingText()).toEqual([expect.stringContaining('remote B'), expect.stringContaining('local A')])
  })

  it('keeps a queued echo out of the Chat flow before and after Host admission', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        running: true,
        pendingSubmissions: [
          {
            requestId: 'req-q' as never, placement: 'queued',
            time: 6_000, text: '排队中', attachments: [],
          },
        ],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText('排队中')).toBeNull()
    act(() => {
      h.setSession({
        testInbox: { 'next-step': [], 'next-turn': [{
          id: 'q-occurrence' as never,
          content: [{ type: 'text' as const, text: '排队中' }],

          role: 'user', source: { kind: 'user', rpcId: 'req-q' as never },
        }] },
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
          attachments: [
            {
              type: 'image', value: { previewUrl: 'blob:echo-a', name: 'a.png', width: 4, height: 3 },
            },
            { type: 'image', value: { previewUrl: 'blob:echo-b' } },
          ],
        }],
      },
    )
    const baseRenderSlot = h.props.renderSlot
    const renderSlot = ((key: string, owner: object, opts?: { fallback?: React.ReactNode }) => {
      if (key !== 'conversation.message.images') return baseRenderSlot(key as never, owner as never, opts as never)
      const { images, compact } = owner as { images: readonly unknown[]; compact?: boolean }
      return (
        <div
          data-testid="echo-image"
          data-count={images.length}
          data-compact={String(compact)}
          data-first={JSON.stringify(images[0])}
        />
      )
    }) as ChatViewSlotProps['renderSlot']
    const view = render(<h.ChatView {...{ ...h.props, renderSlot }} />)
    const images = view.getAllByTestId('echo-image')
    expect(images).toHaveLength(2)
    expect(images.every(image => image.getAttribute('data-count') === '1')).toBe(true)
    expect(images.every(image => image.getAttribute('data-compact') === 'true')).toBe(true)
    expect(images[0]?.parentElement).toBe(images[1]?.parentElement)
    expect(JSON.parse(images[0]?.getAttribute('data-first') ?? '{}')).toEqual({
      preview: { url: 'blob:echo-a', name: 'a.png', width: 4, height: 3 },
    })
  })

  it('a mixed echo renders the Web file card between its selected images', () => {
    const h = makeHarness(
      { nodes: [] },
      {
        pendingSubmissions: [{
          requestId: 'req-mixed' as never,
          placement: 'transcript',
          time: 7_500,
          text: '',
          attachments: [
            { type: 'image', value: { previewUrl: 'blob:first', name: 'first.png' } },
            {
              type: 'file',
              value: { attachmentId: 'file-1' as never, name: 'notes.txt', bytes: 23 },
            },
            { type: 'image', value: { previewUrl: 'blob:last', name: 'last.png' } },
          ],
        }],
      },
    )
    const baseRenderSlot = h.props.renderSlot
    const renderSlot = ((key: string, owner: object, opts?: { fallback?: React.ReactNode }) => {
      if (key !== 'conversation.message.images') return baseRenderSlot(key as never, owner as never, opts as never)
      const { images, compact } = owner as {
        images: ReadonlyArray<{ preview?: { name?: string } }>
        compact?: boolean
      }
      return (
        <div
          data-testid={`images-${images[0]?.preview?.name ?? 'unknown'}`}
          data-compact={String(compact)}
        />
      )
    }) as ChatViewSlotProps['renderSlot']
    const view = render(<h.ChatView {...{ ...h.props, renderSlot }} />)
    const first = view.getByTestId('images-first.png')
    const file = view.getByTitle('notes.txt')
    const last = view.getByTestId('images-last.png')
    expect(first.getAttribute('data-compact')).toBe('true')
    expect(last.getAttribute('data-compact')).toBe('true')
    expect(first.parentElement).toBe(file.parentElement)
    expect(file.parentElement).toBe(last.parentElement)
    expect(first.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(file.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(view.getByText('TXT 23B')).toBeTruthy()
  })

  it('animates only the latest unresolved model retry', () => {
    const retryNode = retry(2)
    const nextRetry = { ...retry(3), turn: 2, retry: 2 }
    const context = {
      kind: 'context', seq: 4, time: 4_000, content: [], source: null,
      producer: { role: 'inject', label: null },
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

  it('renders every terminal failure inline with neutral quota copy and no transient notice', () => {
    const h = makeHarness({ nodes: [
      user(1, 'try'), turnError(2, 'AUTH'), turnError(3), turnError(4, 'QUOTA'), turnError(5, 'ACCOUNT_QUOTA'),
    ] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '本轮运行失败API 密钥无效AUTH',
      '本轮运行失败plugin exploded',
      '本轮运行失败当前请求的额度已用尽QUOTA',
      '本轮运行失败当前请求的额度已用尽ACCOUNT_QUOTA',
    ])
    // The transient notice is the frame-wide host's job; the failure row keeps
    // neither a recharge affordance nor a toast of its own.
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.queryByRole('button', { name: '去充值' })).toBeNull()
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

  it('removes Inspect when trajectory is unavailable and restores it with the view', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    const view = render(<h.ChatView {...h.props} inspectCall={undefined} />)
    expect(h.toolOwners.at(-1)?.inspectCall).toBeUndefined()
    view.rerender(<h.ChatView {...h.props} />)
    expect(h.toolOwners.at(-1)?.inspectCall).toBeTypeOf('function')
  })

  it('hands the trajectory callback to the Tool seat', () => {
    const h = makeHarness({
      nodes: [toolResult(3, 'a')],
    })
    render(<h.ChatView {...h.props} />)
    h.toolOwners[0]?.inspectCall?.('a')
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
    const toggle = view.getByRole('button', { name: '用时 4秒' })
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
    expect(view.getByRole('button', { name: '用时 4秒' }).getAttribute('aria-expanded')).toBe('false')
    expect(members[0]?.getAttribute('hidden')).toBeNull()
    act(() => { h.set({
      nodes: [user(1, 'question'), first, toolResult(3, 'a'), toolResult(4, 'b', 'subagent'), second],
    }) })
    const renewedToggle = view.getByRole('button', { name: '用时 4秒' })
    expect(renewedToggle.getAttribute('aria-expanded')).toBe('true')
    expect(members[0]?.getAttribute('hidden')).toBeNull()
  })

  it('omits injected Context while folding and revealing the visible Turn process', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'question'),
        context(2, 'runtime policy changed', 1),
        reasoningAssistant(3, 'inspect the repository', 1, 1),
        toolResult(4, 'a'),
        assistant(5, 'final answer', 1, 2),
      ],
      turnEnds: new Map([[1, 6]]),
      turnTimings: new Map([[1, { startTime: 0, endTime: 6_000 }]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const contextRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="context"]')
    const members = [...view.container.querySelectorAll<HTMLElement>('[data-turn-process-member]')]

    expect(members).toHaveLength(2)
    expect(members.map(member => member.dataset.chatFlowKind)).toEqual(['assistant-step', 'tool-call'])
    expect(contextRow).toBeNull()
    expect(view.queryByText('runtime policy changed')).toBeNull()
    expect(members.map(member => member.getAttribute('hidden'))).toEqual(['until-found', 'until-found'])
    fireEvent(members[1]!, new Event('beforematch'))
    expect(turnProcessControl(view.container)?.getAttribute('aria-expanded')).toBe('true')
    expect(members.map(member => member.getAttribute('hidden'))).toEqual([null, null])
    expect(view.container.querySelector('[data-chat-flow-kind="context"]')).toBeNull()
  })

  it('omits the System prompt through Turn completion and process expansion', withClock(4_000, () => {
    const builder = new ChatSnapshotBuilder()
    const initial = withSystemPrompt(chatSnapshotFixture({
      nodes: [userInTurn(2, 'question', 1), context(3, 'runtime policy', 1)],
      turnTimings: new Map([[1, { startTime: 0 }]]),
    }), builder)
    const h = makeHarness({ chat: initial }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(renderedFlowKinds(view.container)).toEqual(['user', 'turn-process'])
    expect(turnProcessControl(view.container)?.textContent).toBe('深度求索中，用时4秒')
    expect(view.container.querySelector('[data-chat-flow-kind="system-prompt"]')).toBeNull()

    act(() => {
      h.set({
        chat: withSystemPrompt(chatSnapshotFixture({
          nodes: [
            userInTurn(2, 'question', 1),
            context(3, 'runtime policy', 1),
            reasoningAssistant(4, 'inspect', 1, 1),
          ],
          turnTimings: new Map([[1, { startTime: 0 }]]),
        }), builder),
        running: true,
      })
    })
    expect(renderedFlowKinds(view.container)).toEqual([
      'user', 'turn-process', 'assistant-step',
    ])
    expect(view.container.querySelector('[data-chat-flow-kind="system-prompt"]')).toBeNull()

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
          turnTimings: new Map([[1, { startTime: 0, endTime: 7_000 }]]),
        }), builder),
        running: false,
      })
    })
    const toggle = turnProcessControl(view.container)!
    const members = [...view.container.querySelectorAll<HTMLElement>('[data-turn-process-member]')]
    expect(renderedFlowKinds(view.container)).toEqual([
      'user', 'turn-process', 'assistant-step', 'assistant-step', 'turn-tail',
    ])
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-chat-flow-kind="system-prompt"]')).toBeNull()
    expect(members.map(member => member.dataset.chatFlowKind)).toEqual(['assistant-step'])
    expect(members.map(member => member.getAttribute('hidden'))).toEqual(['until-found'])

    fireEvent.click(toggle)
    expect(renderedFlowKinds(view.container)).toEqual([
      'user', 'turn-process', 'assistant-step', 'assistant-step', 'turn-tail',
    ])
    expect(view.container.querySelector('[data-chat-flow-kind="system-prompt"]')).toBeNull()
    expect(members.map(member => member.getAttribute('hidden'))).toEqual([null])
  }))

  it('keeps the fallback title without a disclosure when only Context precedes the answer', () => {
    const h = makeHarness({
      nodes: [user(1, 'question'), context(2, 'runtime policy', 1), assistant(3, 'final answer', 1, 1)],
      turnEnds: new Map([[1, 4]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const toggle = view.getByRole('button', { name: '已完成工作' }) as HTMLButtonElement
    const contextRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="context"]')

    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBeNull()
    expect(toggle.getAttribute('data-turn-process-tool-calls')).toBe('0')
    expect(toggle.getAttribute('data-turn-process-messages')).toBe('0')
    expect(toggle.getAttribute('data-turn-process-subagents')).toBe('0')
    expect(contextRow).toBeNull()
    expect(view.container.querySelector('[data-turn-process-member]')).toBeNull()
    expect(view.queryByText('runtime policy')).toBeNull()
    fireEvent.click(toggle)
    expect(view.container.querySelector('[data-chat-flow-kind="context"]')).toBeNull()
    expect(view.getByText('final answer').closest('[hidden]')).toBeNull()
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

  it.each(['compact', 'standard', 'detailed'] as const)(
    'preserves steering-separated process groups in %s mode after Turn completion', (mode) => {
      const nodes = [
        userInTurn(1, 'question', 1),
        reasoningAssistant(2, 'first analysis', 1, 1),
        assistant(3, 'first progress', 1, 2),
        steering(4, 'first direction', 1),
        reasoningAssistant(5, 'second analysis', 1, 3),
        assistant(6, 'second progress', 1, 4),
        steering(7, 'second direction', 1),
        reasoningAssistant(8, 'third analysis', 1, 5),
        assistant(9, 'final answer', 1, 6),
      ]
      const builder = new ChatSnapshotBuilder()
      const groups = new ConversationGroupStore<ProcessGroupData>()
      const state = new ProcessState()
      const project = (closed: boolean) => installGroupedSnapshot(builder, state, groups, chatSnapshotFixture({
        nodes,
        turnTimings: new Map([[1, { startTime: 0 }]]),
        turnEnds: new Map(closed ? [[1, 10]] : []),
      }))
      const h = makeHarness({ chat: project(false) }, { running: true })
      h.setGrouped(groups)
      h.setTranscriptView(mode)
      const view = render(<h.ChatView {...h.props} />)
      const roots = [...view.container.querySelectorAll<HTMLElement>('[data-chat-group-key]')]
      const headers = roots.map(root => root.querySelector<HTMLButtonElement>('[data-process-activity]')!)
      expect(roots).toHaveLength(3)

      act(() => { h.set({ chat: project(true), running: false }) })

      expect(roots.map(root => root.closest('[hidden]'))).toEqual([null, null, null])
      expect(turnProcessControl(view.container)?.disabled).toBe(true)
      const visibleOrder = (): HTMLElement[] => [...view.container.querySelectorAll<HTMLElement>(
        '[data-chat-group-key], [data-chat-flow-kind="steering"], [data-chat-group-part="response"]',
      )].filter(row => row.closest('[hidden]') === null)
      const order = visibleOrder()
      expect(order).toEqual([
        roots[0], view.getByText('first progress').closest('[data-chat-flow-kind]'),
        view.getByText('first direction').closest('[data-chat-flow-kind]'),
        roots[1], view.getByText('second progress').closest('[data-chat-flow-kind]'),
        view.getByText('second direction').closest('[data-chat-flow-kind]'),
        roots[2], view.getByText('final answer').closest('[data-chat-flow-kind]'),
      ])
      for (const next of ['compact', 'standard', 'detailed', mode] as const) {
        act(() => { h.setTranscriptView(next) })
        expect(visibleOrder()).toEqual(order)
        expect([...view.container.querySelectorAll('[data-chat-group-key]')]).toEqual(roots)
      }
      act(() => { h.setTranscriptView('compact') })
      fireEvent.click(headers[1]!)
      expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false'])
      expect(roots[1]!.querySelector('[data-step-process-body]')?.hasAttribute('hidden')).toBe(false)
      expect(roots[1]!.querySelector('[data-turn-process-member]')?.hasAttribute('hidden')).toBe(false)
      expect(visibleOrder()).toEqual(order)
      fireEvent.click(headers[1]!)
      expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false'])
      expect(visibleOrder()).toEqual(order)
    },
  )

  it('keeps compact answer spacing after multiple opening steering inputs', () => {
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
    expect(answer?.hasAttribute('data-turn-process-answer')).toBe(true)
    fireEvent.click(turnProcessControl(view.container)!)
    expect(answer?.hasAttribute('data-turn-process-answer')).toBe(false)
  })

  it('keeps a live Turn expanded and folds it once at turn/end', withClock(3_000, () => {
    const process = assistant(2, 'inspect', 1, 1)
    const h = makeHarness({
      nodes: [user(1, 'question'), process],
      partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'streaming answer' }] },
      running: true,
      turnTimings: new Map([[1, { startTime: 0 }]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const liveToggle = view.getByRole('button', { name: '深度求索中，用时3秒' }) as HTMLButtonElement
    expect(liveToggle.disabled).toBe(true)
    expect(liveToggle.getAttribute('aria-expanded')).toBe('true')
    const processRow = view.getByText('inspect').closest('[data-chat-flow-kind="assistant-step"]') as HTMLElement
    fireEvent.click(liveToggle)
    expect(processRow.getAttribute('hidden')).toBeNull()

    act(() => {
      h.set({
        nodes: [user(1, 'question'), process, assistant(4, 'settled answer', 1, 2)],
        partial: null,
        running: false,
        turnEnds: new Map([[1, 5]]),
      })
    })
    const toggle = turnProcessControl(view.container)!
    expect(toggle).toBe(liveToggle)
    expect(toggle.textContent).toBe('用时 5秒')
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(processRow.getAttribute('hidden')).toBe('until-found')
    fireEvent.click(toggle)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('用时 5秒')
    expect(processRow.getAttribute('hidden')).toBeNull()
  }))

  it('preserves whole-Turn folding and manual expansion across work-details modes', () => {
    const process = assistant(2, 'inspect', 1, 1)
    const h = makeHarness({
      nodes: [user(1, 'question'), process, assistant(4, 'final answer', 1, 2)],
      turnEnds: new Map([[1, 5]]),
      turnTimings: new Map([[1, { startTime: 0, endTime: 5_000 }]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const processRow = view.getByText('inspect').closest('[data-chat-flow-kind="assistant-step"]') as HTMLElement

    expect(turnProcessControl(view.container)?.getAttribute('aria-expanded')).toBe('false')
    expect(processRow.getAttribute('hidden')).toBe('until-found')

    const toggle = turnProcessControl(view.container)!
    for (const mode of ['standard', 'detailed', 'compact'] as const) {
      act(() => { h.setTranscriptView(mode) })
      expect(turnProcessControl(view.container)).toBe(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(processRow.getAttribute('hidden')).toBe('until-found')
    }
    fireEvent.click(toggle)
    for (const mode of ['standard', 'detailed', 'compact'] as const) {
      act(() => { h.setTranscriptView(mode) })
      expect(turnProcessControl(view.container)).toBe(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(processRow.getAttribute('hidden')).toBeNull()
    }
  })

  it('folds final-step reasoning under the fallback title when every summary count is zero', () => {
    const final = {
      ...assistant(3, 'final answer', 1, 1),
      blocks: [
        { kind: 'reasoning' as const, text: 'private analysis\nCheck the final decision' },
        { kind: 'text' as const, text: 'final answer' },
      ],
    }
    const h = makeHarness({
      nodes: [user(1, 'question'), final],
      turnEnds: new Map([[1, 4]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const toggle = view.getByRole('button', { name: '已完成工作' })
    const reasoning = view.container.querySelector<HTMLElement>('[data-turn-process-inline]')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(reasoning?.getAttribute('hidden')).toBe('until-found')
    expect(view.getByText('final answer')).toBeTruthy()
    fireEvent.click(toggle)
    const think = within(reasoning!).getByRole('button', { name: /^思考/ })
    expect(think.getAttribute('aria-expanded')).toBe('false')
    expect(reasoning?.getAttribute('hidden')).toBeNull()
    expect(view.queryByText(/Check the final decision/)).toBeNull()
    fireEvent.click(think)
    expect(think.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check the final decision/)).toBeTruthy()
  })

  it('folds a completed Turn even while the reader is away from the tail', () => {
    const first = assistant(2, 'first answer', 1, 1)
    const h = makeHarness({
      nodes: [user(1, 'question'), first], running: true,
      turnTimings: new Map([[1, { startTime: 0 }]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
    const process = reasoningAssistant(2, 'inspect the repository', 1, 1)
    const h = makeHarness({
      nodes: [user(1, 'question'), process],
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(turnProcessControl(view.container)).toBeNull()
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    const processRow = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:assistant:2"]')!
    expect(processRow.getAttribute('hidden')).toBeNull()
    readerScroll(scroller, 100)

    act(() => { h.set({
      nodes: [
        user(1, 'question'),
        process,
        assistant(3, 'final answer', 1, 2),
      ],
      running: false,
      turnEnds: new Map([[1, 4]]),
    }) })
    const toggle = turnProcessControl(view.container)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('已完成工作')
    expect(view.container.querySelector('[data-chat-node-key="fixture:assistant:2"]')).toBe(processRow)
    expect(processRow.getAttribute('hidden')).toBe('until-found')
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it('keeps a focused process row visible when a live Turn completes', withClock(2_000, () => {
    const process = reasoningAssistant(2, 'inspect the repository', 1, 1)
    const h = makeHarness({
      nodes: [user(1, 'question'), process],
      running: true,
      turnTimings: new Map([[1, { startTime: 0 }]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const processRow = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:assistant:2"]')!
    const thinkToggle = within(processRow).getByRole('button', { name: /^思考/ })
    thinkToggle.focus()
    expect(document.activeElement).toBe(thinkToggle)

    act(() => { h.set({
      nodes: [
        user(1, 'question'),
        process,
        assistant(3, 'final answer', 1, 2),
      ],
      running: false,
      turnEnds: new Map([[1, 4]]),
    }) })
    const processToggle = turnProcessControl(view.container)!
    expect(processToggle.getAttribute('aria-expanded')).toBe('true')
    expect(processRow.getAttribute('hidden')).toBeNull()
    expect(document.activeElement).toBe(thinkToggle)

    fireEvent.click(processToggle)
    expect(document.activeElement).toBe(processToggle)
    expect(processToggle.getAttribute('aria-expanded')).toBe('false')
    expect(processRow.getAttribute('hidden')).toBe('until-found')
  }))

  it('folds a recorded Turn end independently of remaining history or a loaded start', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'question'),
        assistant(3, 'working', 1, 1),
        assistant(4, 'final answer', 1, 2),
      ],
      turnEnds: new Map([[1, 5]]),
      hasMore: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    const row = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:assistant:3"]')!
    const toggle = turnProcessControl(view.container)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe(h.props.t('message.turnProcess.worked'))
    expect(row.getAttribute('hidden')).toBe('until-found')
    expect(view.getByText('final answer')).toBeTruthy()

    act(() => { h.set({ hasMore: false }) })
    expect(turnProcessControl(view.container)).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(row.getAttribute('hidden')).toBe('until-found')

    act(() => { h.set({
      hasMore: true,
      turnTimings: new Map([[1, { startTime: 0, endTime: 5_000 }]]),
    }) })
    expect(turnProcessControl(view.container)).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe(h.props.t('message.turnProcess.took', { duration: formatRunDuration(5_000, h.props.t) }))
    expect(row.getAttribute('hidden')).toBe('until-found')
  })

  it.each([
    { grouped: false, manualOpen: false }, { grouped: false, manualOpen: true },
    { grouped: true, manualOpen: false }, { grouped: true, manualOpen: true },
  ])('retains paged Turn visibility before and after loading its start (grouped=$grouped, open=$manualOpen)', ({ grouped, manualOpen }) => {
    const source = chatSnapshotFixture({
      nodes: [reasoningAssistant(2, 'loaded reasoning'), toolResult(3, 'partial'), assistant(4, 'loaded final answer', 1, 2)],
      turnEnds: new Map([[1, 5]]),
    })
    const ended = source.timeline.turns.get(1)
    if (ended?.end === undefined || ended.start !== undefined) throw new Error('expected only a Turn end')
    const nodesAt = (turn: TurnLocation, nodes = source.nodes.values()) => nodes.map(node => (
      node.location.kind === 'turn' || node.location.kind === 'step'
        ? { ...node, location: { ...node.location, turn } }
        : node
    ))
    const builder = new ChatSnapshotBuilder()
    const snapshot = builder.replace({
      nodes: nodesAt(ended), timeline: { turnOrder: [1], turns: new Map([[1, ended]]) },
    })
    const state = new ProcessState()
    const groups = new ConversationGroupStore<ProcessGroupData>()
    const updateGroups = () => {
      const input = builder.groupInput()
      state.accept(input)
      const update = state.output()
      if (update !== null) groups.prepareAndInstall(update, input.readNode)
    }
    updateGroups()
    const h = makeHarness({ chat: snapshot, hasMore: true })
    if (grouped) h.setGrouped(groups)
    const view = render(<h.ChatView {...h.props} />)
    const toggle = view.getByRole('button', { name: h.props.t('message.turnProcess.worked') })
    let row = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:tool:partial"]')!
    let group = view.container.querySelector<HTMLElement>('[data-chat-group-key]')
    for (const mode of ['compact', 'standard', 'detailed'] as const) {
      act(() => { h.setTranscriptView(mode) })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(row.getAttribute('hidden')).toBe('until-found')
      if (grouped) expect(group?.getAttribute('hidden')).toBe('until-found')
      expect(view.getByText('loaded final answer')).toBeTruthy()
    }
    if (manualOpen) fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe(String(manualOpen))
    expect(row.hasAttribute('hidden')).toBe(!manualOpen)
    if (grouped) expect(group?.hasAttribute('hidden')).toBe(!manualOpen)
    const beforePageRow = row
    const beforePageGroup = group
    const groupToggle = group?.querySelector<HTMLButtonElement>('[data-process-activity]')
    if (grouped && manualOpen) {
      act(() => { h.setTranscriptView('standard') })
      fireEvent.click(groupToggle!)
      expect(groupToggle?.getAttribute('aria-expanded')).toBe('true')
    }

    let older = source
    let paged = ended
    act(() => {
      older = chatSnapshotFixture({
        nodes: [reasoningAssistant(1, 'earlier loaded reasoning'), ...source.legacy.nodes],
        turnEnds: new Map([[1, 5]]),
      }, source)
      const turn = older.timeline.turns.get(1)
      if (turn?.end === undefined || turn.start !== undefined) throw new Error('expected start to remain outside the page')
      paged = turn
      const next = builder.apply({
        upserts: nodesAt(paged, older.nodes.values()), timeline: { turnOrder: [1], turns: new Map([[1, paged]]) }, changedTurns: [1],
      })
      updateGroups()
      builder.publish()
      groups.publish()
      h.set({ chat: next, hasMore: true })
    })
    row = view.container.querySelector<HTMLElement>('[data-chat-node-key="fixture:tool:partial"]')!
    group = view.container.querySelector<HTMLElement>('[data-chat-group-key]')
    expect(row).toBe(beforePageRow)
    expect(group).toBe(beforePageGroup)
    if (grouped && manualOpen) {
      expect(group?.querySelector('[data-process-activity]')).toBe(groupToggle)
      expect(groupToggle?.getAttribute('aria-expanded')).toBe('true')
    }
    expect(turnProcessControl(view.container)).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe(String(manualOpen))
    expect(row.hasAttribute('hidden')).toBe(!manualOpen)
    if (grouped) expect(group?.hasAttribute('hidden')).toBe(!manualOpen)
    expect(view.container.querySelector('[data-chat-node-key="fixture:assistant:1"]')?.hasAttribute('hidden')).toBe(!manualOpen)
    expect(view.getByText('loaded final answer')).toBeTruthy()

    const complete: TurnLocation = {
      ...paged, start: { type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } },
    }
    act(() => {
      const next = builder.apply({
        upserts: nodesAt(complete, older.nodes.values()), timeline: { turnOrder: [1], turns: new Map([[1, complete]]) }, changedTurns: [1],
      })
      updateGroups()
      builder.publish()
      groups.publish()
      h.set({ chat: next, hasMore: true })
    })
    expect(turnProcessControl(view.container)).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe(String(manualOpen))
    expect(view.container.querySelector('[data-chat-node-key="fixture:tool:partial"]')).toBe(row)
    expect(row.hasAttribute('hidden')).toBe(!manualOpen)
    if (grouped) {
      expect(view.container.querySelector('[data-chat-group-key]')).toBe(group)
      expect(group?.hasAttribute('hidden')).toBe(!manualOpen)
    }
    expect(toggle.textContent).toBe(h.props.t('message.turnProcess.took', { duration: formatRunDuration(4_000, h.props.t) }))
    act(() => { h.set({ hasMore: false }) })
    expect(toggle.getAttribute('aria-expanded')).toBe(String(manualOpen))
  })

  it('withholds process controls without a loaded Turn boundary and folds completed groups', () => {
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
        turnTimings: new Map([[1, { startTime: 0, endTime: 5_000 }]]),
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
      turnTimings: new Map([[1, { startTime: 0, endTime: 5_000 }]]),
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
    const toggle = turnProcessControl(view.container)!
    const processRow = view.getByText('working').closest('[data-chat-flow-kind="assistant-step"]')!
    expect(toggle.textContent).toBe('用时 5秒')
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBeNull()
    expect(processRow.hasAttribute('hidden')).toBe(false)

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
      'user', 'turn-process', 'assistant-step', 'assistant-step', 'turn-tail',
    ])

    act(() => {
      turnData.publish()
      builder.publish()
      h.set({ chat: complete, hasMore: false })
    })
    expect(turnProcessControl(view.container)).toBe(toggle)
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(processRow.getAttribute('hidden')).toBe('until-found')
    expect(view.getByText('final answer').closest('[hidden]')).toBeNull()
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
        turnTimings: new Map([[1, { startTime: 0, endTime: 5_000 }]]),
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

  it('the assistant footer omits turn run time', () => {
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
    expect(view.container.querySelector('[data-turn-tail="1"]')?.textContent).not.toContain('用时 19秒')
  })

  it('the assistant footer omits hour-scale run time', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'mid-turn text', 1, 1),
        assistant(16, 'final answer', 1, 2),
        toolResult(18, 'trailing'),
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 3_904_000 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelector('[data-turn-tail="1"]')?.textContent)
      .not.toContain('用时 1小时05分03秒')
  })

  it('the settled footer shows usage only in Detailed mode', () => {
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
    expect(view.queryByRole('dialog')).toBeNull()
    const footer = view.container.querySelector<HTMLElement>('[data-turn-tail="1"]')!
    expect(within(footer).queryByRole('button', { name: /用时/ })).toBeNull()
    expect(turnProcessControl(view.container)?.textContent).toBe('用时 19秒')
    act(() => { h.setPerformanceUsage('compact') })
    expect(view.queryByRole('button', { name: /用量/ })).toBeNull()
    act(() => { h.setPerformanceUsage('detailed') })
    expect(view.getByRole('button', { name: /用量/ })).toBeTruthy()
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
    const footer = view.container.querySelector<HTMLElement>('[data-turn-tail="1"]')!
    expect(within(footer).queryByRole('button', { name: /用时/ })).toBeNull()
    expect(turnProcessControl(view.container)?.textContent).toBe('用时 19秒')
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
    expect(h.forkAt.mock.calls).toEqual([[3]])
  })

  it('disables fork when the indexed Turn has a later steering Node', () => {
    const base = chatSnapshotFixture({
      nodes: [user(1, 'question'), assistant(2, 'answer')],
      turnEnds: new Map([[1, 4]]),
    })
    const later: ChatNode<'steering'> = {
      key: 'fixture:steering:3', id: '3', target: 'chat', kind: 'steering',
      anchorSeq: 3, visibility: 'visible',
      location: { kind: 'turn', turn: base.timeline.turns.get(1)! },
      data: steering(3, 'change direction', 1),
    }
    const builder = new ChatSnapshotBuilder()
    const chat = builder.replace({ nodes: [...base.nodes.values(), later], timeline: base.timeline })
    const h = makeHarness({}, {}, chat)
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('change direction')).toBeTruthy()
    expect(chat.locations.getTurn(1)).toContain(later.key)
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

  it('hands running calls to a live Tool group', withClock(2_000, () => {
    const h = makeHarness({
      runningCalls: [runningCall('r1')],
      turnTimings: new Map([[2, { startTime: 0 }]]),
    }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('tool-seat-r1')).toBeTruthy()
    expect(h.toolOwners[0]?.block).toMatchObject({ callId: 'r1', argsRaw: '{"command":"cmd-r1"}' })
    expect(view.getByRole('status').textContent).toBe('深度求索中')
    const toggle = view.getByRole('button', { name: '深度求索中，用时2秒' }) as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  }))

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

  it('the running clock uses turn/start, ignores steering, and stays out of the live region', withClock(126_000, () => {
    const startTime = 1_000
    const trigger = { ...userInTurn(1, 'go', 1), time: 120_000 }
    const h = makeHarness(
      { nodes: [trigger], turnTimings: new Map([[1, { startTime }]]) },
      { running: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const status = view.getByRole('status')
    const toggle = view.getByRole('button', { name: '深度求索中，用时2分5秒' }) as HTMLButtonElement
    expect(toggle).toBe(turnProcessControl(view.container))
    expect(toggle.disabled).toBe(true)
    expect(status.textContent).toBe('深度求索中')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(toggle.closest('[aria-live]')).toBeNull()
    expect(view.container.querySelector('[data-chat-flow-kind="assistant-step"]')).toBeNull()
    act(() => {
      h.setSession({ testInbox: { 'next-turn': [], 'next-step': [{
        id: 'steering-occurrence' as never,
        content: [{ type: 'text', text: 'also' }],

        role: 'user', source: { kind: 'user' },
      }] } })
    })
    expect(toggle.textContent).toBe('深度求索中，用时2分5秒')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(toggle.textContent).toBe('深度求索中，用时2分7秒')
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('深度求索中')
    act(() => {
      h.setSession({ testInbox: { 'next-turn': [], 'next-step': [] } })
      h.setChat({ nodes: [trigger, { ...steering(2, 'also', 1), time: 128_000 }] })
    })
    expect(turnProcessControl(view.container)).toBe(toggle)
    expect(toggle.textContent).toBe('深度求索中，用时2分7秒')
    expect(view.getByText('also').closest('[data-pending-steering]')).toBeNull()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(toggle.textContent).toBe('深度求索中，用时2分8秒')
    expect(status.textContent).toBe('深度求索中')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  }))

  it('the running clock reads hours once the turn passes an hour', withClock(3_600_000, () => {
    const startTime = 1_000
    const trigger = { ...userInTurn(1, 'go', 1), time: startTime + 1 }
    const h = makeHarness(
      { nodes: [trigger], turnTimings: new Map([[1, { startTime }]]) },
      { running: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const toggle = view.getByRole('button', { name: '深度求索中，用时59分59秒' })
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(toggle.textContent).toBe('深度求索中，用时1小时00分0秒')
    act(() => { vi.advanceTimersByTime(303_000) })
    expect(toggle.textContent).toBe('深度求索中，用时1小时05分3秒')
    expect(view.getByRole('status').textContent).toBe('深度求索中')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  }))

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
      owner: { node: { kind: 'tool-call' } },
      entryKey: 'tool-call',
    })
    const owner = calls[0]?.owner as RoutedChatNodeOwner
    expect((owner.node.data as { readonly root: ToolCallBlock }).root).toBe(block)
    expect(owner.openFile).not.toBe(h.openFile)
    owner.openFile('src/a.ts')
    expect(h.openFile).toHaveBeenCalledWith('src/a.ts')
    owner.inspectCall?.('a')
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
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
    expect(scroller.scrollTop).toBe(1200)
  })

  it('back-to-bottom cancels an in-flight paging anchor', () => {
    const h = makeHarness({ nodes: [user(9, 'late')] }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    readerScroll(scroller, 50)
    fireEvent.click(view.getByText('加载更早'))
    fireEvent.click(view.getByLabelText('回到底部'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_300, writable: true })
    act(() => { h.setChat({ nodes: [assistant(2, 'older'), user(9, 'late')] }) })
    expect(scroller.scrollTop).toBe(1_100)
    expect(h.chatScroll.read()).toBeNull()
  })

  it('scrolling away disables follow and shows the back-to-bottom button; clicking returns', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    readerScroll(scroller, 100) // far from bottom
    const backButton = view.getByLabelText('回到底部')
    expect(backButton).toBeTruthy()
    expect(view.container.querySelector('[data-chat-following-tail]')).toBeNull()
    // Streaming growth must NOT drag a scrolled-away reader down.
    act(() => {
      h.setChat({ partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'grow' }] } })
    })
    expect(scroller.scrollTop).toBe(100)
    fireEvent.click(backButton)
    expect(scroller.scrollTop).toBe(700)
    expect(view.container.querySelector('[data-chat-following-tail]')).not.toBeNull()
    // At the bottom again: follow re-arms and the button unmounts.
    expect(view.queryByLabelText('回到底部')).toBeNull()
  })

  it('keeps following when a stream-finalization shrink clamp delivers its scroll', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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

  it('keeps following when a shrink clamp regrows before scrollend', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))

    metrics.setLayout(800, 700)
    fireEvent.scroll(scroller)
    metrics.setHeight(962)
    act(() => { h.setSession({ running: true }) })
    fireEvent(scroller, new Event('scrollend'))

    expect(scroller.scrollTop).toBe(662)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()
  })

  it('settles pinned deliveries before observer growth without reading row geometry', () => {
    let notify: (() => void) | undefined
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 9_931, 300)
    expect(notify).toBeDefined()
    scroller.scrollTop = 9_631
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    rect.mockClear()
    try {
      metrics.setLayout(9_918, 9_631)
      fireEvent.scroll(scroller)
      metrics.setHeight(10_013)
      act(() => { notify?.() })
      expect(scroller.scrollTop).toBe(9_713)
      fireEvent.scroll(scroller)
      metrics.setHeight(10_093)
      act(() => { notify?.() })
      expect(scroller.scrollTop).toBe(9_793)
      expect(rect).not.toHaveBeenCalled()
      expect(h.chatScroll.read()).toBeNull()
    } finally {
      rect.mockRestore()
    }
  })

  it('lets small reader movements accumulate past the follow threshold during growth', () => {
    let notify: (() => void) | undefined
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    expect(notify).toBeDefined()
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    scroller.scrollTop = 690
    fireEvent.scroll(scroller)
    metrics.setHeight(1_020)
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(690)
    scroller.scrollTop = 680
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    expect(view.getByLabelText('回到底部')).toBeTruthy()
    metrics.setHeight(1_040)
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(680)
  })

  it('keeps following when reader input reaches the floor before growth and scrollend', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    readerScroll(scroller, 100)
    expect(view.getByLabelText('回到底部')).toBeTruthy()

    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    metrics.setHeight(1_030)
    act(() => { h.setSession({ running: true }) })
    fireEvent(scroller, new Event('scrollend'))

    expect(scroller.scrollTop).toBe(730)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()
  })

  it('follows a new submission immediately while an earlier scroll sample is pending', () => {
    const nodes = [user(1, 'q'), assistant(2, 'a')]
    const h = makeHarness({ nodes })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    readerScroll(scroller, 700)
    scroller.scrollTop = 650
    fireEvent.scroll(scroller)

    metrics.setHeight(1_135)
    act(() => {
      h.setSession({
        pendingSubmissions: [{
          requestId: 'req-follow' as never, placement: 'transcript',
          time: 5_000, text: 'new prompt', attachments: [],
        }],
      })
    })
    expect(scroller.scrollTop).toBe(835)

    metrics.setHeight(1_200)
    act(() => {
      h.setChat({ nodes: [...nodes, user(3, 'new prompt'), assistant(4, 'reply')] })
      h.setSession({ pendingSubmissions: [], running: true })
    })
    fireEvent(scroller, new Event('scrollend'))
    expect(scroller.scrollTop).toBe(900)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()
  })

  it('clears an away sample when a back-to-bottom delivery restores pinned ownership', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    scroller.scrollTop = 500
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)
    fireEvent.click(view.getByLabelText('回到底部'))
    fireEvent.scroll(scroller)
    metrics.setHeight(1_200)
    act(() => { h.setSession({ running: true }) })
    expect(scroller.scrollTop).toBe(900)
    expect(h.chatScroll.read()).toBeNull()
  })

  it('samples away-reader geometry on the interval or scrollend and cancels it on unmount', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />)
      const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
      installScrollMetrics(scroller, 1_000, 300)
      scroller.scrollTop = 700
      fireEvent.scroll(scroller)
      scroller.scrollTop = 500
      fireEvent.scroll(scroller)
      fireEvent(scroller, new Event('scrollend'))
      expect(view.getByLabelText('回到底部')).toBeTruthy()
      const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      try {
        act(() => { vi.advanceTimersByTime(500) })
        rect.mockClear()
        scroller.scrollTop = 400
        fireEvent.scroll(scroller)
        scroller.scrollTop = 300
        fireEvent.scroll(scroller)
        act(() => { vi.advanceTimersByTime(499) })
        expect(rect).not.toHaveBeenCalled()
        act(() => { vi.advanceTimersByTime(1) })
        expect(rect).toHaveBeenCalled()
        rect.mockClear()
        scroller.scrollTop = 200
        fireEvent.scroll(scroller)
        expect(rect).not.toHaveBeenCalled()
        fireEvent(scroller, new Event('scrollend'))
        expect(rect).toHaveBeenCalled()
        scroller.scrollTop = 100
        fireEvent.scroll(scroller)
        view.unmount()
        rect.mockClear()
        act(() => { vi.advanceTimersByTime(500) })
        expect(rect).not.toHaveBeenCalled()
      } finally {
        rect.mockRestore()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the last delivered top when compositor scrolling precedes scroll delivery', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
    const observe = vi.fn<(element: Element) => void>()
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
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(900)
    readerScroll(scroller, 200)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_400, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(200)
    expect(observe.mock.calls.map(([element]) => element)).toEqual([
      view.container.querySelector('[data-chat-flow]'), scroller,
    ])
  })

  it('pinned dynamic-height updates select the latest Turn without reading row geometry', async () => {
    let notify: (() => void) | undefined
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1
      frames.set(nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    const RailObserver = ResizeObserver
    class ResizeObserverStub extends RailObserver {
      private readonly onResize: () => void

      constructor(callback: ResizeObserverCallback) {
        super(callback)
        this.onResize = () => { callback([], this) }
      }

      override observe(element: Element): void {
        super.observe(element)
        if (element.closest('nav') === null) notify = this.onResize
      }
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
    await view.findByRole('button', { name: '跳转到第 2 轮' })
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
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
      expect(host.scrollTop).toBe(1500)
      readerScroll(host, 100)
      expect(view.getByLabelText('回到底部')).toBeTruthy()
      fireEvent.click(view.getByLabelText('回到底部'))
      expect(host.scrollTop).toBe(1500)
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
    let anchorOffset = 180
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 500 } as DOMRect),
    )
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:1') {
        const anchorTop = anchorOffset - host.scrollTop
        return { top: anchorTop, bottom: anchorTop + 40 } as DOMRect
      }
      return { top: 0, bottom: 40 } as DOMRect
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      // Fresh open (nothing saved): the bottom jump stands.
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(1500)
      // Reader scrolls up; the position is recorded continuously.
      readerScroll(host, 100)
      // View-tab switch away and back: the view unmounts, then remounts.
      view.rerender(<div />)
      anchorOffset = 660
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(580)
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
      if (this.dataset.chatAnchorKey === 'fixture:user:1') {
        const top = 1_700 - host.scrollTop
        return { top, bottom: top + 40 } as DOMRect
      }
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
      expect(host.scrollTop).toBe(1500)
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
    expect(fv.container.querySelector('[data-state="error"] svg')).not.toBeNull()
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
