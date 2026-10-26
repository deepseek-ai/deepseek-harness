declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': { readonly kind: 'team-message'; readonly senderName: string }
    'agent-message': { readonly kind: 'agent-message' }
  }
}

import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  LlmAttemptId,
  MessageId,
  ToolCallId,
  type AssistantMessage,
  type AssistantStreamRecord,
  type ContentBlock,
  type ImageBlock,
  type StreamChunk,
  type TokenUsage,
  type ToolResultMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { SessionSeq, type SessionEventMap, type SessionEventType } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import {
  CALL_LIMIT, fallbackState, foldEvent, isCodeMode, newState, promptOf, stepMetrics, toolSpanUnion, triggerSenderOf,
} from '../src/client/stats-fold.ts'
import {
  DASH, barShare, formatChars, formatClock, formatDateTime, formatDateTimeMs, formatDateTimeShort,
  formatMs, formatPercent, formatStepClock,
  formatTokens, formatTokensDelta, formatTokensShort, formatTps,
} from '../src/client/stats-format.ts'
import type { StatsCall, StatsStepMetrics, StatsStepState } from '../src/client/stats-contract.ts'
import {
  cacheHitRate, cacheReadTokens, cacheWriteTokens, contextTokens, isNumber, outputTokens,
} from '../src/client/stats-usage.ts'

let seq = 0
let clock = 0

/** One event envelope; fixtures that need an exact time pass it. */
function emit(type: SessionEventType, data: object, time?: number): SessionEventLike {
  seq += 1
  clock = time ?? clock + 10
  return { type, seq: SessionSeq(seq), time: clock, data } as SessionEventLike
}

/** One durable event whose payload the current Session event map describes. */
function event<K extends SessionEventType>(
  type: K,
  data: SessionEventMap[K],
  time?: number,
): SessionEventLike {
  return emit(type, data, time)
}

/** One client-only live chunk event. */
function liveChunk(turn: number, step: number, chunk: StreamChunk, time?: number): SessionEventLike {
  seq += 1
  clock = time ?? clock + 10
  return {
    type: 'assistant/live-chunk',
    seq,
    time: clock,
    data: { attemptId: LlmAttemptId('attempt-1'), turn, step, chunk },
  }
}

/** Narrow a folded state the fixture guarantees exists. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a folded value')
  return value
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function imageBlock(attachmentId = 'sha256:fixture'): ImageBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(attachmentId),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    },
  }
}

function userMessage(
  content: readonly ContentBlock[],
  source: UserMessage['source'] = { kind: 'user' },
): UserMessage {
  return { role: 'user', id: MessageId('user-1'), content, source }
}

function assistantMessage(content: readonly ContentBlock[] = []): AssistantMessage {
  return {
    role: 'assistant',
    id: MessageId('assistant-1'),
    content,
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  }
}

function toolMessage(
  callId: string,
  content: readonly ContentBlock[],
  isError = false,
): ToolResultMessage {
  return {
    role: 'tool',
    id: MessageId(`tool-${callId}`),
    content,
    source: { kind: 'tool', callId: ToolCallId(callId) },
    toolCallId: ToolCallId(callId),
    isError,
  }
}

function stepStart(turn: number, step: number, time: number): SessionEventLike {
  return event('step/start', { turn, step }, time)
}

function stepEnd(turn: number, step: number, time: number): SessionEventLike {
  return event('step/end', { turn, step }, time)
}

function toolCall(
  turn: number,
  step: number,
  callId: string,
  name: string,
  args: string,
  time: number,
): SessionEventLike {
  return event('tool/call', {
    turn, step, callId: ToolCallId(callId), name, arguments: args,
  }, time)
}

function toolResult(
  turn: number,
  step: number,
  callId: string,
  content: readonly ContentBlock[],
  time: number,
  isError = false,
): SessionEventLike {
  return event('tool/result', {
    turn, step, message: toolMessage(callId, content, isError),
  }, time)
}

function retry(turn: number, step: number, time: number): SessionEventLike {
  return event('llm/retry', {
    turn,
    step,
    retryId: RetryId('retry-1'),
    provider: 'deepseek',
    mode: 'normal',
    policyKey: 'default',
    retry: 1,
    maxRetries: 3,
    delayMs: 10,
    failure: { message: 'rate limited', code: 'RATE_LIMITED' },
  }, time)
}

function ptcStart(root: string, sub: string, name: string, args: unknown, time: number): SessionEventLike {
  return event('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId(root),
    parentCallId: ToolCallId(root),
    subCallId: ToolCallId(sub),
    name,
    arguments: args,
  }, time)
}

function ptcDispatch(
  root: string,
  sub: string,
  name: string,
  args: unknown,
  content: ContentBlock[],
  time: number,
  isError = false,
): SessionEventLike {
  return event('tool/ptc-dispatch', {
    rootCallId: ToolCallId(root),
    parentCallId: ToolCallId(root),
    subCallId: ToolCallId(sub),
    name,
    arguments: args,
    isError,
    content,
  }, time)
}

function streamAt(firstTokenAt: number): AssistantStreamRecord[] {
  return [
    { type: 'chunk', time: firstTokenAt - 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', time: firstTokenAt, chunk: { type: 'text-delta', index: 0, text: 'x' } },
  ]
}

/** Fold a whole event list, asserting that it produced a state. */
function folded(events: readonly SessionEventLike[]): StatsStepState {
  let state: StatsStepState | undefined
  for (const item of events) state = foldEvent(state, item)
  return defined(state)
}

/** One step carrying a single recorded tool call. */
function callState(name: string, args: string): StatsStepState {
  let state = foldEvent(undefined, stepStart(1, 1, 1_000))
  state = foldEvent(state, toolCall(1, 1, 'call-1', name, args, 1_010))
  return defined(state)
}

function callMetrics(name: string, args: string): StatsStepMetrics {
  return stepMetrics(callState(name, args))
}

function listedCall(metrics: StatsStepMetrics, at = 0): StatsCall {
  const call = metrics.calls[at]
  if (call === undefined) throw new Error('expected a listed call')
  return call
}

function recordedCall(state: StatsStepState, callId: string): StatsCall {
  const call = state.calls?.[callId]
  if (call === undefined) throw new Error(`expected call ${callId}`)
  return call
}

function stateOf(overrides: Partial<StatsStepState> = {}): StatsStepState {
  return { ...newState(1, 1), ...overrides }
}

function statsCall(callId: string, seqAt: number, overrides: Partial<StatsCall> = {}): StatsCall {
  return {
    callId,
    seq: seqAt,
    name: 'read',
    hint: null,
    chars: null,
    lines: null,
    error: false,
    added: null,
    removed: null,
    before: null,
    after: null,
    args: null,
    inner: false,
    text: null,
    truncated: false,
    ms: null,
    startedAt: null,
    endedAt: null,
    ...overrides,
  }
}

function callsRecord(calls: readonly StatsCall[]): Record<string, StatsCall> {
  return Object.fromEntries(calls.map(call => [call.callId, call]))
}

/** Lines joined by newlines, for edit and write fixtures. */
function linesOf(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join('\n')
}

const usage: TokenUsage = {
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
}

beforeEach(() => {
  seq = 0
  clock = 0
})

