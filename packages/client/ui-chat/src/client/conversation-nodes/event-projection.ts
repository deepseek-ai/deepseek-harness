/** Chat-owned conversion from durable Session events to Chat view data. */

import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type {
  AssistantBlock, ContextProvenanceView, KnownContextForm,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/* jscpd:ignore-start -- Chat and Trajectory own independent event-to-view projections. */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member]
  if (!Array.isArray(list)) return []
  const seen: string[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const value = record === null ? null : readString(record, field)
    if (value !== null && !seen.includes(value)) seen.push(value)
  }
  return seen
}

function joined(names: string[]): string | null {
  return names.length > 0 ? names.join(', ') : null
}

/** Forms Chat presents structurally; unknown merge-extensible values remain opaque. */
const KNOWN_FORMS: readonly KnownContextForm[] = [
  'instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall',
]

/**
 * Read the target-supported presentation form from a durable message source.
 * @param source - Logged `user/message` source.
 * @returns Supported form, or null for the opaque presentation.
 */
export function contextForm(source: unknown): KnownContextForm | null {
  const record = asRecord(source)
  const form = record === null ? null : readString(record, 'form')
  return form !== null && (KNOWN_FORMS as readonly string[]).includes(form)
    ? form as KnownContextForm
    : null
}

/**
 * Project a durable message source to the Chat row's role and producer label.
 * @param source - Logged `user/message` source.
 * @returns Role and label rendered by Chat.
 */
export function contextProvenance(source: unknown): ContextProvenanceView {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    case 'session-reference':
      return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    case 'agent-instructions':
      return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    case 'plugin':
      return { role: 'inject', label: readString(record, 'plugin') ?? kind }
    case 'skill-invocation':
      return { role: 'inject', label: readString(record, 'name') ?? kind }
    default:
      // MessageSourceMap is merge-extensible; keep an unknown producer
      // visible by its durable kind.
      return { role: 'inject', label: kind }
  }
}

/**
 * Read distinct labels cited by a durable cross-session recall source.
 * @param source - Logged `user/message` source.
 * @returns Labels in first-seen order.
 */
export function sessionRecallLabels(source: unknown): string[] {
  const record = asRecord(source)
  if (record === null || readString(record, 'kind') !== 'session-reference') return []
  return collect(record, 'references', 'label')
}

/**
 * Read the skill name a durable skill-invocation injection loaded.
 * @param source - Logged `user/message` source.
 * @returns The skill name, or null for every other source.
 */
export function skillInvocationName(source: unknown): string | null {
  const record = asRecord(source)
  if (record === null || readString(record, 'kind') !== 'skill-invocation') return null
  return readString(record, 'name')
}

/**
 * Classify finalized Assistant content for Chat rendering.
 * @param content - Core content blocks.
 * @returns Chat blocks in source order.
 */
export function toAssistantBlocks(content: readonly ContentBlock[]): AssistantBlock[] {
  return content.map(toAssistantBlock)
}

/**
 * Classify one finalized Assistant block for Chat rendering.
 * @param block - Core content block.
 * @returns Chat block.
 */
export function toAssistantBlock(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case 'text': return { kind: 'text', text: block.text }
    case 'reasoning': return { kind: 'reasoning', text: block.text }
    case 'image': return { kind: 'image', attachment: block.attachment }
    case 'tool-call': return { kind: 'tool-call', callId: String(block.id), name: block.name, argsRaw: block.arguments }
    default: return { kind: 'other', block }
  }
}

/**
 * Create the initial Chat block for one streamed Assistant block kind.
 * @param blockType - Wire block kind.
 * @returns Empty block ready to receive deltas.
 */
export function emptyAssistantBlock(blockType: string): AssistantBlock {
  switch (blockType) {
    case 'text': return { kind: 'text', text: '' }
    case 'reasoning': return { kind: 'reasoning', text: '' }
    case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
    default: return { kind: 'other', block: null }
  }
}

/** Display-safe failure fields retained by Chat projections. */
export interface DisplayFailure {
  readonly code?: string
  readonly message: string
}

/**
 * Convert a durable failure to locale-independent fields safe for Chat.
 * @param failure - Failure preserved by a Session event.
 * @returns Sanitized message and optional stable provider code.
 */
export function displayFailure(failure: unknown): DisplayFailure {
  if (failure === null || typeof failure !== 'object') return { message: String(failure) }
  const record = failure as { code?: unknown; message?: unknown }
  const code = typeof record.code === 'string' ? record.code : undefined
  // Provider AUTH messages may echo a masked or partially preserved credential.
  // Keep the raw diagnostic in the Session log, but never retain it in UI state.
  if (code === 'AUTH') return { code, message: '' }
  return {
    ...(code === undefined ? {} : { code }),
    message: typeof record.message === 'string' ? record.message : JSON.stringify(failure),
  }
}

/**
 * Whether a stream chunk carries visible model output for Chat timing.
 * @param chunk - Stream chunk to inspect.
 * @returns true for a non-empty text, reasoning, or Tool-call delta.
 */
export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/* jscpd:ignore-end */
