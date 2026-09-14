/**
 * `--json` run projection: a bounded, ordered event stream derived from one
 * Agent's durable Session events. Every projected event is a commit point:
 * text and reasoning come from committed `assistant/message` content, never
 * from a live attempt that may still be retried or discarded, so the stream
 * never carries content the durable log does not contain.
 * @module @deepseek-ai/dsh-headless/json-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Default per-string and per-key cap applied to every bounded projected payload. */
export const MAX_STRING_BYTES = 8 * 1024

/** Default cap on one projected event's serialized bytes, newline included; the terminal `final` is exempt. */
export const MAX_EVENT_BYTES = 32 * 1024

/** Bytes every newline-delimited writer appends after one serialized event. */
const LINE_TERMINATOR_BYTES = 1

/** The stdout sink a projection writes newline-delimited events to. */
export interface JsonSink {
  /** Write one chunk of the event stream. */
  write(chunk: string): unknown
}

/** Tunables for {@link projectJsonRun}; every field defaults. */
export interface JsonProjectionOptions {
  /** Working directory reported by the opening `session` event. */
  cwd?: string
  /** Per-string and per-key byte cap; longer values are truncated and flagged. */
  maxStringBytes?: number
}

/** The live handle of one `--json` projection. */
export interface JsonProjection {
  /** Write the terminal `final` event carrying the run's answer text. */
  finish(text: string): void
  /** Stop observing the Session. */
  dispose(): void
}

/** Mutable truncation state threaded through one payload bound. */
interface BoundState {
  truncated: boolean
}

/** Truncate one UTF-8 string to `maxBytes`, dropping a split trailing character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  const decoded = buffer.toString('utf8')
  return decoded.endsWith('\uFFFD') ? decoded.slice(0, -1) : decoded
}

/** Cap one object key, flagging the payload when it was cut. */
function boundKey(key: string, maxBytes: number, state: BoundState): string {
  if (Buffer.byteLength(key, 'utf8') <= maxBytes) return key
  state.truncated = true
  return truncateUtf8(key, maxBytes)
}

/** Maximum container depth one projected payload keeps before the tail is cut. */
const MAX_DEPTH = 64

/** Recursively cap every string in one JSON-serializable value, keys included. */
function boundValue(value: unknown, maxBytes: number, state: BoundState, depth = 0): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
    state.truncated = true
    return truncateUtf8(value, maxBytes)
  }
  if (Array.isArray(value)) {
    // A legal but pathologically deep argument would otherwise recurse until
    // the stack overflows, and the isolated listener would silently drop the
    // event; cut the tail at a depth no real tool schema reaches.
    if (depth >= MAX_DEPTH) {
      state.truncated = true
      return '[truncated: depth]'
    }
    return value.map(item => boundValue(item, maxBytes, state, depth + 1))
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) {
      state.truncated = true
      return '[truncated: depth]'
    }
    // A null prototype keeps a literal `__proto__` key as data instead of
    // invoking the inherited setter, which would silently drop it. Two keys
    // that share a truncated prefix collide last-wins; only a payload naming
    // two multi-kilobyte keys can reach that.
    const bounded = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value)) {
      bounded[boundKey(key, maxBytes, state)] = boundValue(item, maxBytes, state, depth + 1)
    }
    return bounded
  }
  return value
}

/**
 * Bound every string and key in one projected payload, adding `truncated: true`
 * when any was cut. {@link boundJsonLine} composes this with the whole-line cap.
 * @param event - the event payload to bound.
 * @param maxStringBytes - per-string and per-key byte cap.
 * @returns a copy with every over-long string and key truncated.
 */
function boundJsonEvent(
  event: Record<string, unknown>,
  maxStringBytes: number = MAX_STRING_BYTES,
): Record<string, unknown> {
  const state: BoundState = { truncated: false }
  const bounded = boundValue(event, maxStringBytes, state) as Record<string, unknown>
  if (state.truncated) bounded.truncated = true
  return bounded
}

