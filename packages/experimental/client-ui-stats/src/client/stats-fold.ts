/** Event folding and per-step metric derivation for the Statistics table. */

import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { AssistantMessage, ContentBlock, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm/assistant-stream'
// Type-only: the PTC event members this fold reads.
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type {
  StatsCall, StatsStepMetrics, StatsStepState, StatsToolCount,
} from './stats-contract.ts'
import {
  cacheHitRate, cacheReadTokens, cacheWriteTokens, contextTokens, isNumber,
  outputTokens,
} from './stats-usage.ts'

/** Result text kept per call for the accordion panel. */
const TEXT_LIMIT = 16_000

/** Total result text kept per step; calls past the budget keep only their size. */
const STEP_TEXT_BUDGET = 48_000

/** Before/after text kept per edit call. */
const EDIT_TEXT_LIMIT = 8_000

/** Raw arguments kept per call. */
const ARGS_LIMIT = 2_000

/** Calls listed per step. */
export const CALL_LIMIT = 12

/** Clamp text to one line and a maximum length. */
function clip(text: string | null | undefined, max: number): string | null {
  if (typeof text !== 'string') return null
  const value = text.trim().replace(/\s+/g, ' ')
  if (value === '') return null
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Keep the last two path segments; a full path adds nothing to a table cell. */
function shortPath(value: string | null): string | null {
  if (value === null || value === '') return null
  const parts = value.split(/[\\/]/).filter(part => part !== '')
  return parts.length <= 2 ? value : parts.slice(-2).join('/')
}

/** Parse tool arguments into a field map, accepting structured Code-Mode values. */
function argumentsOf(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    // The model produced arguments this build cannot parse; the cell shows no hint.
    return null
  }
}

/** Raw arguments for the inspector, bounded and stringified when structured. */
function rawArgs(raw: unknown): string | null {
  if (typeof raw === 'string') return boundedText(raw, ARGS_LIMIT).text
  if (raw === null || raw === undefined) return null
  try {
    return boundedText(JSON.stringify(raw), ARGS_LIMIT).text
  } catch {
    // A non-serializable argument value has no raw form to show.
    return null
  }
}

/** Keep the first `limit` characters, flagging whether anything was cut. */
function boundedText(text: string, limit: number): { text: string | null; truncated: boolean } {
  if (text === '') return { text: null, truncated: false }
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/** Line count; an empty string counts as zero lines. */
function countLines(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return text.charCodeAt(text.length - 1) === 10 ? lines - 1 : lines
}

/** Read a record entry only when the record owns it, so model ids never resolve inherited members. */
function ownValue<T>(record: Readonly<Record<string, T>> | null, key: string): T | undefined {
  return record !== null && Object.hasOwn(record, key) ? record[key] : undefined
}

/** In-bounds typed-array read: the surrounding loops own the index bound. */
function cell(values: Uint16Array, index: number): number {
  return values[index] as number
}

/** Longest common subsequence length, one rolling row; fine below 400 lines a side. */
function lcsLength(left: readonly string[], right: readonly string[]): number {
  const width = right.length + 1
  let previous = new Uint16Array(width)
  let current = new Uint16Array(width)
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const up = cell(previous, column)
      const leftCell = cell(current, column - 1)
      current[column] = left[row - 1] === right[column - 1]
        ? cell(previous, column - 1) + 1
        : Math.max(up, leftCell)
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return cell(previous, right.length)
}

/** Lines actually added and removed by one replacement. */
function diffLines(before: string, after: string): { added: number; removed: number } {
  const left = before === '' ? [] : before.split('\n')
  const right = after === '' ? [] : after.split('\n')
  if (left.length === 0) return { added: right.length, removed: 0 }
  if (right.length === 0) return { added: 0, removed: left.length }
  if (left.length > 400 || right.length > 400) {
    return {
      added: Math.max(0, right.length - left.length),
      removed: Math.max(0, left.length - right.length),
    }
  }
  const common = lcsLength(left, right)
  return { added: right.length - common, removed: left.length - common }
}

/** Line delta of an edit or write call, or null when the tool has no such measure. */
function editDelta(
  name: string,
  raw: unknown,
): { added: number; removed: number; before: string | null; after: string | null } | null {
  if (name !== 'edit' && name !== 'write' && name !== 'apply_patch') return null
  const args = argumentsOf(raw)
  if (args === null) return null
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string') return value
    }
    return null
  }
  if (name === 'write') {
    const content = pick('content', 'text', 'file_text')
    if (content === null) return null
    return {
      added: countLines(content),
      removed: 0,
      before: null,
      after: boundedText(content, EDIT_TEXT_LIMIT).text,
    }
  }
  const beforeText = pick('old_string', 'old_str', 'old')
  const afterText = pick('new_string', 'new_str', 'new')
  if (beforeText === null && afterText === null) return null
  const counts = diffLines(beforeText ?? '', afterText ?? '')
  return {
    ...counts,
    before: boundedText(beforeText ?? '', EDIT_TEXT_LIMIT).text,
    after: boundedText(afterText ?? '', EDIT_TEXT_LIMIT).text,
  }
}

