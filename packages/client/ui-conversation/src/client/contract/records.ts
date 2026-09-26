// Each publication replaces the top-level snapshot while preserving unchanged
// substructure references. Stable node and location stores make old snapshots
// live readers rather than time-point views.

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { ContextProducerView, KnownContextForm } from './context-producer.ts'
export type { TodoItem }

/** Request configuration recorded for one provider call. */
export interface AssistantRequestConfig {
  provider: string
  model: string
  purpose?: string
  thinking?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

/** Stable provider/model identity reported for one completed request. */
export interface AssistantProviderMetadataView {
  provider: string
  model: string
}

/** Assistant content blocks sorted by what a UI target presents. */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; attachment: ImageAttachmentRef }
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  | { kind: 'other'; block: unknown }

/** A finalized user message. */
export interface UserMessageNode {
  kind: 'user'
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** Recorded boundaries used to derive assistant latency and throughput. */
export interface AssistantTiming {
  /** Matching step/start timestamp, or null when it is outside the current event window. */
  stepStartTime: number | null
  /** First non-empty text/reasoning/tool delta timestamp, or null when no token delta was recorded. */
  firstTokenTime: number | null
  /** Final assistant/message timestamp. */
  completedTime: number
}

/** A finalized assistant message or an interruption-frozen streaming prefix. */
export interface AssistantMessageNode {
  kind: 'assistant'
  seq: number
  /**
   * Stable identity carried from the `assistant/message` event. Absent only on
   * synthetic interruption fallbacks assembled from chunks without a durable
   * assistant message.
   */
  messageId?: MessageId
  /** Unix epoch ms from the source session event (or turn/end when frozen from a partial). */
  time: number
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
  usage?: unknown
  providerMetadata?: AssistantProviderMetadataView
  requestConfig?: AssistantRequestConfig
  /** Timing derived from the recorded step/chunk/message event sequence. */
  timing?: AssistantTiming
  /** Prefix of an aborted turn, rendered with a 已停止 marker. A durable
   *  finalized prefix uses its event seq; a chunk-only fallback uses a fractional
   *  seq derived from the closing boundary to keep it ordered inside the flow. */
  interrupted?: true
}

/** A human message admitted from the next-step inbox while a turn was running. */
export interface SteeringMessageNode {
  kind: 'steering'
  /** Stable message identity shared with its pre-admission inbox occurrence. */
  messageId: MessageId
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** A context/system injection surfaced in the flow. */
export interface ContextMessageNode {
  kind: 'context'
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly ContentBlock[]
  source: unknown
  /** Role and producer name projected from `source` by the target. */
  producer: ContextProducerView
  /** Producer-declared information form supported by the target; null presents as opaque. */
  form: KnownContextForm | null
}

/** Durable notice that a closed failed step is waiting for a model-request retry. */
export type ModelRetryNode = LlmRetryEventData & {
  kind: 'model-retry'
  seq: number
  /** Unix epoch ms from the llm/retry session event. */
  time: number
  /**
   * Client-derived lifecycle: scheduled until a retry turn starts, started
   * once it does, or cancelled when the failed turn aborts first.
   */
  retryState: 'scheduled' | 'started' | 'cancelled'
}

/**
 * Durable terminal failure for a turn that ended with an error reason; the
 * turn's settled retry chain renders separately and never replaces this node.
 */
export interface TurnErrorNode {
  kind: 'turn-error'
  /** Seq of the owning turn/end event. */
  seq: number
  /** Unix epoch ms from the turn/end event. */
  time: number
  turn: number
  step: number
  /** Sanitized provider message; empty when a known code owns localized copy. */
  message: string
  /** Stable provider failure code, when recorded. */
  code?: string
}

/** Durable notice for a turn ended by the per-request output-token cap. */
export interface TurnMaxTokensNode {
  kind: 'turn-max-tokens'
  /** Seq of the owning turn/end event. */
  seq: number
  /** Unix epoch ms from the turn/end event. */
  time: number
  turn: number
  step: number
}

/** A tool result paired (when in-window) with its call head. */
export interface ToolResultNode {
  kind: 'tool-result'
  seq: number
  /** Unix epoch ms from the tool/result session event. */
  time: number
  callId: string
  /** Parent Tool call for a PTC dispatch result; absent on a root Session result. */
  parentCallId?: string
  /** Call head backfilled from the in-window tool/call; null when window truncation left the call outside (card head shows callId). */
  call: { name: string; argsRaw: string } | null
  /** Unix epoch ms of the paired tool/call when the call is still in-window; used for call-row duration. */
  callTime: number | null
  content: readonly ContentBlock[]
  isError: boolean
  error?: { name: string; code: string; reason?: string }
  meta?: unknown
  /** Child calls owned by this call, in dispatch order. */
  subCalls: readonly ToolCallBlock[]
}

/**
 * One landed compaction, marked at the checkpoint's own log position. The
 * conversation it shadowed on the model surface stays in the transcript above
 * it: the marker reports where the model stopped seeing that history, it does
 * not replace it. The framed checkpoint payload is an instruction envelope
 * written for the model and never renders.
 */
export interface CompactionSummaryNode {
  kind: 'compaction'
  /** Seq of the replacement `user/message` that landed the checkpoint. */
  seq: number
  /** Unix epoch ms of the checkpoint event. */
  time: number
  /** Summary text from the checkpoint's cited `compaction/summary` event; null when
   *  the window cut left that event outside (the marker is then not expandable). */
  summary: string | null
  /** Seq of the loaded `compaction/summary` event, or null when that event is outside the window. */
  summaryEventSeq: number | null
  /** Number of surface items replaced, or null when the summary event is unavailable or malformed. */
  shadowedItemCount: number | null
  /** Estimated token price of the replaced items, or null when the summary event is unavailable or malformed. */
  shadowedTokenCount: number | null
}

/**
 * Fallback for unclaimed append-surface events. The merge-extensible
 * SessionEventMap permits unfamiliar events to retain a raw presentation.
 * Known unsupported developer events throw before fallback selection.
 */
export interface UnknownSurfaceNode {
  kind: 'unknown'
  seq: number
  /** Unix epoch ms from the source session event when known. */
  time: number
  type: string
  data: unknown
}

/**
 * One slash-command lifecycle folded from the log-only `command/run` /
 * `command/done` pair (paired by commandId, mirroring tool call↔result).
 * Log-only events are not surface events, so the command Definition indexes
 * them separately and the Chat builder orders the resulting node by seq. A window cut
 * between the pair soft-falls like tool pairs: a done with no in-window run
 * still builds a node (name/args null), and a run with no done renders as
 * still executing.
 */
export interface CommandNode {
  kind: 'command'
  /** Seq of the command/run event; the done event's seq when only the done is in-window. */
  seq: number
  /** Unix epoch ms of the anchoring event. */
  time: number
  /** Pairing id minted by the host executor. */
  commandId: CommandId
  /** Command name (run payload's structured field); null when the run fell outside the window. */
  name: string | null
  /**
   * Verbatim rawInput after the name, including separator whitespace; null
   * when omitted by the command or when the run fell outside the window.
   */
  args: string | null
  /** Settlement outcome (done payload); null while the command is still executing. */
  outcome: {
    kind: 'success' | 'error'
    text?: string
    /** Earlier authoritative domain event for a richer client-computed presentation. */
    sourceEventSeq?: number
  } | null
}

/** Finalized conversation node union (kind discriminates; seq is the React key). */
export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | SteeringMessageNode
  | ContextMessageNode
  | ModelRetryNode
  | TurnErrorNode
  | TurnMaxTokensNode
  | ToolResultNode
  | CommandNode
  | CompactionSummaryNode
  | UnknownSurfaceNode

/** Identity and placement shared by tool preparation and dispatch. */
interface ToolCallHead {
  callId: string
  /** Parent Tool call for a PTC dispatch start; absent on a root Session call. */
  parentCallId?: string
  name: string
  turn: number
  step: number
  /** Unix epoch ms when this stage began. */
  time: number
  /** Child calls owned by this call, in dispatch order. */
  subCalls: readonly ToolCallBlock[]
}

/** A named model call whose arguments are not yet available to tool views. */
export interface PreparingToolCall extends ToolCallHead {
  readonly phase: 'preparing'
}

/** A dispatched tool call with complete arguments and no result yet. */
export interface StartedToolCall extends ToolCallHead {
  readonly phase: 'start'
  readonly argsRaw: string
}

/** A tool still preparing or awaiting its result. */
export type RunningToolCall = PreparingToolCall | StartedToolCall

/** One preparing, dispatched, or settled call, recursively owning its child calls. */
export type ToolCallBlock = RunningToolCall | ToolResultNode

/** In-progress assistant output (chunk accumulator product). */
export interface PartialAssistant {
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
}
