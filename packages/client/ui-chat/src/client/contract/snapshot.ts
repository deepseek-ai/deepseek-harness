import type {
  ConversationNode, ConversationTimelineSnapshot, PartialAssistant, RunningToolCall,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from './chat-nodes.ts'
import type { TurnProcessSpec } from './turn-process.ts'

export type {
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig,
  AssistantTiming, CommandNode, CompactionSummaryNode, ContextMessageNode, ConversationNode,
  ModelRetryNode, PartialAssistant, RunningToolCall, SteeringMessageNode, TodoItem,
  ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode, UnknownSurfaceNode,
  UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Per-key observable used by one mounted Chat Node Seat. */
export interface ChatNodeSource {
  /** @returns the current Node for this source's stable key. */
  readonly getSnapshot: () => ChatConversationViewNode | undefined
  /** @param listener - callback for changes to this key. @returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Per-key observable for the Turn-process presentation surrounding one Chat Node. */
export interface ChatNodeProcessSource {
  /** @returns the current presentation, or absence outside a projected Turn process. */
  readonly getSnapshot: () => ChatTurnProcessPresentation | undefined
  /** @param listener - callback for presentation changes. @returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Stable live per-key reader for Chat nodes. */
export interface ChatNodeStore {
  /** @param key - stable Conversation Context key. @returns current Node, when visible or hidden. */
  get(key: string): ChatConversationViewNode | undefined
  /** @param key - stable Conversation Context key. @returns its identity-stable observable source. */
  source(key: string): ChatNodeSource
  /** @param key - stable Conversation Context key. @returns its Turn-process presentation source. */
  processSource(key: string): ChatNodeProcessSource
  /** @returns all currently materialized Nodes without imposing render order. */
  values(): readonly ChatConversationViewNode[]
}

/** One loaded Turn projected into the compact Chat navigation rail. */
export interface TurnNavigationItem {
  readonly turn: number
  /** Stable Conversation Context key the rail scrolls to. */
  readonly anchorKey: string
  /** Bounded prompt preview; empty when the loaded window starts mid-Turn. */
  readonly prompt: string
  /** Bounded assistant-response preview; empty until the Turn answers. */
  readonly response: string
}

/** Stable live navigation projection of the loaded Turns. */
export interface ChatTurnNavigationIndex {
  /**
   * Loaded Turns that have a visible anchor, in timeline order. The array
   * identity changes exactly when a Turn enters, leaves, or changes preview,
   * so a renderer can select it directly as its change signal.
   * @returns current navigation items.
   */
  items(): readonly TurnNavigationItem[]
}

/** Stable live Location index for Chat nodes. */
export interface ChatLocationNodeIndex {
  /** @param turn - owning turn. @returns ordered Chat Node keys in the turn. */
  getTurn(turn: number): readonly string[]
  /** @param turn - owning turn. @param step - owning step. @returns ordered Chat Node keys in the step. */
  getStep(turn: number, step: number): readonly string[]
}

/** Cross-Node presentation facts derived for one Turn process. */
export interface ChatTurnProcessPresentation {
  readonly turn: number
  readonly spec: TurnProcessSpec
  readonly turnClosed: boolean
  readonly hasExternalProcess: boolean
  readonly compactAnswer: boolean
}

/** Compatibility projection backing StatsLine and the legacy top-level snapshot fields. */
export interface LegacyConversationSlice {
  readonly nodes: readonly ConversationNode[]
  readonly turnTimings: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
  readonly turnEnds: ReadonlyMap<number, number>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

/** Incremental Chat publication with immutable order and stable live keyed readers. */
export interface ChatSnapshot {
  readonly order: readonly string[]
  readonly nodes: ChatNodeStore
  readonly locations: ChatLocationNodeIndex
  readonly navigation: ChatTurnNavigationIndex
  readonly timeline: ConversationTimelineSnapshot
  readonly legacy: LegacyConversationSlice
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    chat: ChatSnapshot
  }
}

const EMPTY_LIST: readonly never[] = []
const EMPTY_TIMELINE: ConversationTimelineSnapshot = { turnOrder: EMPTY_LIST, turns: new Map() }
const EMPTY_NODE_SOURCE: ChatNodeSource = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}
const EMPTY_NODE_PROCESS_SOURCE: ChatNodeProcessSource = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

/** Empty Chat target used before a view builder is registered. */
export const EMPTY_CHAT_SNAPSHOT: ChatSnapshot = {
  order: EMPTY_LIST,
  nodes: {
    get: () => undefined,
    source: () => EMPTY_NODE_SOURCE,
    processSource: () => EMPTY_NODE_PROCESS_SOURCE,
    values: () => EMPTY_LIST,
  },
  locations: {
    getTurn: () => EMPTY_LIST,
    getStep: () => EMPTY_LIST,
  },
  navigation: {
    items: () => EMPTY_LIST,
  },
  timeline: EMPTY_TIMELINE,
  legacy: {
    nodes: EMPTY_LIST,
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: EMPTY_LIST,
  },
}