/** Short call description: file, pattern, command, or the first argument worth naming. */
function toolHint(name: string, raw: unknown): string | null {
  const args = argumentsOf(raw)
  if (args === null) return null
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return null
  }
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return clip(shortPath(pick('file_path', 'path', 'file')), 34)
    case 'grep':
    case 'glob': {
      const pattern = pick('pattern')
      if (pattern === null) return null
      const include = pick('include')
      return clip(include === null ? pattern : `${pattern} (${include})`, 34)
    }
    case 'pwsh':
    case 'shell':
    case 'bash': {
      const description = pick('description') ?? pick('command') ?? ''
      return clip(description.split('\n')[0], 30)
    }
    case 'web_fetch': {
      const url = pick('url')
      return url === null ? null : clip(url.replace(/^https?:\/\//, ''), 34)
    }
    case 'web_search':
      return clip(pick('query'), 30)
    case 'run_code':
    case 'RunCode':
    case 'runCode':
      return clip(pick('description'), 34)
    default:
      return clip(pick('description', 'query', 'path', 'file_path', 'provider', 'method', 'name'), 30)
  }
}

/**
 * Whether one tool name is the Code-Mode runner; its real tools run inside it.
 * @param name - tool name, or null for a nameless call.
 * @returns true when the name is the Code-Mode runner.
 */
export function isCodeMode(name: string | null): boolean {
  return name !== null && /^run_?code$/i.test(name)
}

/** Arguments-derived StatsCall fields shared by a native call and one Code-Mode dispatch. */
function callArguments(
  name: string,
  raw: unknown,
): Pick<StatsCall, 'hint' | 'added' | 'removed' | 'before' | 'after' | 'args'> {
  const delta = editDelta(name, raw)
  return {
    hint: toolHint(name, raw),
    added: delta === null ? null : delta.added,
    removed: delta === null ? null : delta.removed,
    before: delta === null ? null : delta.before,
    after: delta === null ? null : delta.after,
    args: rawArgs(raw),
  }
}

/** Whether one stream chunk counts as the first model token. */
function isTokenDelta(chunk: StreamChunk): boolean {
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

const TEAM_MESSAGE_PREFIX = /^Team message from ([^:]+):/u
const AGENT_MESSAGE_PREFIX = /^Agent (\S+) sent a message:/u
const OPAQUE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Sender agent name of a teammate/agent notification, parsed from its body prefix.
 * @param message - waking user message stamped with its producer source.
 * @returns the readable member name, or null when the frame omits it or carries an opaque session id.
 */
export function triggerSenderOf(message: UserMessage): string | null {
  const kind: string = message.source.kind
  if (kind !== 'agent-message' && kind !== 'team-message') return null
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
  }
  const team = TEAM_MESSAGE_PREFIX.exec(text)
  /* v8 ignore next -- a matched capture group is always present. */
  if (team !== null) return team[1]?.trim() ?? null
  const agent = AGENT_MESSAGE_PREFIX.exec(text)
  const id = agent?.[1] ?? null
  // A raw session UUID is not a readable member name; keep the badge generic.
  return id !== null && OPAQUE_SESSION_ID.test(id) ? null : id
}

/** Answer characters kept for the one-line Did preview. */
const ANSWER_LIMIT = 400
/** Answer characters kept for the expandable body. */
const ANSWER_BODY_LIMIT = 16_000