describe('display formatting boundaries', () => {
  it('renders durations at every scale boundary and rejects unrecorded values', () => {
    expect(formatMs(null)).toBe(DASH)
    expect(formatMs(Number.NaN)).toBe(DASH)
    expect(formatMs(Number.POSITIVE_INFINITY)).toBe(DASH)
    expect(formatMs(0)).toBe('0 ms')
    expect(formatMs(999.6)).toBe('1000 ms')
    expect(formatMs(1_000)).toBe('1.00 s')
    expect(formatMs(59_999)).toBe('60.00 s')
    expect(formatMs(60_000)).toBe('1.0 min')
    expect(formatMs(125_000)).toBe('2.1 min')
  })

  it('groups token digits and prints K scales below and above one thousand', () => {
    expect(formatTokens(null)).toBe(DASH)
    expect(formatTokens(Number.NaN)).toBe(DASH)
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(1234.6)).toBe('1,235')
    expect(formatTokensShort(null)).toBe(DASH)
    expect(formatTokensShort(0)).toBe('0.00K')
    expect(formatTokensShort(30)).toBe('0.03K')
    expect(formatTokensShort(1_500)).toBe('1.5K')
    expect(formatTokensDelta(null)).toBe('')
    expect(formatTokensDelta(0)).toBe('+0.00K')
    expect(formatTokensDelta(250)).toBe('+0.25K')
    expect(formatTokensDelta(-1_500)).toBe('−1.5K')
  })

  it('formats characters, speed, and percentage values', () => {
    expect(formatChars(null)).toBe(DASH)
    expect(formatChars(Number.NaN)).toBe(DASH)
    expect(formatChars(0)).toBe(DASH)
    expect(formatChars(-3)).toBe(DASH)
    expect(formatChars(12)).toBe('12')
    expect(formatChars(999.6)).toBe('1000')
    expect(formatChars(1_000)).toBe('1.0K')
    expect(formatChars(1_234)).toBe('1.2K')
    expect(formatTps(null)).toBe(DASH)
    expect(formatTps(Number.NaN)).toBe(DASH)
    expect(formatTps(0)).toBe('0.0 tok/s')
    expect(formatTps(268.94)).toBe('268.9 tok/s')
    expect(formatTokensShort(9_999_999)).toBe('10000.0K')
    expect(formatTokensShort(10_000_000)).toBe('10.0M')
    expect(formatTokensShort(65_300_000)).toBe('65.3M')
    expect(formatPercent(null)).toBe(DASH)
    expect(formatPercent(0)).toBe('0.00%')
    expect(formatPercent(0.962)).toBe('96.20%')
    expect(formatPercent(1)).toBe('100.00%')
  })

  it('renders one local instant as a clock and as a timestamp', () => {
    const time = new Date(2026, 9, 20, 3, 4, 5).getTime()
    expect(formatClock(time)).toBe('03:04:05')
    expect(formatDateTime(time)).toBe('2026-10-20 03:04:05')
    expect(formatDateTimeShort(time)).toBe('10-20 03:04')
    expect(formatDateTimeMs(time)).toBe('2026-10-20 03:04:05.000')
    expect(formatStepClock(time)).toBe('10-20 03:04:05.000')
    expect(formatClock(null)).toBe(DASH)
    expect(formatClock(Number.NaN)).toBe(DASH)
    expect(formatDateTime(null)).toBe(DASH)
    expect(formatDateTime(Number.POSITIVE_INFINITY)).toBe(DASH)
    expect(formatDateTimeShort(Number.NaN)).toBe(DASH)
    expect(formatDateTimeMs(null)).toBe(DASH)
    expect(formatStepClock(Number.POSITIVE_INFINITY)).toBe(DASH)
  })

  it('scales a bar by the square root of its comparison group', () => {
    expect(barShare(10, Number.NaN)).toBe(1)
    expect(barShare(10, 0)).toBe(1)
    expect(barShare(10, -5)).toBe(1)
    expect(barShare(0, 100)).toBe(0)
    expect(barShare(-5, 100)).toBe(0)
    expect(barShare(25, 100)).toBe(0.5)
    expect(barShare(100, 100)).toBe(1)
    expect(barShare(200, 100)).toBe(1)
  })
})

describe('token accounting helpers', () => {
  it('accepts only finite numeric measurements', () => {
    expect(isNumber(0)).toBe(true)
    expect(isNumber(Number.NaN)).toBe(false)
    expect(isNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isNumber('1')).toBe(false)
  })

  it('sums disjoint prompt counts with absent fields counting as zero', () => {
    expect(contextTokens(usage)).toBe(600)
    expect(contextTokens(null)).toBeNull()
    expect(contextTokens({ cacheReadTokens: 5 })).toBe(5)
    expect(contextTokens({ cacheWriteTokens: 7 })).toBe(7)
    expect(contextTokens({ inputTokens: 3 })).toBe(3)
    expect(contextTokens({ outputTokens: 9 })).toBe(0)
    expect(contextTokens({})).toBeNull()
  })

  it('reports each optional count only when the usage carries it', () => {
    expect(outputTokens(usage)).toBe(40)
    expect(outputTokens(null)).toBeNull()
    expect(outputTokens({ inputTokens: 3 })).toBeNull()
    expect(cacheReadTokens(usage)).toBe(400)
    expect(cacheReadTokens(null)).toBeNull()
    expect(cacheReadTokens({ inputTokens: 3 })).toBeNull()
    expect(cacheWriteTokens(usage)).toBe(100)
    expect(cacheWriteTokens(null)).toBeNull()
    expect(cacheWriteTokens({ outputTokens: 3 })).toBeNull()
  })

  it('derives the cache hit share of the prompt and requires a readable prompt', () => {
    expect(cacheHitRate(usage)).toBeCloseTo(400 / 600)
    expect(cacheHitRate(null)).toBeNull()
    expect(cacheHitRate({ inputTokens: 10 })).toBeNull()
    expect(cacheHitRate({ outputTokens: 5 })).toBeNull()
    expect(cacheHitRate({ cacheReadTokens: 100, cacheWriteTokens: 50 })).toBeCloseTo(2 / 3)
    expect(cacheHitRate({ cacheReadTokens: 10 })).toBe(1)
  })
})

describe('tool call hints', () => {
  it('hints at the target for every tool family', () => {
    const cases: readonly { name: string; args: string; hint: string | null }[] = [
      { name: 'read', args: '{"file_path":"/a/b/c.ts"}', hint: 'b/c.ts' },
      { name: 'read', args: '{"path":"src/index.ts"}', hint: 'src/index.ts' },
      { name: 'read', args: '{"file":"deep/nested/dir/thing.ts"}', hint: 'dir/thing.ts' },
      { name: 'read', args: '{"file_path":"C:\\\\work\\\\deep\\\\x.ts"}', hint: 'deep/x.ts' },
      { name: 'read', args: '{"file_path":"/single.ts"}', hint: '/single.ts' },
      { name: 'read', args: '{"file_path":"/"}', hint: '/' },
      { name: 'read', args: '{"file_path":"   "}', hint: null },
      { name: 'read', args: '{"file_path":5}', hint: null },
      { name: 'read', args: '{}', hint: null },
      { name: 'write', args: '{"file_path":"/a/b/c.ts"}', hint: 'b/c.ts' },
      { name: 'edit', args: '{"file_path":"/a/b/c.ts"}', hint: 'b/c.ts' },
      { name: 'grep', args: '{"pattern":"TODO"}', hint: 'TODO' },
      { name: 'grep', args: '{"pattern":"TODO","include":"*.ts"}', hint: 'TODO (*.ts)' },
      { name: 'grep', args: '{"include":"*.ts"}', hint: null },
      { name: 'glob', args: '{"pattern":"*.md"}', hint: '*.md' },
      { name: 'shell', args: '{"description":"Run tests"}', hint: 'Run tests' },
      { name: 'shell', args: '{"command":"npm test\\necho more"}', hint: 'npm test' },
      { name: 'shell', args: '{}', hint: null },
      { name: 'pwsh', args: '{"description":"List files"}', hint: 'List files' },
      { name: 'bash', args: '{"command":"ls -la"}', hint: 'ls -la' },
      { name: 'web_fetch', args: '{"url":"https://example.com/a/b"}', hint: 'example.com/a/b' },
      { name: 'web_fetch', args: '{"url":"http://example.com/x"}', hint: 'example.com/x' },
      { name: 'web_fetch', args: '{}', hint: null },
      { name: 'web_search', args: '{"query":"search terms"}', hint: 'search terms' },
      { name: 'web_search', args: '{}', hint: null },
      { name: 'run_code', args: '{"description":"list files"}', hint: 'list files' },
      { name: 'RunCode', args: '{"description":"list files"}', hint: 'list files' },
      { name: 'runCode', args: '{"description":"list files"}', hint: 'list files' },
      { name: 'run_code', args: '{}', hint: null },
      { name: 'custom', args: '{"description":"described"}', hint: 'described' },
      { name: 'custom', args: '{"query":"queried"}', hint: 'queried' },
      { name: 'custom', args: '{"path":"pathed"}', hint: 'pathed' },
      { name: 'custom', args: '{"file_path":"filed"}', hint: 'filed' },
      { name: 'custom', args: '{"provider":"provided"}', hint: 'provided' },
      { name: 'custom', args: '{"method":"called"}', hint: 'called' },
      { name: 'custom', args: '{"name":"named"}', hint: 'named' },
      { name: 'custom', args: '{"description":7,"query":"second key"}', hint: 'second key' },
      { name: 'custom', args: '{"description":"   "}', hint: null },
      { name: 'custom', args: '{}', hint: null },
    ]
    for (const item of cases) {
      expect(listedCall(callMetrics(item.name, item.args)).hint, `${item.name} ${item.args}`).toBe(item.hint)
    }
  })

  it('clips long hints to the column budget', () => {
    const path = listedCall(callMetrics('read', JSON.stringify({ file_path: 'x'.repeat(40) })))
    expect(path.hint).toHaveLength(34)
    expect(path.hint?.endsWith('…')).toBe(true)
    const description = listedCall(callMetrics('shell', JSON.stringify({ description: 'd'.repeat(40) })))
    expect(description.hint).toHaveLength(30)
    const url = listedCall(callMetrics('web_fetch', JSON.stringify({ url: `https://${'u'.repeat(50)}` })))
    expect(url.hint).toHaveLength(34)
    const query = listedCall(callMetrics('web_search', JSON.stringify({ query: 'q'.repeat(40) })))
    expect(query.hint).toHaveLength(30)
  })

  it('leaves the hint empty when the arguments are not a field map', () => {
    for (const args of ['{oops', 'null', '[]', '"text"', '42', '']) {
      const call = listedCall(callMetrics('read', args))
      expect(call.hint, args).toBeNull()
      expect(call.args, args).toBe(args === '' ? null : args)
    }
  })
})

