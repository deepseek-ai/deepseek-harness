import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  AssistantProviderMetadataView, AssistantRequestConfig,
} from './records.ts'

export type {
  AssistantProviderMetadataView, AssistantRequestConfig,
} from './records.ts'

/**
 * Complete model-visible request state in force for an ordinary generation:
 * the `request/header` config and tools plus the system prompt held by the
 * current `system/message` surface node.
 */
export interface ConversationPromptSnapshot {
  /** Provider/model and sampling configuration from the effective request header. */
  config: AssistantRequestConfig
  /**
   * Rendered text of the `system/message` surface node in force for the
   * request; empty when the surface has no system prompt or the node lies
   * outside the loaded history window.
   */
  system: string
  /** Complete tool catalog sent with the request, including tools that were never called. */
  tools: readonly ToolSchema[]
}

/** Effective prompt or introduced system node, anchored at the event that establishes it. */
export interface SystemPromptNode {
  /** Sequence of the system event or replacement that establishes this prompt. */
  seq: number
  /** Unix epoch ms of that event. */
  time: number
  /** Turn the loop committed the node in. */
  turn: number
  /** Step the loop committed the node in. */
  step: number
  /** Rendered system prompt text; empty records "no system prompt". */
  text: string
  /**
   * True for a prompt appended after an earlier loaded system node: an
   * in-history update the model reads at this position, presented where it
   * was committed rather than by the next request header.
   */
  update: boolean
}

/** System/tool change introduced while preparing one ordinary request, or by an in-history prompt update. */
export interface RequestPromptChange {
  /**
   * Sequence of the event that introduced this state: the `system/message`
   * node when it introduced, replaced, or updated the system prompt, otherwise the
   * `request/header` event.
   */
  seq: number
  /** Unix epoch ms of that event. */
  time: number
  /** How the model-visible prompt differs from the previous recorded state. */
  kind: 'initial' | 'system' | 'tools' | 'system-and-tools'
  /** State immediately before this change; absent for the initial header. */
  previous?: ConversationPromptSnapshot
}

/** Canonical prompt snapshot and any model-visible change introduced by one request header. */
export interface RequestPromptInspection {
  /** Complete prompt state in force for the header's request. */
  prompt: ConversationPromptSnapshot
  /** System/tool change relative to the preceding loaded header. */
  change?: RequestPromptChange
}

/**
 * The {@link inspectRequestPrompt} signature as a value seam: Chat and
 * Trajectory Definitions receive it from the uiConversation service because a
 * client bundle cannot value-import another plugin's module.
 */
export type RequestPromptInspector = (
  previous: ConversationPromptSnapshot | undefined,
  event: SessionEvent<'request/header'>,
  system: SystemPromptNode | undefined,
) => RequestPromptInspection

/**
 * Canonicalize one request header against the system node in force and
 * classify the model-visible prompt change.
 * @param previous - Prompt from the preceding loaded request header, when available.
 * @param event - Durable full request header to inspect.
 * @param system - Effective nonempty system prompt after loaded surface replacements; empty when removed.
 * An in-history update already presented its text at its own position, so the header reports no system change for it.
 * @returns The canonical prompt and an initial/system/tool change when it can be established.
 */
export function inspectRequestPrompt(
  previous: ConversationPromptSnapshot | undefined,
  event: SessionEvent<'request/header'>,
  system: SystemPromptNode | undefined,
): RequestPromptInspection {
  const header = event.data.header
  const rawTools: unknown = header.tools
  const prompt: ConversationPromptSnapshot = {
    config: header.config,
    system: system?.text ?? '',
    tools: Array.isArray(rawTools) ? rawTools as readonly ToolSchema[] : [],
  }
  if (previous === undefined && event.data.reason !== 'initial') return { prompt }
  const systemChanged = previous !== undefined && previous.system !== prompt.system && system?.update !== true
  const toolsChanged = previous !== undefined
    && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
  if (previous !== undefined && !systemChanged && !toolsChanged) return { prompt }
  const origin = system !== undefined && (previous === undefined || systemChanged) ? system : event
  return {
    prompt,
    change: {
      seq: origin.seq,
      time: origin.time,
      kind: previous === undefined
        ? 'initial'
        : systemChanged && toolsChanged
          ? 'system-and-tools'
          : systemChanged ? 'system' : 'tools',
      ...(previous === undefined ? {} : { previous }),
    },
  }
}

/** Lifecycle fields shared by ordinary generation and compaction requests. */
interface RequestViewBase {
  /** Sequence that opened the operation represented by this request. */
  startSeq: number
  startedAt: number
  completedAt: number | null
  status: 'running' | 'complete' | 'error'
  error?: string
  /** Stable provider code for localized presentation of known failures. */
  errorCode?: string
  providerMetadata?: AssistantProviderMetadataView
  requestConfig?: AssistantRequestConfig
  usage?: unknown
  /** Assistant message or compaction summary sequence produced by this request. */
  resultSeq?: number
}

/** One ordinary assistant generation assembled from durable request events. */
interface AssistantRequestView extends RequestViewBase {
  purpose: 'assistant'
  turn: number
  /** Agent-loop step that issued this request. */
  step: number
  /** Effective ordinary request input, inherited until a later header changes it. */
  prompt?: ConversationPromptSnapshot
  /** Prompt change logged while preparing this request. */
  promptChange?: RequestPromptChange
  /** Retry ordinal scheduled after a failed ordinary request. */
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
}

/** One compaction provider request, either turn-owned or standalone between turns. */
interface CompactionRequestView extends RequestViewBase {
  purpose: 'compaction'
  /** Owning turn, or `null` when manual compaction ran between turns. */
  turn: number | null
  /** Direct compaction requests do not consume an agent-loop step. */
  step: 0
  /** Compaction replacement message sequence, when one was committed. */
  replacementSeq?: number
  /** Safe compaction summary projection. */
  summary?: readonly ContentBlock[]
  /** Complete compaction provider output before the safe projection. */
  rawOutput?: readonly ContentBlock[]
}

/** One provider request assembled from durable request lifecycle events. */
export type RequestView = AssistantRequestView | CompactionRequestView

/** Request data consumed by the stage-oriented Trajectory layout. */
export interface RequestInspectionSnapshot {
  requests: readonly RequestView[]
  callSchemas: ReadonlyMap<string, ToolSchema>
}