/** Trimmed answer text, its bounded full body, and whether the body was clipped. */
function answerOf(message: AssistantMessage): {
  preview: string
  body: string
  truncated: boolean
} | null {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  if (text === '') return null
  return {
    preview: text.length > ANSWER_LIMIT ? text.slice(0, ANSWER_LIMIT) : text,
    body: text.length > ANSWER_BODY_LIMIT ? text.slice(0, ANSWER_BODY_LIMIT) : text,
    truncated: text.length > ANSWER_BODY_LIMIT,
  }
}

/**
 * Initial state of one step or one turn-level marker.
 * @param turn - turn number.
 * @param step - step number, or the marker's pseudo step.
 * @param mark - marker kind; steps pass null.
 * @returns the empty state.
 */
export function newState(
  turn: number,
  step: number,
  mark: StatsStepState['mark'] = null,
): StatsStepState {
  return {
    turn,
    step,
    startSeq: null,
    startTime: null,
    endTime: null,
    ended: false,
    firstTokenTime: null,
    messageTime: null,
    usage: null,
    interrupted: false,
    toolPairs: 0,
    toolMs: 0,
    toolOpen: 0,
    toolMissing: 0,
    pending: null,
    tools: null,
    calls: null,
    starts: null,
    retries: 0,
    toolErrors: 0,
    mark,
    prompt: null,
    images: [],
    closed: false,
    closeKind: null,
    trigger: null,
    triggerSender: null,
    answer: null,
    answerBody: null,
    answerTruncated: false,
  }
}