describe('tool call arguments and text bounds', () => {
  it('keeps raw arguments for the inspector', () => {
    expect(listedCall(callMetrics('read', '{"file_path":"/a/b"}')).args).toBe('{"file_path":"/a/b"}')
    expect(listedCall(callMetrics('read', '')).args).toBeNull()
    const long = JSON.stringify({ file_path: '/a/b/c.ts', padding: 'x'.repeat(2_500) })
    const clipped = listedCall(callMetrics('read', long))
    expect(clipped.args).toHaveLength(2_000)
    expect(clipped.hint).toBe('b/c.ts')
  })

  it('records an edit delta and the bounded bodies', () => {
    const edit = listedCall(callMetrics('edit', JSON.stringify({
      old_string: 'a\nb\nc',
      new_string: 'a\nc\nd',
    })))
    expect(edit.added).toBe(1)
    expect(edit.removed).toBe(1)
    expect(edit.before).toBe('a\nb\nc')
    expect(edit.after).toBe('a\nc\nd')
    const swapped = listedCall(callMetrics('edit', JSON.stringify({
      old_str: 'one', new_str: 'one',
    })))
    expect(swapped.added).toBe(0)
    expect(swapped.removed).toBe(0)
    const legacy = listedCall(callMetrics('apply_patch', JSON.stringify({ old: 'x', new: 'x\ny' })))
    expect(legacy.added).toBe(1)
    expect(legacy.removed).toBe(0)
  })

  it('counts added and removed lines for one-sided edits', () => {
    const removed = listedCall(callMetrics('edit', JSON.stringify({ old_string: 'one\ntwo' })))
    expect(removed.added).toBe(0)
    expect(removed.removed).toBe(2)
    expect(removed.before).toBe('one\ntwo')
    expect(removed.after).toBeNull()
    const added = listedCall(callMetrics('edit', JSON.stringify({ new_string: 'one\ntwo' })))
    expect(added.added).toBe(2)
    expect(added.removed).toBe(0)
    expect(added.before).toBeNull()
    expect(added.after).toBe('one\ntwo')
    const empty = listedCall(callMetrics('edit', JSON.stringify({ old_string: '', new_string: '' })))
    expect(empty.added).toBe(0)
    expect(empty.removed).toBe(0)
    expect(empty.before).toBeNull()
    expect(empty.after).toBeNull()
    const unnamed = listedCall(callMetrics('edit', JSON.stringify({ file_path: '/a/b' })))
    expect(unnamed.added).toBeNull()
    expect(unnamed.removed).toBeNull()
  })

  it('counts write content lines and bounds the kept body', () => {
    const write = listedCall(callMetrics('write', JSON.stringify({ content: 'a\nb\n' })))
    expect(write.added).toBe(2)
    expect(write.removed).toBe(0)
    expect(write.before).toBeNull()
    expect(write.after).toBe('a\nb\n')
    const empty = listedCall(callMetrics('write', JSON.stringify({ content: '' })))
    expect(empty.added).toBe(0)
    expect(empty.after).toBeNull()
    const text = listedCall(callMetrics('write', JSON.stringify({ text: 'x' })))
    expect(text.added).toBe(1)
    const fileText = listedCall(callMetrics('write', JSON.stringify({ file_text: 'x\ny' })))
    expect(fileText.added).toBe(2)
    const long = listedCall(callMetrics('write', JSON.stringify({ content: 'c'.repeat(9_000) })))
    expect(long.after).toHaveLength(8_000)
    expect(long.added).toBe(1)
    const numeric = listedCall(callMetrics('write', JSON.stringify({ content: 5, text: 'fallback' })))
    expect(numeric.added).toBe(1)
    const missing = listedCall(callMetrics('write', JSON.stringify({ file_path: '/a/b' })))
    expect(missing.added).toBeNull()
    expect(missing.before).toBeNull()
    expect(missing.after).toBeNull()
    const unparseable = listedCall(callMetrics('edit', '{oops'))
    expect(unparseable.added).toBeNull()
    expect(unparseable.removed).toBeNull()
  })

  it('treats edits past four hundred lines as a coarse delta', () => {
    const long = listedCall(callMetrics('edit', JSON.stringify({
      old_string: linesOf(401),
      new_string: 'one\ntwo',
    })))
    expect(long.added).toBe(0)
    expect(long.removed).toBe(399)
    const grown = listedCall(callMetrics('edit', JSON.stringify({
      old_string: 'one\ntwo',
      new_string: linesOf(401),
    })))
    expect(grown.added).toBe(399)
    expect(grown.removed).toBe(0)
  })
})