/**
 * Serialize one projected payload under both limits: every string and key is
 * capped at `maxStringBytes`, and the serialized line at `maxEventBytes`. The
 * line cap reserves the newline the writer appends, so the complete record
 * stays within it. When the line is still too long, scalar fields survive and
 * structured fields are dropped; when even those are too long, only `type` and
 * `truncated` remain.
 * @param event - the event payload to serialize.
 * @param maxStringBytes - per-string and per-key byte cap.
 * @param maxEventBytes - cap on the serialized line plus its trailing newline.
 * @returns the bounded JSON line, without a trailing newline.
 */
export function boundJsonLine(
  event: Record<string, unknown>,
  maxStringBytes: number = MAX_STRING_BYTES,
  maxEventBytes: number = MAX_EVENT_BYTES,
): string {
  const limit = maxEventBytes - LINE_TERMINATOR_BYTES
  const bounded = boundJsonEvent(event, maxStringBytes)
  const line = JSON.stringify(bounded)
  if (Buffer.byteLength(line, 'utf8') <= limit) return line
  const scalars = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(bounded)) {
    if (value === null || typeof value !== 'object') scalars[key] = value
  }
  scalars.truncated = true
  const short = JSON.stringify(scalars)
  if (Buffer.byteLength(short, 'utf8') <= limit) return short
  return JSON.stringify({ type: bounded.type, truncated: true })
}

/**
 * Parse raw tool-call arguments as the executor does: empty input is `{}`,
 * invalid or non-round-trippable JSON (a non-finite number) stays text.
 */
function parseArguments(raw: string): unknown {
  if (raw === '') return {}
  const seen = { nonFinite: false }
  try {
    const parsed = JSON.parse(raw, (_key, value: unknown) => {
      // `1e400` is valid JSON but parses to Infinity, which JSON.stringify
      // reports as null; keep the raw text rather than misdescribe the call.
      if (typeof value === 'number' && !Number.isFinite(value)) seen.nonFinite = true
      return value
    }) as unknown
    return seen.nonFinite ? raw : parsed
  } catch {
    return raw
  }
}

/** Join the text blocks of a tool result's model-facing content. */
function resultText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: string; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Provider token accounting for one step, as carried by `assistant/message`. */
type StepUsage = NonNullable<SessionEvent<'assistant/message'>['data']['usage']>

/** Accumulated usage for one step plus whether every attempt reported a sample. */
interface StepUsageState {
  usage: StepUsage | undefined
  /** False once any attempt in the step omitted a usage sample. */
  complete: boolean
}

/** The usage a provider reported in one attempt's stream, if any. */
function streamUsage(stream: SessionEvent<'assistant/message'>['data']['stream']): StepUsage | undefined {
  return lastAssistantStreamChunk(stream, 'usage')?.usage
}

/**
 * Accumulate one step's usage across its attempts. A retried attempt keeps its
 * usage only in its `assistant/attempt` stream, so the committed message alone
 * would under-report billed tokens. An attempt that reports no sample makes the
 * step total unknowable, so the step omits usage entirely rather than publish a
 * partial sum as if it were complete; an optional bucket is summed only when
 * every contribution reports it.
 * @param state - usage accumulated so far and whether it is still complete.
 * @param next - usage reported by the next attempt.
 * @returns the updated state.
 */
function addUsage(state: StepUsageState, next: StepUsage | undefined): StepUsageState {
  if (next === undefined) return { usage: state.usage, complete: false }
  if (state.usage === undefined) return { usage: next, complete: state.complete }
  const total = state.usage
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined || b === undefined ? undefined : a + b
  const totalTokens = sum(total.totalTokens, next.totalTokens)
  const cacheReadTokens = sum(total.cacheReadTokens, next.cacheReadTokens)
  const cacheWriteTokens = sum(total.cacheWriteTokens, next.cacheWriteTokens)
  const reasoningTokens = sum(total.reasoningTokens, next.reasoningTokens)
  return {
    usage: {
      inputTokens: total.inputTokens + next.inputTokens,
      outputTokens: total.outputTokens + next.outputTokens,
      ...totalTokens === undefined ? {} : { totalTokens },
      ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
      ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
      ...reasoningTokens === undefined ? {} : { reasoningTokens },
    },
    complete: state.complete,
  }
}

