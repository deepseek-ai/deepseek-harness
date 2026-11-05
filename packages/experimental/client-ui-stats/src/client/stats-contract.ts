/** Published performance model: per-step metrics, per-turn aggregates, and marker contributions. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ConversationLocation, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Outcome of one older-history request. */
export type LoadOlderResult = 'grew' | 'exhausted' | 'retry'

/** Token usage counts one assistant message reported. */
export interface StatsUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** One recorded tool call of a step, including its result size and preview. */
export interface StatsCall {
  readonly callId: string
  readonly seq: number
  readonly name: string | null
  readonly hint: string | null
  readonly chars: number | null
  readonly lines: number | null
  readonly error: boolean
  readonly added: number | null
  readonly removed: number | null
  readonly before: string | null
  readonly after: string | null
  readonly args: string | null
  /** Code-Mode dispatch recorded inside a `run_code` call. */
  readonly inner: boolean
  /** Result text kept for the accordion panel. */
  readonly text: string | null
  readonly truncated: boolean
  /** Measured tool duration, or null while the result is missing. */
  readonly ms: number | null
  /** Wall-clock start of the call, for the non-overlapping tool-span union. */
  readonly startedAt: number | null
  /** Wall-clock end of the call, present only after its result settled. */
  readonly endedAt: number | null
}

/** Tool call tally shown as one pill. */
export interface StatsToolCount {
  readonly name: string
  readonly count: number
}

/** Per-step state folded from the event stream. */
export interface StatsStepState {
  readonly turn: number
  readonly step: number
  readonly startSeq: number | null
  readonly startTime: number | null
  readonly endTime: number | null
  readonly ended: boolean
  readonly firstTokenTime: number | null
  readonly messageTime: number | null
  readonly usage: StatsUsage | null
  readonly interrupted: boolean
  readonly toolPairs: number
  readonly toolMs: number
  readonly toolOpen: number
  readonly toolMissing: number
  readonly pending: Readonly<Record<string, number>> | null
  readonly tools: Readonly<Record<string, number>> | null
  readonly calls: Readonly<Record<string, StatsCall>> | null
  readonly starts: Readonly<Record<string, number>> | null
  readonly retries: number
  readonly toolErrors: number
  /** Turn-level marker kind; step states leave this null. */
  readonly mark: 'prompt' | 'end' | null
  readonly prompt: string | null
  /** Durable image references the prompt attached, in message order. */
  readonly images: readonly ImageAttachmentRef[]
  readonly closed: boolean
  readonly closeKind: string | null
  /** Producer source kind of the trigger prompt Context. */
  readonly trigger: string | null
  /** Sender agent name parsed from a team/agent message, or null. */
  readonly triggerSender: string | null
  /** Trimmed one-message answer text, for the Did column preview. */
  readonly answer: string | null
  /** Full answer body kept for expansion, bounded by the fold budget. */
  readonly answerBody: string | null
  /** Whether the stored answer body lost trailing characters. */
  readonly answerTruncated: boolean
}

/** Measured metrics of one step. */
export interface StatsStepMetrics {
  readonly turn: number
  readonly step: number
  readonly startTime: number | null
  readonly endTime: number | null
  readonly context: number | null
  readonly ttft: number | null
  readonly model: number | null
  readonly decode: number | null
  readonly tps: number | null
  readonly output: number | null
  readonly tool: number | null
  /** Union of the paired calls' wall intervals; tool calls may run in parallel. */
  readonly toolWall: number | null
  readonly tools: readonly StatsToolCount[]
  readonly calls: readonly StatsCall[]
  readonly toolOutput: number | null
  readonly retries: number
  readonly toolErrors: number
  /** Trimmed one-line answer preview of the settled assistant message, or null. */
  readonly answer: string | null
  /** Full answer body kept for expansion, or null. */
  readonly answerBody: string | null
  /** Whether the stored answer body lost trailing characters. */
  readonly answerTruncated: boolean
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly cacheHit: number | null
  readonly wall: number | null
  readonly toolPending: number
  readonly running: boolean
  readonly interrupted: boolean
  readonly aborted: boolean
  readonly ttftPending?: number
  readonly mark?: 'prompt' | 'end' | null
  readonly prompt?: string | null
  readonly images?: readonly ImageAttachmentRef[]
  readonly closed?: boolean
  readonly closeKind?: string | null
}