describe('assistant timeline and usage', () => {
  it('stamps the first visible live token and ignores empty or non-token chunks', () => {
    const start = defined(foldEvent(undefined, stepStart(2, 1, 1_000)))
    const empty = defined(foldEvent(start, liveChunk(2, 1, { type: 'text-delta', index: 0, text: '' }, 1_010)))
    expect(empty.firstTokenTime).toBeNull()
    const spaced = defined(foldEvent(empty, liveChunk(2, 1, { type: 'text-delta', index: 0, text: 'x' }, 1_020)))
    expect(spaced.firstTokenTime).toBe(1_020)
    const reasoning = defined(foldEvent(start, liveChunk(2, 1, { type: 'reasoning-delta', index: 0, text: 'why' }, 1_030)))
    expect(reasoning.firstTokenTime).toBe(1_030)
    const silentReasoning = defined(foldEvent(start, liveChunk(2, 1, {
      type: 'reasoning-delta', index: 0, text: '',
    }, 1_040)))
    expect(silentReasoning.firstTokenTime).toBeNull()
    const late = defined(foldEvent(spaced, liveChunk(2, 1, { type: 'text-delta', index: 0, text: 'y' }, 1_050)))
    expect(late.firstTokenTime).toBe(1_020)
  })

  it('treats tool-call deltas as tokens only when they carry content', () => {
    const start = defined(foldEvent(undefined, stepStart(2, 1, 1_000)))
    const empty = defined(foldEvent(start, liveChunk(2, 1, {
      type: 'tool-call-delta', index: 0, id: ToolCallId('c'), argumentsDelta: '',
    }, 1_010)))
    expect(empty.firstTokenTime).toBeNull()
    const args = defined(foldEvent(start, liveChunk(2, 1, {
      type: 'tool-call-delta', index: 0, id: ToolCallId('c'), argumentsDelta: '{"a":1}',
    }, 1_020)))
    expect(args.firstTokenTime).toBe(1_020)
    const named = defined(foldEvent(start, liveChunk(2, 1, {
      type: 'tool-call-delta', index: 0, id: ToolCallId('c'), name: 'read', argumentsDelta: '',
    }, 1_030)))
    expect(named.firstTokenTime).toBe(1_030)
    const blockStart = defined(foldEvent(start, liveChunk(2, 1, {
      type: 'block-start', index: 0, blockType: 'text',
    }, 1_040)))
    expect(blockStart.firstTokenTime).toBeNull()
  })

  it('adopts the usage a live chunk carries', () => {
    const start = defined(foldEvent(undefined, stepStart(2, 1, 1_000)))
    const adopted = defined(foldEvent(start, liveChunk(2, 1, { type: 'usage', usage }, 1_010)))
    expect(adopted.usage).toEqual(usage)
    const replaced = defined(foldEvent(adopted, liveChunk(2, 1, {
      type: 'usage', usage: { inputTokens: 5, outputTokens: 6 },
    }, 1_020)))
    expect(replaced.usage).toEqual({ inputTokens: 5, outputTokens: 6 })
  })

  it('starts a live window without a step boundary', () => {
    const state = defined(foldEvent(undefined, liveChunk(4, 2, { type: 'text-delta', index: 0, text: 'x' }, 2_000)))
    expect(state.turn).toBe(4)
    expect(state.step).toBe(2)
    expect(state.firstTokenTime).toBe(2_000)
    expect(state.startTime).toBeNull()
  })

  it('derives the first token from a durable attempt stream', () => {
    const attempt = defined(foldEvent(undefined, event('assistant/attempt', {
      turn: 2, step: 1, stream: streamAt(1_300),
    }, 1_500)))
    expect(attempt.firstTokenTime).toBe(1_300)
    expect(attempt.messageTime).toBeNull()
    const empty = defined(foldEvent(undefined, event('assistant/attempt', {
      turn: 2, step: 1, stream: [],
    }, 1_500)))
    expect(empty.firstTokenTime).toBeNull()
    const kept = defined(foldEvent(attempt, event('assistant/attempt', {
      turn: 2, step: 1, stream: streamAt(1_400),
    }, 1_600)))
    expect(kept.firstTokenTime).toBe(1_300)
  })

  it('records the settled message time, usage, and interruption', () => {
    const state = defined(foldEvent(undefined, event('assistant/message', {
      turn: 2,
      step: 1,
      message: assistantMessage([textBlock('done')]),
      stream: streamAt(1_300),
      usage,
      interrupted: true,
    }, 1_500)))
    expect(state.firstTokenTime).toBe(1_300)
    expect(state.messageTime).toBe(1_500)
    expect(state.usage).toEqual(usage)
    expect(state.interrupted).toBe(true)
    const repeated = defined(foldEvent(state, event('assistant/message', {
      turn: 2,
      step: 1,
      message: assistantMessage([textBlock('again')]),
      stream: [],
    }, 1_900)))
    expect(repeated.messageTime).toBe(1_500)
    expect(repeated.usage).toEqual(usage)
    expect(repeated.interrupted).toBe(false)
    const refreshed = defined(foldEvent(repeated, event('assistant/message', {
      turn: 2,
      step: 1,
      message: assistantMessage(),
      stream: [],
      usage: { inputTokens: 5, outputTokens: 6 },
    }, 2_100)))
    expect(refreshed.usage).toEqual({ inputTokens: 5, outputTokens: 6 })
  })

  it('keeps a trimmed answer preview and caps long text', () => {
    const first = defined(foldEvent(undefined, event('assistant/message', {
      turn: 2, step: 1, message: assistantMessage([textBlock('first line\nsecond line')]), stream: [],
    }, 1_500)))
    expect(first.answer).toBe('first line\nsecond line')
    expect(first.answerBody).toBe('first line\nsecond line')
    expect(first.answerTruncated).toBe(false)
    // Non-text blocks do not contribute, and a text-only whitespace message contributes nothing.
    const mixed = defined(foldEvent(first, event('assistant/message', {
      turn: 2, step: 1, message: assistantMessage([imageBlock(), textBlock('   ')]), stream: [],
    }, 1_600)))
    expect(mixed.answer).toBe('first line\nsecond line')
    const long = 'x'.repeat(20_001)
    const capped = defined(foldEvent(undefined, event('assistant/message', {
      turn: 3, step: 1, message: assistantMessage([textBlock(long)]), stream: [],
    }, 1_700)))
    expect(capped.answer).toHaveLength(400)
    expect(capped.answerBody).toHaveLength(16_000)
    expect(capped.answerTruncated).toBe(true)
  })

  it('leaves usage unset when the first message reports none', () => {
    const state = defined(foldEvent(undefined, event('assistant/message', {
      turn: 2, step: 1, message: assistantMessage(), stream: [],
    }, 1_500)))
    expect(state.usage).toBeNull()
    expect(state.firstTokenTime).toBeNull()
    expect(state.messageTime).toBe(1_500)
    expect(state.interrupted).toBe(false)
  })
})

describe('prompt helper', () => {
  it('joins typed text blocks and keeps every attached image in order', () => {
    const first = imageBlock()
    const second = imageBlock('sha256:second')
    const prompt = promptOf(userMessage([textBlock('explain'), textBlock('this'), first]))
    expect(prompt.text).toBe('explain this')
    expect(prompt.images).toEqual([first.attachment])
    const imageOnly = promptOf(userMessage([first, second]))
    expect(imageOnly.text).toBeNull()
    expect(imageOnly.images).toEqual([first.attachment, second.attachment])
  })

  it('clips long questions and drops blank text', () => {
    expect(promptOf(userMessage([textBlock('q'.repeat(500))])).text).toHaveLength(400)
    expect(promptOf(userMessage([textBlock('q'.repeat(500))])).text?.endsWith('…')).toBe(true)
    expect(promptOf(userMessage([textBlock('   ')])).text).toBeNull()
    expect(promptOf(userMessage([textBlock('  a\n b  ')])).text).toBe('a b')
  })
})

describe('trigger sender helper', () => {
  it('names the teammate that sent a framed message', () => {
    expect(triggerSenderOf(userMessage([imageBlock(), textBlock('Team message from hfai-deploy: update')], {
      kind: 'team-message', senderName: 'hfai-deploy',
    }))).toBe('hfai-deploy')
    expect(triggerSenderOf(userMessage([textBlock('Team message from  stack-rebase : go')], {
      kind: 'team-message', senderName: 'stack-rebase',
    }))).toBe('stack-rebase')
  })

  it('parses the agent id from a direct agent message', () => {
    expect(triggerSenderOf(userMessage([textBlock('Agent abc-123 sent a message: hi')], {
      kind: 'agent-message',
    }))).toBe('abc-123')
    // Raw session UUIDs are not member names.
    expect(triggerSenderOf(userMessage([textBlock('Agent 52224ac7-b02b-4d25-8c6e-123456789abc sent a message: hi')], {
      kind: 'agent-message',
    }))).toBeNull()
  })

  it('returns nothing without a framed sender', () => {
    expect(triggerSenderOf(userMessage([textBlock('Team message from hfai-deploy: x')], { kind: 'user' }))).toBeNull()
    expect(triggerSenderOf(userMessage([textBlock('hello')], { kind: 'agent-message' }))).toBeNull()
    expect(triggerSenderOf(userMessage([textBlock('Agent noverb')], { kind: 'agent-message' }))).toBeNull()
  })
})

