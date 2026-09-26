/** Shared trajectory record data and formatting contracts. */

import type { HTMLAttributes } from 'react'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConversationPromptSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TrajectoryTranslate } from './locales.ts'

/** Closed set of trajectory record kinds. */
export type TrajectoryCellKind =
  | 'system'
  | 'user'
  | 'context'
  | 'compacted'
  | 'message'
  | 'tool'
  | 'subtool'

/** Recorded inputs needed to derive assistant TTFT and decode throughput. */
export interface AssistantMetricDetail {
  timingRecorded: boolean
  stepStartTime: number | null
  firstTokenTime: number | null
  completedTime: number | null
  usageProvided: boolean
  outputTokens: number | null
}

/** One source content block preserved in model order for the details panel. */
export interface TrajectorySourceBlock {
  type: string
  content: string
  attachment?: ImageAttachmentRef
  /** Ordinary file metadata; never passed to the image loader. */
  file?: FileAttachmentRef
  callId?: string
  toolName?: string
}

/** Data and optional presentation attributes for one trajectory record. */
export interface TrajectoryCellProps extends HTMLAttributes<HTMLDivElement> {
  /** 1-based record index shown as `#N`. */
  index: number
  /** Projection-stable identity when no single source event owns the record lifecycle. */
  recordId?: string
  kind: TrajectoryCellKind
  /** Non-Markdown summary or prefix; CSS ellipsis when it overflows. */
  text: string
  /** Raw Markdown source converted into the single-line summary at its consumer. */
  previewMarkdown?: string
  /** Whether this user record opens a new model turn. */
  opensTurn?: boolean
  /** Source session-event seq for cross-record navigation. */
  sourceSeq?: number
  /** Producer role and name from a user-role message or context injection. */
  messageSource?: unknown
  /** Producer-owned model-hidden metadata carried beside the message source. */
  /** A separator-only anchor for an auxiliary request with no visible record. */
  requestOnly?: boolean
  /** Full request/message content for the details panel. */
  inputDetail?: string
  /** Complete system-prompt/tool-catalog state introduced by a SYSTEM record. */
  promptDetail?: ConversationPromptSnapshot
  /** Known prompt text without a loaded request config or tool catalog. */
  systemPromptDetail?: string
  /** System-prompt/tool-catalog state replaced by a SYSTEM update. */
  previousPromptDetail?: ConversationPromptSnapshot
  /** Full assistant/tool result content for the details panel. */
  outputDetail?: string
  /** Full assistant reasoning content for the details panel. */
  thinkingDetail?: string
  /** Original message blocks in source order for the details panel. */
  sourceBlocks?: readonly TrajectorySourceBlock[]
  /** Original tool result blocks in source order for the details panel. */
  outputBlocks?: readonly TrajectorySourceBlock[]
  /** Call-time model-visible tool schema for the details panel. */
  schemaDetail?: string
  /** Assistant-only timing and token facts for the details panel. */
  assistantMetrics?: AssistantMetricDetail
  /** Tool-only result summary paired with the call in the same record. */
  result?: string
  /** Raw Markdown source converted into the tool-result summary at its consumer. */
  resultPreviewMarkdown?: string
  /** Tool call id used to link message source blocks to tool records. */
  callId?: string
  /** Recorded tool name; independent of the display summary. */
  toolName?: string
  /** Tool-only result failure state. */
  isError?: boolean
  /** Own duration in seconds, or `null` when no duration is known. */
  timeSeconds: number | null
  /** Unix epoch milliseconds when this operation actually started, when known. */
  startedAt?: number | null
  /** Message-only prompt token count. */
  input?: number
  /** Message-only input tokens served from a provider cache. */
  cacheRead?: number
  /** Message-only input tokens written into a provider cache. */
  cacheWrite?: number
  /** Message-only completion token count. */
  output?: number
  /** Message-only reasoning token count. */
  think?: number
  /** Whether the legacy standalone cell renders its selection treatment. */
  selected?: boolean
}

/**
 * Resolve the identity that survives prepending older projected records.
 * @param cell - Projected trajectory record.
 * @returns Stable identity from the owning event or tool call, with a fixture fallback.
 */
export function trajectoryRecordId(cell: TrajectoryCellProps): string {
  if (cell.recordId !== undefined) return cell.recordId
  if (cell.callId !== undefined) return `${cell.kind}\u0000call\u0000${cell.callId}`
  if (cell.sourceSeq !== undefined) return `${cell.kind}\u0000seq\u0000${cell.sourceSeq}`
  return `${cell.kind}\u0000index\u0000${cell.index}`
}

/**
 * Format a duration in milliseconds with thousands separators.
 * @param milliseconds - Duration in milliseconds, or `null` when absent.
 * @param t - Trajectory locale translator.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
export function formatDurationMillis(
  milliseconds: number | null,
  t: TrajectoryTranslate,
): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—'
  const integer = String(Math.round(milliseconds))
  return t('unit.milliseconds', {
    value: integer.replace(/\B(?=(\d{3})+(?!\d))/g, ','),
  })
}

/**
 * Format an elapsed duration given in seconds as a millisecond label.
 * @param seconds - Duration seconds, or `null` when absent.
 * @param t - Trajectory locale translator.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
export function formatElapsedSeconds(
  seconds: number | null,
  t: TrajectoryTranslate,
): string {
  return formatDurationMillis(seconds === null ? null : seconds * 1000, t)
}