/** Aggregate of one turn. */
export interface StatsTurnMetrics {
  readonly turn: number
  readonly steps: readonly StatsStepMetrics[]
  readonly startTime: number | null
  readonly context: number | null
  readonly ttft: number | null
  readonly ttftPending: number
  readonly model: number | null
  readonly modelPending: number
  readonly decode: number | null
  readonly tps: number | null
  readonly output: number | null
  readonly tool: number | null
  /** Union of the turn's step tool spans; steps never overlap. */
  readonly toolWall: number | null
  readonly toolPending: number
  readonly tools: readonly StatsToolCount[]
  /** Token-weighted cache-read share across the steps that reported usage. */
  readonly cacheHit: number | null
  /** Cache-read tokens summed across the steps that reported usage. */
  readonly cacheRead: number | null
  /** Cache-write tokens summed across the steps that reported usage. */
  readonly cacheWrite: number | null
  /** Prompt tokens summed across the steps that reported usage; the weight of `cacheHit`. */
  readonly cacheContext: number | null
  readonly retries: number
  readonly toolErrors: number
  readonly toolOutput: number
  readonly lastStepWall: number | null
  readonly running: boolean
  readonly interrupted: boolean
  readonly aborted: boolean
  readonly wall: number | null
  /** Compaction transactions recorded in this turn, in start order. */
  readonly compactions: readonly StatsCompactionMetrics[]
  /** Non-step event rows recorded in this turn, in event order. */
  readonly events: readonly StatsEventMetrics[]
  readonly prompt: string | null
  /** Durable image references the prompt attached, in message order. */
  readonly promptImages: readonly ImageAttachmentRef[]
  /** Producer source kind that opened the turn (`user`, `agent-message`, ...). */
  readonly promptSource: string | null
  /** Sender agent name of an automated trigger, or null. */
  readonly promptSender: string | null
  /** Last answer preview measured in the turn. */
  readonly answer: string | null
}

/** Non-step event kinds the Statistics table can explain. */
export type StatsEventKind =
  | 'request-header'
  | 'system-prompt'
  | 'tool-set'
  | 'context-prune'
  | 'request-context'
  | 'model-retry'
  | 'model-attempt'
  | 'context-refresh'
  | 'approval'

/** One synthetic event row: request admission, prompt/tool changes, or a model-free prune. */
export interface StatsEventMetrics {
  readonly kind: StatsEventKind
  readonly turn: number | null
  readonly step: number | null
  readonly time: number
  readonly reason: string | null
  readonly series: boolean
  readonly provider: string | null
  readonly model: string | null
  readonly toolCount: number | null
  readonly surfaceOp: 'append' | 'replace' | 'clear' | null
  readonly chars: number | null
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly shadowedTokens: number | null
  readonly status: string | null
  readonly retry: number | null
  readonly delayMs: number | null
  readonly error: string | null
  readonly label: string | null
}

/** One completed or running compaction transaction with its model-call facts. */
export interface StatsCompactionMetrics {
  readonly compactionId: string
  readonly turn: number | null
  readonly startTime: number
  readonly endTime: number | null
  readonly wall: number | null
  readonly running: boolean
  readonly context: number | null
  readonly output: number | null
  readonly cacheHit: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly provider: string | null
  readonly model: string | null
  readonly shadowedTokens: number | null
  readonly summaryChars: number | null
  readonly error: string | null
}

/** Per-turn compaction rows shown between the step rows. */
export interface StatsCompactionState {
  readonly compactionId: string
  readonly turn: number | null
  readonly startSeq: number
  readonly startTime: number
  readonly summarySeq: number | null
  readonly endSeq: number | null
  readonly endTime: number | null
  readonly error: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly usage: StatsUsage | null
  readonly shadowedTokens: number | null
  readonly summaryChars: number | null
  readonly checkpointSeq: number | null
}

/** One published node: a step's metrics or a turn-level marker. */
export type StatsContribution =
  | { readonly kind: 'step'; readonly metrics: StatsStepMetrics }
  | {
    /** Inner tool calls one Code-Mode root call dispatched; merged into its step. */
    readonly kind: 'inner'
    readonly turn: number
    readonly step: number
    readonly calls: readonly StatsCall[]
  }
  | {
    readonly kind: 'prompt'
    readonly turn: number
    readonly prompt: string | null
    /** Durable image references the prompt attached, in message order. */
    readonly images: readonly ImageAttachmentRef[]
    /** Producer source kind of the triggering user message. */
    readonly source: string
    /** Sender agent name of a team/agent message, or null. */
    readonly sender: string | null
  }
  | {
    readonly kind: 'compaction'
    readonly metrics: StatsCompactionMetrics
  }
  | {
    readonly kind: 'event'
    readonly metrics: StatsEventMetrics
  }
  | {
    readonly kind: 'end'
    readonly turn: number
    readonly closeKind: string | null
    readonly endTime: number | null
  }

/** View node carried from the Definitions into the target builder. */
export interface StatsViewNode extends ConversationViewNode {
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: StatsContribution
}

/** Snapshot published to the view component. */
export interface StatsSnapshot {
  readonly turns: readonly StatsTurnMetrics[]
  readonly stepCount: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Turn and step metrics this target assembles. */
    stats: StatsSnapshot
  }
}