describe('tool call folding', () => {
  it('records a call before any step boundary and tallies its tool', () => {
    const state = defined(foldEvent(undefined, toolCall(5, 2, 'c1', 'grep', '{"pattern":"x"}', 1_000)))
    expect(state.turn).toBe(5)
    expect(state.step).toBe(2)
    expect(state.tools).toEqual({ grep: 1 })
    expect(state.toolOpen).toBe(1)
  })

  it('counts distinct calls, keeps one call per id, and tallies each tool name', () => {
    let state = foldEvent(undefined, stepStart(1, 1, 1_000))
    state = foldEvent(state, toolCall(1, 1, 'c1', 'read', '{"file_path":"/a/b"}', 1_010))
    state = foldEvent(state, toolCall(1, 1, 'c1', 'grep', '{"pattern":"x"}', 1_020))
    state = foldEvent(state, toolCall(1, 1, 'c2', 'read', '{"file_path":"/a/c"}', 1_030))
    const foldedState = defined(state)
    expect(foldedState.toolOpen).toBe(2)
    expect(foldedState.pending).toEqual({ c1: 1_020, c2: 1_030 })
    expect(foldedState.tools).toEqual({ read: 2, grep: 1 })
    expect(recordedCall(foldedState, 'c1').name).toBe('read')
    expect(recordedCall(foldedState, 'c1').seq).toBe(2)
    expect(stepMetrics(foldedState).tools).toEqual([{ name: 'read', count: 2 }, { name: 'grep', count: 1 }])
  })

  it('marks the wall-clock start of a call and settles its end', () => {
    let state = foldEvent(undefined, stepStart(1, 1, 1_000))
    state = foldEvent(state, toolCall(1, 1, 'c1', 'read', '{}', 1_010))
    expect(recordedCall(defined(state), 'c1').startedAt).toBe(1_010)
    expect(recordedCall(defined(state), 'c1').endedAt).toBeNull()
    state = foldEvent(state, toolResult(1, 1, 'c1', [textBlock('x')], 1_210))
    expect(recordedCall(defined(state), 'c1').endedAt).toBe(1_210)
    expect(stepMetrics(defined(state)).toolWall).toBe(200)
  })
})

describe('tool result pairing', () => {
  it('pairs a result with its call and records size, text, and duration', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c1', 'read', '{"file_path":"/a/b"}', 1_010),
      toolResult(1, 1, 'c1', [textBlock('one\ntwo')], 1_210),
    ])
    const metrics = stepMetrics(state)
    expect(state.toolPairs).toBe(1)
    expect(state.toolOpen).toBe(0)
    expect(metrics.toolPending).toBe(0)
    expect(metrics.tool).toBe(200)
    const call = recordedCall(state, 'c1')
    expect(call.chars).toBe(7)
    expect(call.lines).toBe(2)
    expect(call.text).toBe('one\ntwo')
    expect(call.truncated).toBe(false)
    expect(call.error).toBe(false)
    // The paired intervals give the per-call duration the accordion renders.
    expect(call.ms).toBe(200)
    expect(call.endedAt).toBe(1_210)
  })

  it('joins text blocks and counts lines without a trailing empty line', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c1', 'read', '{}', 1_010),
      toolResult(1, 1, 'c1', [textBlock('one'), textBlock('two\n')], 1_110),
    ])
    const call = recordedCall(state, 'c1')
    expect(call.text).toBe('one\ntwo\n')
    expect(call.lines).toBe(2)
    expect(call.chars).toBe(8)
  })

  it('records an empty text block as no text but one line', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c1', 'read', '{}', 1_010),
      toolResult(1, 1, 'c1', [textBlock('')], 1_110),
    ])
    const call = recordedCall(state, 'c1')
    expect(call.chars).toBe(0)
    expect(call.lines).toBe(1)
    expect(call.text).toBeNull()
  })

  it('bounds long result text and flags the truncation', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c1', 'read', '{}', 1_010),
      toolResult(1, 1, 'c1', [textBlock('x'.repeat(16_001))], 1_110),
    ])
    const call = recordedCall(state, 'c1')
    expect(call.chars).toBe(16_001)
    expect(call.text).toHaveLength(16_000)
    expect(call.truncated).toBe(true)
    const exact = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c2', 'read', '{}', 1_010),
      toolResult(1, 1, 'c2', [textBlock('y'.repeat(16_000))], 1_110),
    ])
    expect(recordedCall(exact, 'c2').truncated).toBe(false)
  })

  it('reports a result with no text content as empty', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c1', 'read', '{}', 1_010),
      toolResult(1, 1, 'c1', [], 1_110),
    ])
    const call = recordedCall(state, 'c1')
    expect(call.chars).toBe(0)
    expect(call.lines).toBe(0)
    expect(call.text).toBeNull()
    expect(call.truncated).toBe(false)
  })

  it('ignores non-text content blocks in a tool result', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c1', 'read', '{}', 1_010),
      toolResult(1, 1, 'c1', [imageBlock(), textBlock('kept')], 1_110),
    ])
    const call = recordedCall(state, 'c1')
    expect(call.text).toBe('kept')
    expect(call.chars).toBe(4)
  })

  it('records a failed result and counts one tool error', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'c1', 'read', '{}', 1_010),
      toolResult(1, 1, 'c1', [textBlock('boom')], 1_110, true),
    ])
    expect(recordedCall(state, 'c1').error).toBe(true)
    expect(stepMetrics(state).toolErrors).toBe(1)
  })

  it('keeps an earlier error when a later result succeeds', () => {
    let state = foldEvent(undefined, stepStart(1, 1, 1_000))
    state = foldEvent(state, toolCall(1, 1, 'c1', 'read', '{}', 1_010))
    state = foldEvent(state, toolResult(1, 1, 'c1', [textBlock('boom')], 1_110, true))
    state = foldEvent(state, toolResult(1, 1, 'c1', [textBlock('ok')], 1_210))
    expect(recordedCall(defined(state), 'c1').error).toBe(true)
  })

  it('counts a result with no matching call as missing', () => {
    const state = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'known', 'read', '{}', 1_010),
      toolResult(1, 1, 'ghost', [textBlock('x')], 1_110),
    ])
    const metrics = stepMetrics(state)
    expect(state.toolMissing).toBe(1)
    expect(state.toolPairs).toBe(0)
    expect(metrics.toolPending).toBe(2)
  })

  it('never resolves an inherited property as a pending or recorded call', () => {
    const empty = folded([
      stepStart(1, 1, 1_000),
      toolResult(1, 1, 'constructor', [textBlock('x')], 1_110),
    ])
    expect(empty.toolMissing).toBe(1)
    expect(empty.toolPairs).toBe(0)
    const populated = folded([
      stepStart(1, 1, 1_000),
      toolCall(1, 1, 'known', 'read', '{}', 1_010),
      toolResult(1, 1, 'constructor', [textBlock('x')], 1_110),
    ])
    expect(populated.toolMissing).toBe(1)
    expect(populated.toolPairs).toBe(0)
    expect(recordedCall(populated, 'known').chars).toBeNull()
  })

  it('folds a result that arrives without an open step', () => {
    const state = defined(foldEvent(undefined, toolResult(1, 1, 'ghost', [textBlock('x')], 2_000)))
    expect(state.turn).toBe(1)
    expect(state.step).toBe(1)
    expect(state.toolMissing).toBe(1)
  })

  it('resolves pending calls one at a time and clamps a backwards duration', () => {
    let state = foldEvent(undefined, stepStart(1, 1, 1_000))
    state = foldEvent(state, toolCall(1, 1, 'c1', 'read', '{}', 2_000))
    state = foldEvent(state, toolCall(1, 1, 'c2', 'grep', '{}', 2_010))
    expect(defined(state).pending).toEqual({ c1: 2_000, c2: 2_010 })
    state = foldEvent(state, toolResult(1, 1, 'c1', [textBlock('one')], 1_500))
    expect(defined(state).pending).toEqual({ c2: 2_010 })
    expect(defined(state).toolPairs).toBe(1)
    expect(defined(state).toolMs).toBe(0)
    state = foldEvent(state, toolResult(1, 1, 'c2', [textBlock('two')], 2_110))
    expect(defined(state).pending).toEqual({})
    expect(defined(state).toolPairs).toBe(2)
    expect(defined(state).toolMs).toBe(100)
    expect(stepMetrics(defined(state)).toolPending).toBe(0)
  })
})