/**
 * Project one Agent's run as newline-delimited JSON on `sink`.
 *
 * The opening `session` event is written before the subscription starts, so a
 * caller must invoke this before submitting the task. Text and reasoning are
 * emitted only when the step's `assistant/message` commits them, and the
 * terminal `final` event carries the same lossless answer the default mode
 * prints (it is deliberately not bounded).
 * @param ctx - plugin context carrying the live Session feed.
 * @param agent - the exact Agent whose events belong to this invocation.
 * @param sink - stdout sink receiving one JSON object per line.
 * @param options - projection tunables.
 * @returns the projection handle that finishes or disposes the stream.
 */
export function projectJsonRun(
  ctx: Context,
  agent: Agent,
  sink: JsonSink,
  options: JsonProjectionOptions = {},
): JsonProjection {
  const maxStringBytes = options.maxStringBytes ?? MAX_STRING_BYTES
  let disposed = false
  let stepUsage: StepUsageState = { usage: undefined, complete: true }

  const write = (event: Record<string, unknown>): void => {
    sink.write(`${boundJsonLine(event, maxStringBytes)}\n`)
  }

  const onSessionEvent = (session: unknown, event: SessionEvent): void => {
    if (session !== agent.session) return
    switch (event.type) {
      case 'turn/start':
        write({ type: 'status', phase: 'turn_start', turn: event.data.turn })
        return
      case 'step/start':
        write({ type: 'status', phase: 'step_start', turn: event.data.turn, step: event.data.step })
        return
      case 'assistant/attempt':
        // A retried attempt has no committed message; its billed tokens live
        // only in the stream, so accumulate them into the step's total.
        stepUsage = addUsage(stepUsage, streamUsage(event.data.stream))
        return
      case 'assistant/message':
        stepUsage = addUsage(stepUsage, event.data.usage ?? streamUsage(event.data.stream))
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') write({ type: 'thinking', text: block.text })
          else if (block.type === 'text') write({ type: 'text', text: block.text })
        }
        return
      case 'step/end': {
        const { usage, complete } = stepUsage
        stepUsage = { usage: undefined, complete: true }
        write({
          type: 'status', phase: 'step_end', turn: event.data.turn, step: event.data.step,
          // A partial sum would read as an exact total, so omit it entirely
          // when any attempt in the step failed to report usage.
          ...complete && usage !== undefined ? { usage } : {},
        })
        return
      }
      case 'turn/end':
        write({ type: 'status', phase: 'turn_end', turn: event.data.turn, reason: event.data.reason })
        return
      case 'tool/call':
        write({
          type: 'tool_call',
          callId: event.data.callId,
          tool: event.data.name,
          input: parseArguments(event.data.arguments),
        })
        return
      case 'tool/result': {
        // Compaction replaces older results in the surface; those are history,
        // not this run's output, and would otherwise duplicate a callId.
        if (event.surfaceOp !== 'append') return
        const block = event.data.message.content[0]
        write({
          type: 'tool_result',
          callId: block.toolCallId,
          status: block.isError === true ? 'error' : 'completed',
          result: resultText(block.content),
        })
        return
      }
      default:
        return
    }
  }

  write({ type: 'session', sessionId: agent.id, cwd: options.cwd ?? process.cwd() })
  const stopSession = ctx.on('session/event', onSessionEvent)

  return {
    finish(text: string): void {
      // The answer is the lossless terminal contract, so it is not truncated.
      if (disposed) return
      sink.write(`${JSON.stringify({ type: 'final', text })}\n`)
    },
    dispose(): void {
      disposed = true
      stopSession()
    },
  }
}