/** Result text: the text blocks of the tool message joined by newlines. */
function resultText(content: readonly ContentBlock[]): string | null {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/** Size, line count, and bounded body of one tool result. */
function resultInfo(content: readonly ContentBlock[]): {
  chars: number
  lines: number
  text: string | null
  truncated: boolean
} {
  const text = resultText(content)
  if (text === null) return { chars: 0, lines: 0, text: null, truncated: false }
  let lines = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  if (text.charCodeAt(text.length - 1) !== 10) lines += 1
  const body = boundedText(text, TEXT_LIMIT)
  return { chars: text.length, lines, text: body.text, truncated: body.truncated }
}

/**
 * User question: only a human-typed `user` source is the text the user wrote.
 * @param message - one user-role message from the Session log.
 * @returns the one-line question and the durable images it attached.
 */
export function promptOf(message: UserMessage): { text: string | null; images: readonly ImageAttachmentRef[] } {
  const parts: string[] = []
  const images: ImageAttachmentRef[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    if (block.type === 'image') images.push(block.attachment)
  }
  return { text: clip(parts.join(' '), 400), images }
}

/** Add one call of `name` to the tally, preserving first-call order for ties. */
function bumpTool(tools: Readonly<Record<string, number>> | null, name: string): Record<string, number> {
  const next: Record<string, number> = { ...(tools ?? {}) }
  next[name] = (next[name] ?? 0) + 1
  return next
}

/**
 * Fold one session event into the step state. Events other than `step/start`
 * create a state when the window starts mid-step, so context and throughput
 * still show while start-dependent metrics stay unrecorded.
 * @param state - current state, or undefined before the first foldable event.
 * @param event - one durable or client-only session event.
 * @returns the next state, or undefined when the event needs a start it lacks.
 */
export function foldEvent(
  state: StatsStepState | undefined,
  event: SessionEventLike,
): StatsStepState | undefined {
  switch (event.type) {
    case 'step/start':
      return { ...newState(event.data.turn, event.data.step), startSeq: event.seq, startTime: event.time }

    case 'assistant/live-chunk': {
      const next = state ?? newState(event.data.turn, event.data.step)
      const chunk = event.data.chunk
      if (chunk.type === 'usage') {
        return { ...next, usage: chunk.usage }
      }
      if (next.firstTokenTime === null && isTokenDelta(chunk)) {
        return { ...next, firstTokenTime: event.time }
      }
      return next
    }

    case 'assistant/attempt':
    case 'assistant/message': {
      let next = state ?? newState(event.data.turn, event.data.step)
      if (next.firstTokenTime === null) {
        const fromStream = assistantStreamFirstTokenTime(event.data.stream)
        if (isNumber(fromStream)) next = { ...next, firstTokenTime: fromStream }
      }
      if (event.type === 'assistant/attempt') return next
      const answer = answerOf(event.data.message)
      return {
        ...next,
        messageTime: next.messageTime ?? event.time,
        usage: event.data.usage ?? next.usage,
        interrupted: event.data.interrupted === true,
        ...answer === null
          ? {}
          : { answer: answer.preview, answerBody: answer.body, answerTruncated: answer.truncated },
      }
    }

    case 'tool/call': {
      const next = state ?? newState(event.data.turn, event.data.step)
      const callId = event.data.callId
      const pending: Record<string, number> = { ...(next.pending ?? {}) }
      const known = Object.hasOwn(pending, callId)
      pending[callId] = event.time
      const name = event.data.name
      const calls: Record<string, StatsCall> = { ...(next.calls ?? {}) }
      if (!Object.hasOwn(calls, callId)) {
        calls[callId] = {
          callId,
          seq: event.seq,
          name,
          ...callArguments(name, event.data.arguments),
          chars: null,
          lines: null,
          error: false,
          inner: false,
          text: null,
          truncated: false,
          ms: null,
          startedAt: event.time,
          endedAt: null,
        }
      }
      return {
        ...next,
        pending,
        toolOpen: known ? next.toolOpen : next.toolOpen + 1,
        tools: bumpTool(next.tools, name),
        calls,
      }
    }

    case 'llm/retry':
      return { ...(state ?? newState(event.data.turn, event.data.step)), retries: (state?.retries ?? 0) + 1 }

    /**
     * Inner Code-Mode call: the name and arguments are the real tool's, the
     * content is the real result. It does not count toward the outer call's
     * tool time; its own dispatch span is measured instead.
     */
    case 'tool/ptc-dispatch-start': {
      if (state === undefined) return state
      const subCallId = event.data.subCallId
      return { ...state, starts: { ...(state.starts ?? {}), [subCallId]: event.time } }
    }

    case 'tool/ptc-dispatch': {
      const next = state
      if (next === undefined) return next
      const name = event.data.name
      const info = resultInfo(event.data.content)
      const callKey = event.data.subCallId
      const startedAt = ownValue(next.starts, callKey)
      const calls: Record<string, StatsCall> = { ...(next.calls ?? {}) }
      calls[callKey] = {
        callId: callKey,
        seq: event.seq,
        name,
        ...callArguments(name, event.data.arguments),
        chars: info.chars,
        lines: info.lines,
        text: info.text,
        truncated: info.truncated,
        error: event.data.isError,
        inner: true,
        ms: isNumber(startedAt) ? Math.max(0, event.time - startedAt) : null,
        startedAt: isNumber(startedAt) ? startedAt : null,
        endedAt: event.time,
      }
      return {
        ...next,
        calls,
        tools: bumpTool(next.tools, name),
        toolErrors: event.data.isError ? next.toolErrors + 1 : next.toolErrors,
      }
    }

    case 'tool/result': {
      const next = state ?? newState(event.data.turn, event.data.step)
      const message = event.data.message
      const callId: string = message.source.callId
      const failed = message.isError === true
      const before = ownValue(next.calls, callId)
      const calls: Record<string, StatsCall> = { ...(next.calls ?? {}) }
      if (before !== undefined) {
        calls[callId] = {
          ...before,
          ...resultInfo(message.content),
          error: failed || before.error,
          /* v8 ignore next -- a native call record always carries the start time tool/call recorded. */
          ms: isNumber(before.startedAt) ? Math.max(0, event.time - before.startedAt) : before.ms,
          endedAt: event.time,
        }
      }
      const withError = failed ? { ...next, toolErrors: next.toolErrors + 1 } : next
      const dispatched = ownValue(next.pending, callId)
      if (!isNumber(dispatched)) {
        return { ...withError, calls, toolMissing: next.toolMissing + 1 }
      }
      const pending: Record<string, number> = {}
      /* v8 ignore next -- a numeric pending start implies pending exists; the empty fallback is unreachable. */
      for (const [key, value] of Object.entries(next.pending ?? {})) {
        if (key !== callId) pending[key] = value
      }
      return {
        ...withError,
        calls,
        pending,
        toolOpen: Math.max(0, next.toolOpen - 1),
        toolPairs: next.toolPairs + 1,
        toolMs: next.toolMs + Math.max(0, event.time - dispatched),
      }
    }

    case 'step/end':
      return { ...(state ?? newState(event.data.turn, event.data.step)), ended: true, endTime: event.time }

    default:
      return state
  }
}

/** Calls of one step in call order, bounded per call and per step. */
function callList(calls: Readonly<Record<string, StatsCall>> | null): StatsCall[] {
  if (calls === null) return []
  const list = Object.values(calls)
    .sort((left, right) => left.seq - right.seq)
    .slice(0, CALL_LIMIT)
  let used = 0
  return list.map((call) => {
    const size = call.text === null ? 0 : call.text.length
    if (size === 0) return call
    if (used + size <= STEP_TEXT_BUDGET) {
      used += size
      return call
    }
    return { ...call, text: null, truncated: true }
  })
}

/** Tool tallies by descending count; ties keep first-call order. */
function sortedTools(tools: Readonly<Record<string, number>> | null): StatsToolCount[] {
  if (tools === null) return []
  return Object.entries(tools)
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
}

/**
 * Wall span covered by calls that both started and settled; overlaps count once.
 * @param calls - calls with their paired start and end times.
 * @returns the span in milliseconds, or null when no call is paired.
 */
export function toolSpanUnion(calls: readonly StatsCall[]): number | null {
  const intervals = calls
    .filter((call): call is StatsCall & { startedAt: number; endedAt: number } =>
      isNumber(call.startedAt) && isNumber(call.endedAt))
    .map(call => [call.startedAt, call.endedAt] as const)
    .sort((left, right) => left[0] - right[0])
  if (intervals.length === 0) return null
  let total = 0
  let [start, end] = intervals[0] as readonly [number, number]
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart > end) {
      total += end - start
      start = nextStart
      end = nextEnd
    } else if (nextEnd > end) {
      end = nextEnd
    }
  }
  return total + end - start
}