describe('Code-Mode dispatch', () => {
  /** One step with a settled `run_code` root call. */
  function codeStep(): StatsStepState {
    return folded([
      stepStart(2, 1, 5_000),
      toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
    ])
  }

  it('records an inner call with its dispatch duration and result', () => {
    let state = codeStep()
    state = defined(foldEvent(state, ptcStart('root', 'sub-1', 'grep', '{"pattern":"x"}', 5_020)))
    state = defined(foldEvent(state, ptcDispatch('root', 'sub-1', 'grep', '{"pattern":"x"}', [textBlock('hit')], 5_035)))
    const inner = recordedCall(defined(state), 'sub-1')
    expect(inner.inner).toBe(true)
    expect(inner.name).toBe('grep')
    expect(inner.hint).toBe('x')
    expect(inner.ms).toBe(15)
    expect(inner.startedAt).toBe(5_020)
    expect(inner.endedAt).toBe(5_035)
    expect(inner.chars).toBe(3)
    expect(inner.text).toBe('hit')
    expect(inner.error).toBe(false)
    expect(defined(state).toolErrors).toBe(0)
  })

  it('keeps an inner call out of the outer tool time', () => {
    const state = folded([
      stepStart(2, 1, 5_000),
      toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
      ptcStart('root', 'sub-1', 'grep', '{}', 5_020),
      ptcDispatch('root', 'sub-1', 'grep', '{}', [textBlock('hit')], 5_035),
    ])
    const metrics = stepMetrics(state)
    expect(state.toolPairs).toBe(0)
    expect(metrics.tool).toBeNull()
    expect(metrics.toolWall).toBe(15)
    expect(metrics.calls.map(call => call.callId)).toEqual(['root', 'sub-1'])
    expect(metrics.tools).toEqual([{ name: 'run_code', count: 1 }, { name: 'grep', count: 1 }])
  })

  it('records a dispatch inside a step with no root call', () => {
    const state = folded([
      stepStart(2, 1, 5_000),
      ptcDispatch('root', 'sub-1', 'grep', '{"pattern":"x"}', [textBlock('hit')], 5_040),
    ])
    expect(recordedCall(state, 'sub-1').inner).toBe(true)
    expect(state.tools).toEqual({ grep: 1 })
  })

  it('leaves the duration unmeasured without a dispatch start', () => {
    let state = codeStep()
    state = defined(foldEvent(state, ptcDispatch('root', 'sub-1', 'read', '{}', [textBlock('x')], 5_035)))
    const inner = recordedCall(defined(state), 'sub-1')
    expect(inner.ms).toBeNull()
    expect(inner.startedAt).toBeNull()
    expect(inner.endedAt).toBe(5_035)
  })

  it('clamps a dispatch that settles before its start', () => {
    let state = codeStep()
    state = defined(foldEvent(state, ptcStart('root', 'sub-1', 'read', '{}', 5_050)))
    state = defined(foldEvent(state, ptcDispatch('root', 'sub-1', 'read', '{}', [textBlock('x')], 5_010)))
    const inner = recordedCall(defined(state), 'sub-1')
    expect(inner.ms).toBe(0)
    expect(inner.startedAt).toBe(5_050)
  })

  it('counts a failed inner call as a tool error', () => {
    const state = folded([
      stepStart(2, 1, 5_000),
      toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
      ptcDispatch('root', 'sub-1', 'read', '{}', [], 5_040, true),
    ])
    expect(recordedCall(state, 'sub-1').error).toBe(true)
    expect(state.toolErrors).toBe(1)
    expect(recordedCall(state, 'sub-1').text).toBeNull()
    expect(recordedCall(state, 'sub-1').lines).toBe(0)
  })

  it('bounds a long inner result', () => {
    const state = folded([
      stepStart(2, 1, 5_000),
      toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
      ptcDispatch('root', 'sub-1', 'read', '{}', [textBlock('x'.repeat(16_500))], 5_040),
    ])
    const inner = recordedCall(state, 'sub-1')
    expect(inner.truncated).toBe(true)
    expect(inner.text).toHaveLength(16_000)
  })

  it('derives an inner edit delta from object arguments', () => {
    const state = folded([
      stepStart(2, 1, 5_000),
      toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
      ptcDispatch('root', 'sub-1', 'write', { file_path: '/a/b.ts', content: 'one\ntwo' }, [], 5_040),
    ])
    const inner = recordedCall(state, 'sub-1')
    expect(inner.added).toBe(2)
    expect(inner.removed).toBe(0)
    expect(inner.after).toBe('one\ntwo')
    expect(inner.hint).toBe('/a/b.ts')
    expect(inner.args).toBe('{"file_path":"/a/b.ts","content":"one\\ntwo"}')
  })

  it('accepts array, null, absent, and scalar arguments without a hint', () => {
    const cases: readonly unknown[] = [[1, 2], null, undefined, 42]
    for (const [index, args] of cases.entries()) {
      const sub = `sub-${index}`
      const state = folded([
        stepStart(2, 1, 5_000),
        toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
        ptcDispatch('root', sub, 'read', args, [], 5_040),
      ])
      const inner = recordedCall(state, sub)
      expect(inner.hint, String(index)).toBeNull()
      expect(inner.args, String(index)).toBe(args === undefined || args === null ? null : JSON.stringify(args))
      expect(inner.added).toBeNull()
    }
  })

  it('drops raw arguments that cannot be serialized but still hints', () => {
    const circular: Record<string, unknown> = { file_path: '/deep/nested/file.ts' }
    circular.self = circular
    const state = folded([
      stepStart(2, 1, 5_000),
      toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
      ptcDispatch('root', 'sub-1', 'read', circular, [], 5_040),
    ])
    const inner = recordedCall(state, 'sub-1')
    expect(inner.args).toBeNull()
    expect(inner.hint).toBe('nested/file.ts')
  })

  it('needs a folded step context for dispatch events', () => {
    expect(foldEvent(undefined, ptcStart('root', 'sub-1', 'read', {}, 5_040))).toBeUndefined()
    expect(foldEvent(undefined, ptcDispatch('root', 'sub-1', 'read', {}, [], 5_040))).toBeUndefined()
  })

  it('lists several inner calls in sequence order', () => {
    const state = folded([
      stepStart(2, 1, 5_000),
      toolCall(2, 1, 'root', 'run_code', '{}', 5_010),
      ptcDispatch('root', 'sub-1', 'grep', '{}', [], 5_030),
      ptcDispatch('root', 'sub-2', 'read', '{}', [], 5_040),
    ])
    expect(stepMetrics(state).calls.map(call => call.callId)).toEqual(['root', 'sub-1', 'sub-2'])
  })
})

