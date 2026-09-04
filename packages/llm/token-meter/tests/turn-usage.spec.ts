import { describe, expect, it } from 'vitest'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '../src/turn-usage.ts'

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: seq, type, data } as unknown as SessionEvent
}

type UsageOverrides = { [Key in keyof TokenUsage]?: TokenUsage[Key] | undefined }

function usage(overrides: UsageOverrides = {}): TokenUsage {
  const value = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 170,
    cacheReadTokens: 50,
    ...overrides,
  }
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as TokenUsage
}

function message(
  seq: number,
  tokenUsage?: TokenUsage,
  provider = 'deepseek',
  model = 'deepseek-chat',
  step = 1,
  streamTokenUsage = tokenUsage,
) {
  return event(seq, 'assistant/message', {
    turn: 1,
    step,
    stream: [
      { type: 'chunk', time: seq, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      ...(streamTokenUsage === undefined
        ? []
        : [{ type: 'chunk' as const, time: seq, chunk: { type: 'usage' as const, usage: streamTokenUsage } }]),
    ],
    message: {
      id: `message-${seq}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider, model },
    },
    ...tokenUsage === undefined ? {} : { usage: tokenUsage },
  })
}

function attempt(seq: number, chunks: readonly StreamChunk[], step = 1): SessionEvent {
  return event(seq, 'assistant/attempt', {
    turn: 1,
    step,
    stream: chunks.map((chunk, index) => ({ type: 'chunk', time: seq + index, chunk })),
  })
}

function completeAttempt(...middle: readonly SessionEvent[]): SessionEvent[] {
  return [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    ...middle,
    event(90, 'step/end', { turn: 1, step: 1 }),
    event(91, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('deriveTurnTokenUsage', () => {
  it('preserves authoritative totals and explicit optional buckets', () => {
    expect(deriveTurnTokenUsage(completeAttempt(message(3, usage({
      cacheWriteTokens: 0,
      reasoningTokens: 8,
    }))))).toEqual({
      uncachedInputTokens: 100,
      outputTokens: 20,
      totalTokens: 170,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      reasoningTokens: 8,
      routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    })
  })

  it('derives an exact total only when both cache buckets are present', () => {
    expect(deriveTurnTokenUsage(completeAttempt(message(3, usage({
      totalTokens: undefined,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    }))))?.totalTokens).toBe(17)

    expect(deriveTurnTokenUsage(completeAttempt(message(3, usage({
      totalTokens: undefined,
      cacheWriteTokens: undefined,
    }))))).toBeUndefined()
  })

  it('lets final message usage replace the latest streaming sample', () => {
    const result = deriveTurnTokenUsage(completeAttempt(
      message(
        4,
        usage({ inputTokens: 30, outputTokens: 5, totalTokens: 45, cacheReadTokens: 10 }),
        'deepseek',
        'deepseek-chat',
        1,
        usage(),
      ),
    ))
    expect(result).toMatchObject({ uncachedInputTokens: 30, outputTokens: 5, totalTokens: 45 })
  })

  it('keeps the latest streaming sample when the final message omits usage', () => {
    const result = deriveTurnTokenUsage(completeAttempt(
      message(4, undefined, 'deepseek', 'deepseek-chat', 1, usage()),
    ))
    expect(result).toMatchObject({ uncachedInputTokens: 100, outputTokens: 20, totalTokens: 170 })
  })

  it('counts an error-finished attempt once across its retry boundary', () => {
    const events = completeAttempt(
      attempt(3, [
        { type: 'usage', usage: usage() },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'failed' } } },
      ]),
      event(5, 'llm/retry', { turn: 1, step: 1 }),
      event(6, 'llm/retry-started', { turn: 1, step: 1, retry: 1 }),
      message(7, usage({ inputTokens: 40, outputTokens: 10, totalTokens: 70, cacheReadTokens: 20 })),
    )
    expect(deriveTurnTokenUsage(events)).toEqual({
      uncachedInputTokens: 140,
      outputTokens: 30,
      totalTokens: 240,
      cacheReadTokens: 70,
    })
  })

  it('does not invent an attempt for a scheduled retry that never started', () => {
    const result = deriveTurnTokenUsage(completeAttempt(
      attempt(3, [
        { type: 'usage', usage: usage() },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'failed' } } },
      ]),
      event(4, 'llm/retry', { turn: 1, step: 1 }),
    ))
    expect(result).toMatchObject({ totalTokens: 170 })
  })

  it('fails closed for missing lifecycle or missing attempt usage', () => {
    expect(deriveTurnTokenUsage([
      event(1, 'turn/start', { turn: 1 }),
      message(2, usage()),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).toBeUndefined()
    expect(deriveTurnTokenUsage(completeAttempt(message(3)))).toBeUndefined()
  })

  it.each([
    ['negative', usage({ inputTokens: -1 })],
    ['fractional', usage({ outputTokens: 1.5 })],
    ['unsafe', usage({ totalTokens: Number.MAX_SAFE_INTEGER + 1 })],
    ['invalid cache read', usage({ cacheReadTokens: -1 })],
    ['invalid cache write', usage({ cacheWriteTokens: 1.5 })],
    ['negative exact prompt', usage({ outputTokens: 20, totalTokens: 10, cacheReadTokens: undefined })],
    ['total below known prompt', usage({ totalTokens: 160 })],
    ['contradictory complete buckets', usage({ totalTokens: 171, cacheWriteTokens: 0 })],
    ['reasoning exceeds output', usage({ reasoningTokens: 21 })],
    ['prompt bucket overflow', usage({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: 1,
    })],
    ['derived total overflow', usage({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
      totalTokens: undefined,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })],
  ])('fails closed for %s usage', (_label, invalidUsage) => {
    expect(deriveTurnTokenUsage(completeAttempt(message(3, invalidUsage)))).toBeUndefined()
  })

  it('omits optional aggregates and routes unless every attempt reports them', () => {
    const events = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      message(3, usage({ totalTokens: 175, cacheWriteTokens: 5, reasoningTokens: 2 })),
      event(4, 'step/end', { turn: 1, step: 1 }),
      event(5, 'step/start', { turn: 1, step: 2 }),
      event(6, 'assistant/message', {
        turn: 1,
        step: 2,
        message: {
          id: 'message-6', role: 'assistant', content: [],
          source: { kind: 'model', provider: '', model: '' },
        },
        usage: usage({ cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }),
      }),
      event(7, 'step/end', { turn: 1, step: 2 }),
      event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(deriveTurnTokenUsage(events)).toEqual({ uncachedInputTokens: 200, outputTokens: 40, totalTokens: 345 })
  })

  it('sums multiple steps and preserves distinct attributed routes', () => {
    const events = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      message(3, usage()),
      event(4, 'step/end', { turn: 1, step: 1 }),
      event(5, 'step/start', { turn: 1, step: 2 }),
      message(6, usage(), 'openai', 'gpt-5', 2),
      event(7, 'step/end', { turn: 1, step: 2 }),
      event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(deriveTurnTokenUsage(events)).toEqual({
      uncachedInputTokens: 200,
      outputTokens: 40,
      totalTokens: 340,
      cacheReadTokens: 100,
      routes: [
        { provider: 'deepseek', model: 'deepseek-chat' },
        { provider: 'openai', model: 'gpt-5' },
      ],
    })
  })

  it('fails closed when aggregation overflows a safe integer', () => {
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1
    const attempt = usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: undefined, totalTokens: half })
    const events = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      message(3, attempt),
      event(4, 'step/end', { turn: 1, step: 1 }),
      event(5, 'step/start', { turn: 1, step: 2 }),
      event(6, 'assistant/message', {
        turn: 1,
        step: 2,
        message: {
          id: 'message-6', role: 'assistant', content: [],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
        usage: attempt,
      }),
      event(7, 'step/end', { turn: 1, step: 2 }),
      event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(deriveTurnTokenUsage(events)).toBeUndefined()
  })

  it.each([
    ['uncached input', usage({
      inputTokens: Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1,
      outputTokens: 0,
      cacheReadTokens: undefined,
      totalTokens: Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1,
    })],
    ['output', usage({
      inputTokens: 0,
      outputTokens: Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1,
      cacheReadTokens: undefined,
      totalTokens: Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1,
    })],
  ])('fails closed when aggregate %s overflows', (_label, attempt) => {
    expect(deriveTurnTokenUsage([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      message(3, attempt),
      event(4, 'step/end', { turn: 1, step: 1 }),
      event(5, 'step/start', { turn: 1, step: 1 }),
      message(6, attempt),
      event(7, 'step/end', { turn: 1, step: 1 }),
      event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).toBeUndefined()
  })

  it('closes a sampled attempt at step/end', () => {
    expect(deriveTurnTokenUsage(completeAttempt(
      attempt(3, [
        { type: 'usage', usage: usage() },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
      event(5, 'tool/call', { turn: 1, step: 1 }),
    ))).toMatchObject({ totalTokens: 170 })
  })

  it('accepts an aborted finish after observing usage', () => {
    expect(deriveTurnTokenUsage(completeAttempt(
      attempt(3, [
        { type: 'usage', usage: usage() },
        { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } },
      ]),
    ))).toMatchObject({ totalTokens: 170 })
  })

  it.each([
    ['empty turn', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]],
    ['duplicate turn start', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/start', { turn: 1 }),
    ]],
    ['wrong turn end', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]],
    ['turn end during an open attempt', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]],
    ['duplicate turn end', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]],
    ['event after turn end', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(3, 'step/start', { turn: 1, step: 1 }),
    ]],
    ['wrong-turn step start', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 2, step: 1 }),
    ]],
    ['nested step start', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'step/start', { turn: 1, step: 2 }),
    ]],
    ['retry start without a scheduled retry', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'llm/retry-started', { turn: 1, step: 1, retry: 1 }),
    ]],
    ['retry start after a final message', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      message(3, usage()),
      event(4, 'llm/retry-started', { turn: 1, step: 1, retry: 1 }),
    ]],
    ['retry start for the wrong step', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      attempt(3, [
        { type: 'usage', usage: usage() },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'failed' } } },
      ]),
      event(4, 'llm/retry', { turn: 1, step: 1 }),
      event(5, 'llm/retry-started', { turn: 1, step: 2, retry: 1 }),
    ]],
    ['attempt outside a step', [
      event(1, 'turn/start', { turn: 1 }),
      attempt(2, [{ type: 'usage', usage: usage() }]),
    ]],
    ['attempt for the wrong step', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      attempt(3, [{ type: 'usage', usage: usage() }], 2),
    ]],
    ['error finish without usage', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      attempt(3, [{
        type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'failed' } },
      }]),
    ]],
    ['retry outside an attempt', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'llm/retry', { turn: 1, step: 1 }),
    ]],
    ['retry for the wrong step', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      attempt(3, [
        { type: 'usage', usage: usage() },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'failed' } } },
      ]),
      event(4, 'llm/retry', { turn: 1, step: 2 }),
    ]],
    ['retry after a final message', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      message(3, usage()),
      event(4, 'llm/retry', { turn: 1, step: 1 }),
    ]],
    ['retry before any usage', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'llm/retry', { turn: 1, step: 1 }),
    ]],
    ['step end outside an attempt', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/end', { turn: 1, step: 1 }),
    ]],
    ['step end for the wrong step', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'step/end', { turn: 1, step: 2 }),
    ]],
    ['step end before any usage', [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'step/end', { turn: 1, step: 1 }),
    ]],
  ])('fails closed for invalid lifecycle: %s', (_label, events) => {
    expect(deriveTurnTokenUsage(events)).toBeUndefined()
  })

  it('requires the complete turn window', () => {
    expect(deriveTurnTokenUsage(completeAttempt(message(3, usage())).slice(1))).toBeUndefined()
    expect(deriveTurnTokenUsage(completeAttempt(message(3, usage())).slice(0, -1))).toBeUndefined()
  })
})