/** Tool result characters one step pushed into the next prompt. */
function outputChars(calls: readonly StatsCall[]): number {
  let total = 0
  for (const call of calls) {
    if (isNumber(call.chars)) total += call.chars
  }
  return total
}

/**
 * Measured metrics of one step.
 * @param state - folded step state.
 * @returns the row values the table renders.
 */
export function stepMetrics(state: StatsStepState): StatsStepMetrics {
  const start = state.startTime
  const first = state.firstTokenTime
  const message = state.messageTime
  const context = contextTokens(state.usage)
  const output = outputTokens(state.usage)
  const ttft = isNumber(start) && isNumber(first) ? Math.max(0, first - start) : null
  const model = isNumber(start) && isNumber(message) ? Math.max(0, message - start) : null
  const decode = isNumber(first) && isNumber(message) ? Math.max(0, message - first) : null
  const tps = isNumber(decode) && decode > 0 && isNumber(output) && output > 0
    ? output / (decode / 1000)
    : null
  const settled = isNumber(message)
  const calls = callList(state.calls)
  // The union spans every paired call, not just the row's displayed prefix.
  const allCalls = state.calls === null ? [] : Object.values(state.calls)
  return {
    turn: state.turn,
    step: state.step,
    startTime: isNumber(start) ? start : null,
    endTime: isNumber(state.endTime) ? state.endTime : null,
    context,
    ttft,
    model,
    decode,
    tps,
    output,
    tool: state.toolPairs > 0 ? state.toolMs : null,
    toolWall: toolSpanUnion(allCalls),
    tools: sortedTools(state.tools),
    calls,
    toolOutput: outputChars(calls),
    retries: state.retries,
    toolErrors: state.toolErrors,
    answer: state.answer,
    answerBody: state.answerBody,
    answerTruncated: state.answerTruncated,
    cacheRead: cacheReadTokens(state.usage),
    cacheWrite: cacheWriteTokens(state.usage),
    cacheHit: cacheHitRate(state.usage),
    wall: isNumber(start) && isNumber(state.endTime) ? Math.max(0, state.endTime - start) : null,
    toolPending: state.toolOpen + state.toolMissing,
    running: !state.ended,
    interrupted: state.interrupted,
    aborted: state.ended && !settled,
    mark: state.mark,
    prompt: state.prompt,
    images: state.images,
    closed: state.closed,
    closeKind: state.closeKind,
  }
}

/**
 * State rebuilt from the matches a window still holds when its state is absent.
 * Event order is preserved, so `step/start` and `step/end` restore the
 * boundaries whenever they survived.
 * @param matches - accepted matches in ascending sequence order.
 * @returns the folded state, or undefined when nothing was foldable.
 */
export function fallbackState(
  matches: readonly { readonly event: SessionEventLike }[],
): StatsStepState | undefined {
  let state: StatsStepState | undefined
  for (const match of matches) state = foldEvent(state, match.event)
  return state
}