describe('step boundaries and the fold default', () => {
  it('opens a step with its sequence and time', () => {
    const state = defined(foldEvent(undefined, stepStart(2, 3, 4_000)))
    expect(state.startTime).toBe(4_000)
    expect(state.startSeq).toBe(1)
    expect(state.ended).toBe(false)
    const metrics = stepMetrics(state)
    expect(metrics.startTime).toBe(4_000)
    expect(metrics.running).toBe(true)
  })

  it('closes a step with or without a folded state', () => {
    const opened = defined(foldEvent(undefined, stepStart(2, 3, 4_000)))
    const closed = defined(foldEvent(opened, stepEnd(2, 3, 4_500)))
    expect(closed.ended).toBe(true)
    expect(closed.endTime).toBe(4_500)
    const alone = defined(foldEvent(undefined, stepEnd(2, 3, 4_500)))
    expect(alone.ended).toBe(true)
    expect(alone.startTime).toBeNull()
  })

  it('counts retries from a retry event with or without an open step', () => {
    const fromStep = defined(foldEvent(undefined, stepStart(3, 1, 1_000)))
    const once = defined(foldEvent(fromStep, retry(3, 1, 1_010)))
    expect(once.retries).toBe(1)
    const twice = defined(foldEvent(once, retry(3, 1, 1_020)))
    expect(twice.retries).toBe(2)
    const standalone = defined(foldEvent(undefined, retry(3, 2, 1_030)))
    expect(standalone.turn).toBe(3)
    expect(standalone.step).toBe(2)
    expect(standalone.retries).toBe(1)
  })

  it('leaves prompt folding and other markers to their definitions', () => {
    const state = defined(foldEvent(undefined, stepStart(1, 1, 1_000)))
    const afterQuestion = foldEvent(state, event('user/message', userMessage([textBlock('question')]), 1_010))
    expect(afterQuestion).toBe(state)
    const afterTurnStart = foldEvent(state, event('turn/start', { turn: 2 }, 1_020))
    expect(afterTurnStart).toBe(state)
    const afterTurnEnd = foldEvent(state, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_030))
    expect(afterTurnEnd).toBe(state)
    expect(foldEvent(undefined, event('user/message', userMessage([textBlock('orphan')]), 1_040)))
      .toBeUndefined()
  })

  it('replays accepted matches into a state', () => {
    expect(fallbackState([])).toBeUndefined()
    expect(fallbackState([
      { event: event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000) },
      { event: ptcStart('root', 'sub', 'read', {}, 1_010) },
    ])).toBeUndefined()
    const state = defined(fallbackState([
      { event: stepStart(2, 1, 5_000) },
      { event: liveChunk(2, 1, { type: 'text-delta', index: 0, text: 'x' }, 5_100) },
      { event: toolCall(2, 1, 'c1', 'read', '{"file_path":"/a/b"}', 5_200) },
      { event: toolResult(2, 1, 'c1', [textBlock('ok')], 5_300) },
      { event: stepEnd(2, 1, 5_400) },
    ]))
    const metrics = stepMetrics(state)
    expect(metrics.ttft).toBe(100)
    expect(metrics.tool).toBe(100)
    expect(metrics.toolWall).toBe(100)
    expect(metrics.wall).toBe(400)
    expect(metrics.running).toBe(false)
  })
})

