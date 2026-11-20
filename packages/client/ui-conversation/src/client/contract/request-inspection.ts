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
  /**
   * Instructions in force per source, derived from the retained system messages;
   * absent when a retained message lacks section metadata.
   */
  sections?: readonly EffectiveSystemSection[]
}

/** One source's instructions in force at a log position. */
export interface EffectiveSystemSection {
  /** Registration name of the source. */
  name: string
  /** Prompt order; name order breaks ties. */
  order: number
  /** Latest admitted text; empty when the source withdrew its guidance but stays registered. */
  text: string
}

/** One source's part of a single system message, classified against the instructions in force before it. */
export interface SystemSectionChange {
  /** Registration name of the source. */
  name: string
  /** `cleared` updates the text to empty; `removed` retires the source; `unchanged` restates identical text. */
  change: 'added' | 'updated' | 'cleared' | 'reordered' | 'removed' | 'unchanged'
  /** Text this message carries for the source; empty for `cleared` and `removed`. */
  text: string
  /** Replacement or retirement notices this message associates with the source. */
  notices: readonly string[]
}

/** Section-attributed reading of one system message, in the order the model read its blocks. */
export interface SystemMessageSections {
  /** One entry per source the message names. */
  changes: readonly SystemSectionChange[]
  /** Nonempty text blocks that no source record references, such as whole-prompt supersession notices. */
  notices: readonly string[]
  /** True when the message supersedes every previously admitted source. */
  reset: boolean
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
  /**
   * True when a positional replacement, such as compaction or a rebuilt system head, established this
   * effective prompt; the model reads the rebuilt history instead of an appended update.
   */
  rebuilt?: true
  /**
   * Instructions in force per source at this prompt, or after the message for a node a message introduces;
   * absent when a retained nonempty message lacks section metadata.
   */
  sections?: readonly EffectiveSystemSection[]
  /** Per-source reading of an in-history update that carries section metadata, against the instructions in force before it. */
  message?: SystemMessageSections
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
  /** True when the system part of this change was rebuilt by a positional replacement rather than appended. */
  rebuilt?: true
  /** Per-source reading of the in-history update that introduced this change, when it carries section metadata. */
  message?: SystemMessageSections
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
    ...(system?.sections === undefined ? {} : { sections: system.sections }),
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
      ...(origin === system && system.rebuilt === true ? { rebuilt: true } : {}),
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
  /** Failure detail; with assistant retry metadata, the last failed attempt even while running or after recovery. */
  error?: string
  /** Stable provider code for `error`, including retained attempt failures, for localized presentation. */
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