describe('step metric derivation', () => {
  it('leaves every unmeasured column empty', () => {
    const metrics = stepMetrics(newState(4, 2))
    expect(metrics.turn).toBe(4)
    expect(metrics.step).toBe(2)
    expect(metrics.startTime).toBeNull()
    expect(metrics.endTime).toBeNull()
    expect(metrics.context).toBeNull()
    expect(metrics.ttft).toBeNull()
    expect(metrics.model).toBeNull()
    expect(metrics.decode).toBeNull()
    expect(metrics.tps).toBeNull()
    expect(metrics.output).toBeNull()
    expect(metrics.tool).toBeNull()
    expect(metrics.toolWall).toBeNull()
    expect(metrics.tools).toEqual([])
    expect(metrics.calls).toEqual([])
    expect(metrics.toolOutput).toBe(0)
    expect(metrics.wall).toBeNull()
    expect(metrics.toolPending).toBe(0)
    expect(metrics.running).toBe(true)
    expect(metrics.aborted).toBe(false)
    expect(metrics.interrupted).toBe(false)
    expect(metrics.cacheRead).toBeNull()
    expect(metrics.cacheWrite).toBeNull()
    expect(metrics.cacheHit).toBeNull()
    expect(metrics.mark).toBeNull()
    expect(metrics.prompt).toBeNull()
    expect(metrics.images).toEqual([])
    expect(metrics.closed).toBe(false)
    expect(metrics.closeKind).toBeNull()
  })

  it('derives the timeline, throughput, tool cost, and cache columns', () => {
    const metrics = stepMetrics(stateOf({
      startTime: 1_000,
      firstTokenTime: 1_100,
      messageTime: 1_500,
      endTime: 2_000,
      usage,
      toolPairs: 1,
      toolMs: 250,
      toolOpen: 1,
      toolMissing: 2,
      ended: true,
      interrupted: true,
      mark: 'end',
      prompt: 'question',
      images: [imageBlock().attachment, imageBlock('sha256:b').attachment, imageBlock('sha256:c').attachment],
      closed: true,
      closeKind: 'interrupted',
    }))
    expect(metrics.ttft).toBe(100)
    expect(metrics.model).toBe(500)
    expect(metrics.decode).toBe(400)
    expect(metrics.tps).toBeCloseTo(40 / 0.4)
    expect(metrics.context).toBe(600)
    expect(metrics.output).toBe(40)
    expect(metrics.cacheRead).toBe(400)
    expect(metrics.cacheWrite).toBe(100)
    expect(metrics.cacheHit).toBeCloseTo(400 / 600)
    expect(metrics.tool).toBe(250)
    expect(metrics.wall).toBe(1_000)
    expect(metrics.aborted).toBe(false)
    expect(metrics.running).toBe(false)
    expect(metrics.interrupted).toBe(true)
    expect(metrics.toolPending).toBe(3)
    expect(metrics.mark).toBe('end')
    expect(metrics.prompt).toBe('question')
    expect(metrics.images).toHaveLength(3)
    expect(metrics.closed).toBe(true)
    expect(metrics.closeKind).toBe('interrupted')
  })

  it('reports a prompt marker through the same metric row', () => {
    const metrics = stepMetrics(newState(1, 0, 'prompt'))
    expect(metrics.turn).toBe(1)
    expect(metrics.step).toBe(0)
    expect(metrics.mark).toBe('prompt')
  })

  it('requires a start for the first-token and model spans', () => {
    const noStart = stepMetrics(stateOf({ firstTokenTime: 1_100, messageTime: 1_500 }))
    expect(noStart.ttft).toBeNull()
    expect(noStart.model).toBeNull()
    expect(noStart.decode).toBe(400)
    const noFirst = stepMetrics(stateOf({ startTime: 1_000, messageTime: 1_500 }))
    expect(noFirst.ttft).toBeNull()
    expect(noFirst.model).toBe(500)
    expect(noFirst.decode).toBeNull()
    const noMessage = stepMetrics(stateOf({ startTime: 1_000, firstTokenTime: 1_100 }))
    expect(noMessage.model).toBeNull()
    expect(noMessage.decode).toBeNull()
    expect(noMessage.tps).toBeNull()
  })

  it('derives speed only from a positive decode span and output', () => {
    const zeroSpan = stepMetrics(stateOf({
      startTime: 1_000, firstTokenTime: 1_200, messageTime: 1_200, usage,
    }))
    expect(zeroSpan.decode).toBe(0)
    expect(zeroSpan.tps).toBeNull()
    const zeroOutput = stepMetrics(stateOf({
      startTime: 1_000, firstTokenTime: 1_100, messageTime: 1_500,
      usage: { inputTokens: 10, outputTokens: 0 },
    }))
    expect(zeroOutput.output).toBe(0)
    expect(zeroOutput.tps).toBeNull()
    const noOutput = stepMetrics(stateOf({
      startTime: 1_000, firstTokenTime: 1_100, messageTime: 1_500,
      usage: { inputTokens: 10 },
    }))
    expect(noOutput.output).toBeNull()
    expect(noOutput.tps).toBeNull()
  })

  it('clamps backwards spans to zero and treats non-finite times as unrecorded', () => {
    const backwards = stepMetrics(stateOf({
      startTime: 2_000, firstTokenTime: 1_500, messageTime: 1_000, endTime: 500,
    }))
    expect(backwards.ttft).toBe(0)
    expect(backwards.model).toBe(0)
    expect(backwards.decode).toBe(0)
    expect(backwards.wall).toBe(0)
    const unrecorded = stepMetrics(stateOf({
      startTime: Number.NaN,
      firstTokenTime: Number.POSITIVE_INFINITY,
      messageTime: Number.NaN,
      endTime: Number.NaN,
    }))
    expect(unrecorded.startTime).toBeNull()
    expect(unrecorded.endTime).toBeNull()
    expect(unrecorded.ttft).toBeNull()
    expect(unrecorded.wall).toBeNull()
  })

  it('reports an ended step without a settled message as aborted', () => {
    const aborted = stepMetrics(stateOf({ ended: true }))
    expect(aborted.aborted).toBe(true)
    expect(aborted.running).toBe(false)
    const settled = stepMetrics(stateOf({ ended: true, messageTime: 1_000 }))
    expect(settled.aborted).toBe(false)
    const running = stepMetrics(stateOf({ messageTime: 1_000 }))
    expect(running.aborted).toBe(false)
    expect(running.running).toBe(true)
  })

  it('reports tool time only when at least one call paired', () => {
    const paired = stepMetrics(stateOf({ toolPairs: 1, toolMs: 200 }))
    expect(paired.tool).toBe(200)
    const unpaired = stepMetrics(stateOf({ toolPairs: 0, toolMs: 200 }))
    expect(unpaired.tool).toBeNull()
  })

  it('lists calls in call order and caps the list', () => {
    const calls = Array.from({ length: CALL_LIMIT + 2 }, (_, index) => statsCall(
      `call-${index}`,
      CALL_LIMIT + 2 - index,
    ))
    const metrics = stepMetrics(stateOf({ calls: callsRecord(calls) }))
    expect(metrics.calls).toHaveLength(CALL_LIMIT)
    expect(metrics.calls[0]?.callId).toBe('call-13')
    expect(metrics.calls.at(-1)?.callId).toBe('call-2')
  })

  it('bounds result text across the listed calls of one step', () => {
    const calls = Array.from({ length: 5 }, (_, index) => statsCall(`call-${index}`, index, {
      text: 'x'.repeat(16_000),
    }))
    const metrics = stepMetrics(stateOf({ calls: callsRecord(calls) }))
    expect(metrics.calls.slice(0, 3).every(call => call.text?.length === 16_000)).toBe(true)
    expect(metrics.calls.slice(3).every(call => call.text === null && call.truncated)).toBe(true)
  })

  it('keeps calls without result text regardless of the step text budget', () => {
    const calls = [
      statsCall('pending', 1),
      statsCall('long', 2, { text: 'x'.repeat(16_000) }),
    ]
    const metrics = stepMetrics(stateOf({ calls: callsRecord(calls) }))
    expect(metrics.calls[0]?.text).toBeNull()
    expect(metrics.calls[0]?.truncated).toBe(false)
    expect(metrics.calls[1]?.text).toHaveLength(16_000)
  })

  it('sorts tools by descending count and keeps first-call order for ties', () => {
    const metrics = stepMetrics(stateOf({ tools: { grep: 1, read: 3, edit: 2 } }))
    expect(metrics.tools).toEqual([
      { name: 'read', count: 3 },
      { name: 'edit', count: 2 },
      { name: 'grep', count: 1 },
    ])
    const tied = stepMetrics(stateOf({ tools: { read: 1, grep: 1 } }))
    expect(tied.tools).toEqual([{ name: 'read', count: 1 }, { name: 'grep', count: 1 }])
  })

  it('keeps the Code-Mode runner until the builder merges inner dispatches', () => {
    const calls = callsRecord([
      statsCall('run', 1, { name: 'run_code', chars: 1_000 }),
      statsCall('inner', 2, { name: 'read', chars: 5, inner: true }),
      statsCall('plain', 3, { name: 'write', chars: 20 }),
    ])
    const metrics = stepMetrics(stateOf({
      calls,
      tools: { run_code: 1, read: 1, write: 1 },
    }))
    expect(metrics.calls.map(call => call.callId)).toEqual(['run', 'inner', 'plain'])
    expect(metrics.tools).toEqual([
      { name: 'run_code', count: 1 },
      { name: 'read', count: 1 },
      { name: 'write', count: 1 },
    ])
    expect(metrics.toolOutput).toBe(1_025)
  })

  it('counts every result when no inner call is present', () => {
    const calls = callsRecord([
      statsCall('read', 1, { name: 'read', chars: 12 }),
      statsCall('pending', 2, { name: 'grep' }),
    ])
    const metrics = stepMetrics(stateOf({ calls, tools: { read: 1, grep: 1 } }))
    expect(metrics.toolOutput).toBe(12)
    expect(metrics.tools).toHaveLength(2)
  })

  it('measures tool wall time as the union of overlapping call spans', () => {
    const calls = callsRecord([
      statsCall('c1', 1, { startedAt: 1_000, endedAt: 1_200 }),
      statsCall('c2', 2, { startedAt: 1_100, endedAt: 1_300 }),
    ])
    const metrics = stepMetrics(stateOf({ calls, toolPairs: 2, toolMs: 400 }))
    expect(metrics.tool).toBe(400)
    expect(metrics.toolWall).toBe(300)
  })
})

describe('tool span union', () => {
  it('reports no span when no call settled with both ends', () => {
    expect(toolSpanUnion([])).toBeNull()
    expect(toolSpanUnion([
      statsCall('a', 1, { startedAt: 1_000 }),
      statsCall('b', 2, { endedAt: 2_000 }),
    ])).toBeNull()
  })

  it('adds disjoint spans and counts overlaps once', () => {
    expect(toolSpanUnion([
      statsCall('a', 1, { startedAt: 1_000, endedAt: 1_200 }),
      statsCall('b', 2, { startedAt: 1_500, endedAt: 1_700 }),
    ])).toBe(400)
    expect(toolSpanUnion([
      statsCall('a', 1, { startedAt: 1_000, endedAt: 1_500 }),
      statsCall('b', 2, { startedAt: 1_200, endedAt: 1_300 }),
    ])).toBe(500)
    expect(toolSpanUnion([
      statsCall('a', 1, { startedAt: 1_000, endedAt: 1_200 }),
      statsCall('b', 2, { startedAt: 1_100, endedAt: 1_400 }),
    ])).toBe(400)
  })

  it('sorts input spans and joins touching ones', () => {
    expect(toolSpanUnion([
      statsCall('late', 1, { startedAt: 2_000, endedAt: 2_100 }),
      statsCall('early', 2, { startedAt: 1_000, endedAt: 1_100 }),
    ])).toBe(200)
    expect(toolSpanUnion([
      statsCall('first', 1, { startedAt: 1_000, endedAt: 1_200 }),
      statsCall('second', 2, { startedAt: 1_200, endedAt: 1_500 }),
    ])).toBe(500)
  })
})

describe('code-mode name helper', () => {
  it('recognizes the runner spellings and nothing else', () => {
    expect(isCodeMode('run_code')).toBe(true)
    expect(isCodeMode('RunCode')).toBe(true)
    expect(isCodeMode('runCode')).toBe(true)
    expect(isCodeMode('RUN_CODE')).toBe(true)
    expect(isCodeMode('run-code')).toBe(false)
    expect(isCodeMode('grep')).toBe(false)
    expect(isCodeMode(null)).toBe(false)
  })
})
