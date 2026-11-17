/**
 * Stream scheduler: fake host + fake drivers under fake timers.
 *
 * Content model of the fake host: a fragment is a string; `|` separates platform messages (multi-part states),
 * a draft/payload is `{ text }`. The fake mode diffs by prefix (`append` op or `replace`) and `check()` rejects
 * drafts longer than `maxChars`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Element, Fragment } from '@deepseek-ai/satori-element'
import type { MessageHandle, SendOptions, SendResult, SentPart } from '../src/bot.ts'
import { type LimitViolation, PlatformError, StreamLimitError } from '../src/errors.ts'
import type { RenderReport } from '../src/fallback.ts'
import type { Mode } from '../src/mode.ts'
import type { Prepared } from '../src/resource.ts'
import {
  createEditDriver, createMessageStream, type EditDriverAdapter, type MessageStream, nextSequence, StreamAbortError, streamBackoff,
  type StreamDriver, type StreamFrame, type StreamHost, type StreamOptions, type StreamTickContext,
} from '../src/stream.ts'

interface Draft { text: string }
interface Patch { append: string }
interface FakeTypes { node: unknown; draft: Draft; payload: Draft; patch: Patch }

const report = { degraded: [], moved: [], split: 0, folded: 0, dropped: [], fallbacks: [], summary: () => '' } as RenderReport
const target = { chat: { id: 'c1', type: 'group' as const } }

function element(text: string): Element<'message'> {
  return { type: 'message', attrs: {}, children: [], text } as unknown as Element<'message'>
}
function textOf(content: Element<'message'>): string {
  return (content as unknown as { text: string }).text
}

interface ModeOptions {
  diff?: boolean
  maxChars?: number
  interval?: number
}

function fakeMode({ diff = true, maxChars, interval }: ModeOptions = {}): Mode<FakeTypes> {
  const mode: Mode<FakeTypes> = {
    id: 'fake',
    elements: undefined as never,
    limits: interval === undefined ? {} : { 'limit.stream.interval': interval },
    assemble: () => [],
    serialize: msg => ({ text: msg.draft.text }),
  }
  if (diff) {
    mode.diff = (prev, next) => {
      if (next.text === prev.text) return []
      if (next.text.startsWith(prev.text)) return [{ append: next.text.slice(prev.text.length) }]
      return 'replace'
    }
  }
  if (maxChars !== undefined) {
    mode.check = msg => msg.text.length > maxChars
      ? [{ kind: 'size', key: 'limit.text.chars', limit: maxChars, actual: msg.text.length, message: 'too long' }]
      : []
  }
  return mode
}

interface Call {
  op: 'open' | 'tick' | 'close'
  text: string
  patches?: Patch[] | undefined
  at: number
  attempt: number
  quote?: string | undefined
}

interface FakeDriver extends StreamDriver<FakeTypes> {
  calls: Call[]
  /** Errors thrown by the next calls of an op (consumed in order). */
  failures: Record<Call['op'], unknown[]>
  /** Per-op latency (ms). */
  latency: Partial<Record<Call['op'], number>>
  updatesLeft?: number
  until?: number
}

function fakeDriver(strategy: 'patch' | 'edit' | 'append'): FakeDriver {
  let n = 0
  const driver: FakeDriver = {
    strategy,
    calls: [],
    failures: { open: [], tick: [], close: [] },
    latency: {},
    async open(_first, payload, ctx) {
      await record('open', payload.text, ctx)
      return {
        bot: 'fake:1', target, mode: ctx.mode, parts: [{ id: `m${++n}`, kind: 'fake', time: Date.now() }],
        createdAt: Date.now(), edits: 0, content: ctx.content, state: { sequence: 0 },
      }
    },
    async tick(handle, change, ctx) {
      await record('tick', change.payload.text, ctx, change.patches)
      handle.edits++
    },
    async close(_handle, last, ctx) {
      await record('close', last.payload.text, ctx)
    },
    budget() {
      const budget: { updatesLeft?: number; until?: number } = {}
      if (driver.updatesLeft !== undefined) budget.updatesLeft = driver.updatesLeft
      if (driver.until !== undefined) budget.until = driver.until
      return budget
    },
  }
  async function record(op: Call['op'], text: string, ctx: StreamTickContext, patches?: Patch[]) {
    const at = Date.now()
    const latency = driver.latency[op]
    if (latency) await new Promise(resolve => setTimeout(resolve, latency))
    const failure = driver.failures[op].shift()
    if (failure) throw failure
    driver.calls.push({ op, text, patches, at, attempt: ctx.attempt, quote: ctx.quote })
  }
  return driver
}

interface FakeHost extends StreamHost<FakeTypes> {
  sends: { text: string; options: SendOptions }[]
  recalls: MessageHandle[]
  renders: number
  canRecall: boolean
  registered: string[]
}

function fakeHost(driver: StreamDriver<FakeTypes> | undefined, mode = fakeMode()): FakeHost {
  const host: FakeHost = {
    bot: undefined as never,
    target,
    mode,
    driver,
    sends: [],
    recalls: [],
    renders: 0,
    canRecall: true,
    registered: [],
    async render(content: Fragment): Promise<StreamFrame<FakeTypes>> {
      host.renders++
      const text = String(content)
      if (text === '!boom') throw new Error('render failed')
      const [body, quote] = text.split('>>') as [string, string?]
      const parts = body.split('|')
      const prepared: Prepared<Draft>[] = parts.map(part => ({ draft: { text: part }, resolved: new Map() }))
      const actions = /\[btn:(\w+)]/.exec(text)
      return {
        content: element(body),
        result: {
          msgs: prepared.map(p => p.draft),
          ...quote === undefined ? {} : { quote },
          actions: actions ? [{ kind: 'button' as const, id: actions[1]!, callback: callbacks[actions[1]!] ??= () => {} }] : [],
          report,
        },
        prepared,
        payloads: prepared.map(p => mode.serialize(p, undefined as never)),
      }
    },
    async send(content, options): Promise<SendResult> {
      const text = String(content instanceof Object ? textOf(content as Element<'message'>) : content)
      host.sends.push({ text, options })
      return {
        handle: { bot: 'fake:1', target, mode: 'fake', parts: [{ id: `s${host.sends.length}`, kind: 'fake', time: 0 }], createdAt: 0, edits: 0, content: element(text) },
        report,
      }
    },
    async recall(handle) {
      host.recalls.push(handle)
      return host.canRecall
    },
    register(actions) {
      host.registered.push(...actions.map(action => action.id))
    },
    classify(error) {
      return PlatformError.is(error) ? error : new PlatformError('fatal', String(error))
    },
    now: () => Date.now(),
  }
  const callbacks: Record<string, () => void> = {}
  return host
}

const flush = () => vi.advanceTimersByTimeAsync(0)
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** Close and settle everything (also pending retry sleeps). */
async function closeAll(stream: MessageStream, final?: Fragment) {
  const result = stream.close(final)
  result.catch(() => {})
  await advance(60_000)
  return result
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('helpers', () => {
  it('backoff doubles from 500 ms up to 8 s and honours retryAfterMs', () => {
    expect([1, 2, 3, 4, 5, 6].map(n => streamBackoff(n))).toEqual([500, 1000, 2000, 4000, 8000, 8000])
    expect(streamBackoff(3, 1234)).toBe(1234)
  })

  it('nextSequence is strictly increasing', () => {
    const state = { sequence: 4 }
    expect([nextSequence(state), nextSequence(state)]).toEqual([5, 6])
    expect(state.sequence).toBe(6)
  })
})

describe('final strategy', () => {
  it('buffers updates and sends once at close', async () => {
    const host = fakeHost(undefined)
    const stream = createMessageStream(host, { idempotencyKey: 'k', intervalMs: 50 })
    expect(stream.strategy).toBe('final')
    expect(stream.state).toBe('idle')
    stream.update('a')
    stream.update('ab')
    expect(stream.state).toBe('open')
    await advance(5_000)
    expect(host.sends).toEqual([])
    expect(host.renders).toBe(0)
    const result = await closeAll(stream)
    expect(host.sends.map(s => s.text)).toEqual(['ab'])
    expect(host.sends[0]!.options.idempotencyKey).toBe('k')
    expect(host.sends[0]!.options).not.toHaveProperty('intervalMs')
    expect(result.handle.parts[0]!.id).toBe('s1')
    expect(stream.state).toBe('closed')
    expect(stream.handle).toBe(result.handle)
    await expect(stream.done).resolves.toBe(result)
  })

  it('close(final) wins over the last update; updates after close are ignored', async () => {
    const host = fakeHost(undefined)
    const stream = createMessageStream(host)
    stream.update('draft')
    const done = stream.close('final')
    stream.update('late')
    await done
    expect(host.sends.map(s => s.text)).toEqual(['final'])
    expect(stream.close()).toBe(stream.done)
  })

  it('close without any content fails', async () => {
    const stream = createMessageStream(fakeHost(undefined))
    await expect(closeAll(stream)).rejects.toThrow(/without content/)
    expect(stream.state).toBe('failed')
  })

  it('a send failure fails done', async () => {
    const host = fakeHost(undefined)
    host.send = async () => { throw new PlatformError('permission', 'muted') }
    const stream = createMessageStream(host)
    await expect(closeAll(stream, 'x')).rejects.toMatchObject({ kind: 'permission' })
    expect(stream.state).toBe('failed')
  })
})

describe('scheduler', () => {
  it('coalesces N updates into at most ceil(T / interval) publications', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { intervalMs: 300 })
    let text = ''
    for (let t = 0; t < 3000; t += 30) {
      text += 'x'
      stream.update(text)
      await advance(30)
    }
    const published = driver.calls.length
    expect(published).toBeGreaterThan(3)
    expect(published).toBeLessThanOrEqual(Math.ceil(3000 / 300) + 1)
    expect(driver.calls[0]).toMatchObject({ op: 'open', text: 'x', at: 0 })
    // ticks are at least one interval apart
    for (let i = 1; i < driver.calls.length; i++) {
      expect(driver.calls[i]!.at - driver.calls[i - 1]!.at).toBeGreaterThanOrEqual(300)
    }
    await closeAll(stream)
    expect(driver.calls.at(-1)).toMatchObject({ op: 'close', text })
    expect(stream.state).toBe('closed')
  })

  it('throttles relative to the end of the previous tick and honours limit.stream.interval', async () => {
    const driver = fakeDriver('patch')
    driver.latency.tick = 200
    const host = fakeHost(driver, fakeMode({ interval: 500 }))
    const stream = createMessageStream(host, { intervalMs: 100 })
    stream.update('a')
    await flush()
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
    stream.update('ab')
    await advance(499)
    expect(driver.calls).toHaveLength(1)
    await advance(1)
    stream.update('abc') // arrives while the tick is in flight
    await advance(200) // tick 'ab' finishes at 700
    expect(driver.calls.map(c => c.text)).toEqual(['a', 'ab'])
    await advance(499) // next tick at 700 + 500 = 1200 (starts), finishes 1400
    expect(driver.calls).toHaveLength(2)
    await advance(201)
    expect(driver.calls.map(c => [c.text, c.at])).toEqual([['a', 0], ['ab', 500], ['abc', 1200]])
    await closeAll(stream)
  })

  it('waits firstDelayMs before the first publication (default 800 ms for edit)', async () => {
    const driver = fakeDriver('edit')
    const stream = createMessageStream(fakeHost(driver))
    stream.update('h')
    await advance(400)
    stream.update('hello')
    await advance(399)
    expect(driver.calls).toEqual([])
    await advance(1)
    expect(driver.calls).toMatchObject([{ op: 'open', text: 'hello', at: 800 }])
    await closeAll(stream)
  })

  it('closing before the first publication sends a plain message instead of opening a stream', async () => {
    const driver = fakeDriver('edit')
    const host = fakeHost(driver)
    const stream = createMessageStream(host)
    stream.update('quick')
    await advance(100)
    const result = await closeAll(stream, 'quick answer')
    expect(driver.calls).toEqual([])
    expect(host.sends.map(s => s.text)).toEqual(['quick answer'])
    expect(stream.handle).toBe(result.handle)
  })

  it('skips no-op updates (identical payload or empty diff)', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('same')
    await flush()
    stream.update('same')
    await advance(1000)
    stream.update('same')
    await advance(1000)
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
    await closeAll(stream)
    expect(driver.calls.map(c => c.op)).toEqual(['open', 'close'])
  })

  it('passes incremental patches; replace or a missing diff publishes the whole state', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('ab')
    await flush()
    stream.update('abcd')
    await advance(300)
    stream.update('xyz')
    await advance(300)
    expect(driver.calls.slice(1)).toMatchObject([
      { op: 'tick', text: 'abcd', patches: [{ append: 'cd' }] },
      { op: 'tick', text: 'xyz', patches: undefined },
    ])
    await closeAll(stream)

    const plain = fakeDriver('patch')
    const s2 = createMessageStream(fakeHost(plain, fakeMode({ diff: false })), { intervalMs: 300 })
    s2.update('a')
    await flush()
    s2.update('ab')
    await advance(300)
    expect(plain.calls[1]).toMatchObject({ op: 'tick', patches: undefined })
    await closeAll(s2)
  })

  it('stops intermediate publication after maxDurationMs; close still publishes', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300, maxDurationMs: 1000 })
    let text = ''
    for (let t = 0; t < 3000; t += 100) {
      stream.update(text += 'x')
      await advance(100)
    }
    expect(driver.calls.every(c => c.at < 1000)).toBe(true)
    await closeAll(stream)
    expect(driver.calls.at(-1)).toMatchObject({ op: 'close', text })
  })

  it('drops intermediate states that cannot be rendered', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('ok')
    await flush()
    stream.update('!boom')
    await advance(300)
    stream.update('ok again')
    await advance(300)
    expect(driver.calls.map(c => c.text)).toEqual(['ok', 'ok again'])
    await closeAll(stream)
  })

  it('registers onClick actions once per published callback', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { intervalMs: 300 })
    stream.update('a [btn:stop]')
    await flush()
    stream.update('ab [btn:stop]')
    await advance(300)
    await closeAll(stream)
    expect(host.registered).toEqual(['stop'])
  })

  it('passes the quote of the current state to the driver', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver))
    stream.update('hi>>m42')
    await flush()
    expect(driver.calls[0]).toMatchObject({ op: 'open', text: 'hi', quote: 'm42' })
    await closeAll(stream)
  })
})

describe('retry', () => {
  it('retries a retryable tick with backoff, then drops it; the next tick republishes the whole state', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('a')
    await flush()
    const err = () => new PlatformError('retryable', 'timeout')
    driver.failures.tick.push(err(), err(), err())
    stream.update('ab')
    await advance(300) // attempt 1 at 300
    await advance(500) // attempt 2 at 800
    await advance(1000) // attempt 3 at 1800 → dropped
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
    expect(driver.failures.tick).toEqual([])
    stream.update('abc')
    await advance(300)
    expect(driver.calls[1]).toMatchObject({ op: 'tick', text: 'abc', patches: undefined, attempt: 1 })
    expect(stream.state).toBe('open')
    await closeAll(stream)
    expect(stream.state).toBe('closed')
  })

  it('succeeds on a later attempt and honours retryAfterMs', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('a')
    await flush()
    driver.failures.tick.push(new PlatformError('rate-limit', '429', { retryAfterMs: 2000 }))
    stream.update('ab')
    await advance(300)
    await advance(1999)
    expect(driver.calls).toHaveLength(1)
    await advance(1)
    expect(driver.calls[1]).toMatchObject({ op: 'tick', text: 'ab', attempt: 2, at: 2300 })
    await closeAll(stream)
  })

  it('republishes the whole state after one rejected tick instead of stopping', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('a')
    await flush()
    driver.failures.tick.push(new PlatformError('invalid', 'bad'))
    stream.update('ab')
    await advance(300)
    // The platform may have applied part of the rejected state, so the next publication is the whole state again.
    stream.update('abc')
    await advance(3000)
    expect(driver.calls.map(c => [c.op, c.text])).toEqual([['open', 'a'], ['tick', 'abc']])
    await closeAll(stream)
  })

  it('stops intermediate ticks after three rejected ticks in a row', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('a')
    await flush()
    for (const text of ['ab', 'abc', 'abcd']) {
      driver.failures.tick.push(new PlatformError('invalid', 'bad'))
      stream.update(text)
      await advance(3000)
    }
    stream.update('abcde')
    await advance(3000)
    // Three rejections in a row mean the content cannot be streamed at all; close still publishes.
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
    await closeAll(stream)
    expect(driver.calls.at(-1)).toMatchObject({ op: 'close', text: 'abcde' })
  })

  it('open failure fails done', async () => {
    const driver = fakeDriver('patch')
    driver.failures.open.push(new PlatformError('permission', 'no card permission'))
    const stream = createMessageStream(fakeHost(driver))
    stream.update('a')
    await flush()
    expect(stream.state).toBe('failed')
    await expect(stream.done).rejects.toMatchObject({ kind: 'permission' })
    stream.update('ignored')
    await expect(stream.close('x')).rejects.toMatchObject({ kind: 'permission' })
  })

  it('open is retried for retryable unpublished errors; exhausting attempts fails the stream', async () => {
    const driver = fakeDriver('patch')
    const err = () => new PlatformError('retryable', 'timeout', { published: 'no' })
    driver.failures.open.push(err())
    const stream = createMessageStream(fakeHost(driver), { attempts: 2 })
    stream.update('a')
    await advance(500)
    expect(driver.calls).toMatchObject([{ op: 'open', attempt: 2 }])
    await closeAll(stream)

    const d2 = fakeDriver('patch')
    d2.failures.open.push(err(), err())
    const s2 = createMessageStream(fakeHost(d2), { attempts: 2 })
    s2.update('a')
    await advance(500)
    await expect(s2.done).rejects.toMatchObject({ kind: 'retryable', published: 'no' })
  })

  it('open does not retry published:unknown without idempotentSend, and retries it when idempotentSend is true', async () => {
    const d1 = fakeDriver('patch')
    d1.failures.open.push(new PlatformError('retryable', 'lost response', { published: 'unknown' }))
    const s1 = createMessageStream(fakeHost(d1), { attempts: 2, firstDelayMs: 0 })
    s1.update('a')
    await advance(500)
    expect(d1.calls).toEqual([])
    expect(d1.failures.open).toEqual([])
    await expect(s1.done).rejects.toMatchObject({ kind: 'retryable', published: 'unknown' })

    const d2 = fakeDriver('patch')
    d2.failures.open.push(new PlatformError('retryable', 'lost response', { published: 'unknown' }))
    const h2 = { ...fakeHost(d2), idempotentSend: () => true }
    const s2 = createMessageStream(h2, { attempts: 2, firstDelayMs: 0, idempotencyKey: 'k-1' })
    s2.update('a')
    await advance(500)
    expect(d2.calls).toMatchObject([{ op: 'open', attempt: 2 }])
    await closeAll(s2)

    // If an earlier open attempt had published:unknown and the retry hits StreamLimitError (e.g. exhausted passive
    // budget), the stream must fail as published:unknown rather than falling back to plain host.send().
    const d3 = fakeDriver('patch')
    d3.failures.open.push(
      new PlatformError('retryable', 'lost response', { published: 'unknown' }),
      new StreamLimitError({ kind: 'budget', message: 'no passive reply left' }),
    )
    const h3 = { ...fakeHost(d3), idempotentSend: () => true }
    const s3 = createMessageStream(h3, { attempts: 2, firstDelayMs: 0, idempotencyKey: 'k-2' })
    s3.update('a')
    await advance(500)
    await expect(s3.done).rejects.toMatchObject({ published: 'unknown' })
    await expect(s3.close('final')).rejects.toMatchObject({ published: 'unknown' })
    expect(h3.sends).toEqual([])
  })

  it('close failure fails done', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver))
    stream.update('a')
    await flush()
    driver.failures.close.push(new PlatformError('fatal', 'boom'))
    await expect(closeAll(stream)).rejects.toMatchObject({ kind: 'fatal' })
    expect(stream.state).toBe('failed')
  })

  it('close interrupts a sleeping intermediate retry instead of waiting for it', async () => {
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 300 })
    stream.update('a')
    await flush()
    driver.failures.tick.push(new PlatformError('rate-limit', '429', { retryAfterMs: 60_000 }))
    stream.update('ab')
    await advance(300)
    const done = stream.close('abc')
    await advance(10)
    await done
    expect(driver.calls.map(c => [c.op, c.text])).toEqual([['open', 'a'], ['close', 'abc']])
  })
})

describe('edit strategy and budget', () => {
  function editAdapter() {
    const sent: unknown[] = []
    const edited: unknown[] = []
    return {
      sent,
      edited,
      adapter: {
        id: 'lark:app',
        async sendPayload(payload: unknown): Promise<SentPart> {
          sent.push(payload)
          return { id: 'om_1', kind: 'post', time: 0 }
        },
        async editPayload(_part: SentPart, payload: unknown) {
          edited.push(payload)
        },
      },
    }
  }

  it('keeps one edit for close: ≤ limit - 1 intermediate edits, close uses the last', async () => {
    const { adapter, sent, edited } = editAdapter()
    const host = fakeHost(createEditDriver<FakeTypes>(adapter, { limit: 5, state: part => ({ kind: part.kind }) }))
    const stream = createMessageStream(host, { intervalMs: 300 })
    expect(stream.strategy).toBe('edit')
    let text = ''
    for (let t = 0; t < 20_000; t += 100) {
      stream.update(text += 'x')
      await advance(100)
    }
    expect(sent).toHaveLength(1)
    expect(edited).toHaveLength(4)
    expect(stream.handle!.edits).toBe(4)
    expect(stream.handle!.state).toEqual({ kind: 'post' })
    const result = await closeAll(stream)
    expect(edited).toHaveLength(5)
    expect(edited.at(-1)).toEqual({ text })
    expect(result.handle.edits).toBe(5)
    expect(textOf(result.handle.content)).toBe(text)
    expect(host.sends).toEqual([])
    expect(host.recalls).toEqual([])
  })

  it('close skips the request when the final state is already shown', async () => {
    const { adapter, edited } = editAdapter()
    const stream = createMessageStream(fakeHost(createEditDriver<FakeTypes>(adapter, { limit: 20 })), { firstDelayMs: 0 })
    stream.update('done')
    await flush()
    await closeAll(stream)
    expect(edited).toEqual([])
  })

  it('stretches the interval so the budget lasts maxDurationMs', async () => {
    const driver = fakeDriver('edit')
    driver.updatesLeft = 11 // 10 usable before close
    const orig = driver.tick
    driver.tick = async (handle, change, ctx) => {
      await orig(handle, change, ctx)
      driver.updatesLeft!--
    }
    const stream = createMessageStream(fakeHost(driver), { intervalMs: 100, firstDelayMs: 0, maxDurationMs: 10_000 })
    let text = ''
    for (let t = 0; t < 10_000; t += 50) {
      stream.update(text += 'x')
      await advance(50)
    }
    const ticks = driver.calls.filter(c => c.op === 'tick')
    expect(ticks.length).toBeLessThanOrEqual(10)
    expect(ticks[1]!.at - ticks[0]!.at).toBeGreaterThanOrEqual(900)
    await closeAll(stream)
  })

  it('an exhausted budget at close resolves by recall + resend', async () => {
    const driver = fakeDriver('edit')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { firstDelayMs: 0, idempotencyKey: 'op1' })
    stream.update('a')
    await flush()
    driver.updatesLeft = 0
    const result = await closeAll(stream, 'final')
    expect(host.recalls).toHaveLength(1)
    expect(host.sends).toMatchObject([{ text: 'final', options: { idempotencyKey: 'op1:resend' } }])
    expect(stream.handle).toBe(result.handle)
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
  })

  it('a platform `limit` error at close resolves by recall + resend', async () => {
    const driver = fakeDriver('edit')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { firstDelayMs: 0 })
    stream.update('a')
    await flush()
    driver.failures.close.push(new PlatformError('limit', 'edit count exceeded'))
    await closeAll(stream, 'final')
    expect(host.recalls).toHaveLength(1)
    expect(host.sends.map(s => s.text)).toEqual(['final'])
  })

  it('a driver budget violation during the stream pauses ticks and resolves at close', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { intervalMs: 300 })
    stream.update('a')
    await flush()
    driver.failures.tick.push(new StreamLimitError({ kind: 'budget', message: 'window closed' }))
    stream.update('ab')
    await advance(300)
    stream.update('abc')
    await advance(3000)
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
    expect(stream.state).toBe('open')
    await closeAll(stream)
    expect(host.recalls).toHaveLength(1)
    expect(host.sends.map(s => s.text)).toEqual(['abc'])
  })
})

describe('append strategy and recall-and-resend', () => {
  it('sends only prefix extensions; a non-prefix change buffers and resolves by recall + resend at close', async () => {
    const driver = fakeDriver('append')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { intervalMs: 300 })
    stream.update('Hel')
    await flush()
    stream.update('Hello')
    await advance(300)
    stream.update('Goodbye') // non-prefix
    await advance(300)
    stream.update('Goodbye!')
    await advance(3000)
    expect(driver.calls).toMatchObject([
      { op: 'open', text: 'Hel' },
      { op: 'tick', text: 'Hello', patches: [{ append: 'lo' }] },
    ])
    const result = await closeAll(stream)
    expect(host.recalls.map(h => h.parts[0]!.id)).toEqual(['m1'])
    expect(host.sends.map(s => s.text)).toEqual(['Goodbye!'])
    expect(result.handle.parts[0]!.id).toBe('s1')
    expect(driver.calls.map(c => c.op)).toEqual(['open', 'tick'])
  })

  it('a non-prefix final state is detected at close as well', async () => {
    const driver = fakeDriver('append')
    const host = fakeHost(driver)
    const stream = createMessageStream(host)
    stream.update('abc')
    await flush()
    await closeAll(stream, 'xyz')
    expect(host.recalls).toHaveLength(1)
    expect(host.sends.map(s => s.text)).toEqual(['xyz'])
  })

  it('shape violation + recall impossible ⇒ settle the stream, then send the final state as a new message', async () => {
    const driver = fakeDriver('append')
    const host = fakeHost(driver)
    host.canRecall = false
    const stream = createMessageStream(host)
    stream.update('abc')
    await flush()
    // The final state does not extend what the chat shows and the platform refuses to delete a streamed message. The
    // partial is closed where it stands, so it stops generating, and the final state follows as a fresh message.
    const result = await closeAll(stream, 'xyz')
    expect(driver.calls.map(c => [c.op, c.text])).toEqual([['open', 'abc'], ['close', 'abc']])
    expect(host.sends.map(s => s.text)).toEqual(['xyz'])
    expect(result.handle.parts[0]!.id).toBe('s1')
  })

  it('a closed streaming window closes in place: the final state is a full update of the same message', async () => {
    const driver = fakeDriver('append')
    const host = fakeHost(driver)
    host.canRecall = false
    const stream = createMessageStream(host)
    stream.update('abc')
    await flush()
    // What expires is the platform's streaming mode, not the message: `close` publishes the same full update `tick`
    // already publishes after the window, so the reader keeps the message instead of being handed a second one.
    driver.until = 1
    await advance(10)
    stream.update('abcdef')
    await advance(1000)
    const result = await closeAll(stream, 'abcdefgh')
    expect(driver.calls.map(c => [c.op, c.text])).toEqual([['open', 'abc'], ['close', 'abcdefgh']])
    expect(host.sends).toHaveLength(0)
    expect(host.recalls).toHaveLength(0)
    expect(result.handle.parts[0]!.id).toBe('m1')
  })

  it('a closed streaming window whose final update the platform refuses still resolves by recall + resend', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { firstDelayMs: 0 })
    stream.update('a')
    await flush()
    driver.until = 1
    await advance(10)
    driver.failures.close.push(new Error('the card entity expired'))
    await closeAll(stream, 'final')
    expect(driver.failures.close).toHaveLength(0) // the close was attempted before falling back
    expect(host.recalls).toHaveLength(1)
    expect(host.sends.map(s => s.text)).toEqual(['final'])
  })

  it('a driver-detected shape violation (mode without diff) resolves the same way', async () => {
    const driver = fakeDriver('append')
    const host = fakeHost(driver, fakeMode({ diff: false }))
    const stream = createMessageStream(host, { intervalMs: 300 })
    stream.update('abc')
    await flush()
    driver.failures.tick.push(new StreamLimitError({ kind: 'shape', message: 'not a prefix' }))
    stream.update('xbc')
    await advance(300)
    await closeAll(stream)
    expect(host.recalls).toHaveLength(1)
    expect(host.sends.map(s => s.text)).toEqual(['xbc'])
  })
})

describe('size violations', () => {
  it('intermediate oversize states are skipped; an oversize final recalls then fails with StreamLimitError', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver, fakeMode({ maxChars: 5 }))
    const stream = createMessageStream(host, { intervalMs: 300 })
    stream.update('abc')
    await flush()
    stream.update('abcdefgh')
    await advance(1000)
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
    const done = closeAll(stream, 'abcdefghij')
    const error = await done.then(() => undefined as never, (e: unknown) => e as StreamLimitError)
    expect(error).toBeInstanceOf(StreamLimitError)
    expect(error.violation).toMatchObject({ kind: 'size', key: 'limit.text.chars', limit: 5, actual: 10, part: 0 })
    expect(error.handle?.parts[0]!.id).toBe('m1')
    expect(host.recalls).toHaveLength(1)
    expect(host.sends).toEqual([])
    expect(stream.state).toBe('failed')
  })

  it('a final that shrank back within limits is published normally', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver, fakeMode({ maxChars: 5 }))
    const stream = createMessageStream(host, { intervalMs: 300 })
    stream.update('abc')
    await flush()
    stream.update('abcdefgh')
    await advance(1000)
    await closeAll(stream, 'ab…')
    expect(driver.calls.map(c => [c.op, c.text])).toEqual([['open', 'abc'], ['close', 'ab…']])
    expect(host.recalls).toEqual([])
  })

  it('a driver size violation at close recalls then fails', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host)
    stream.update('abc')
    await flush()
    const violation: LimitViolation = { kind: 'size', key: 'limit.payload.bytes', message: 'card too large' }
    driver.failures.close.push(new StreamLimitError(violation))
    await expect(closeAll(stream)).rejects.toMatchObject({ violation })
    expect(host.recalls).toHaveLength(1)
  })

  it('a multi-part final state is recalled and resent as a plain (multi-part) message', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host, { intervalMs: 300 })
    stream.update('text')
    await flush()
    stream.update('text|image') // needs two platform messages: not streamed
    await advance(1000)
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
    await closeAll(stream)
    expect(host.recalls).toHaveLength(1)
    expect(host.sends.map(s => s.text)).toEqual(['text|image'])
  })
})

describe('abort', () => {
  it('abort with recall recalls the message and rejects done with AbortError', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host)
    stream.update('a')
    await flush()
    expect(await stream.abort({ recall: true, reason: 'empty answer' })).toBe(true)
    expect(stream.handle).toBeUndefined()
    expect(host.recalls).toHaveLength(1)
    expect(stream.state).toBe('closed')
    await expect(stream.done).rejects.toBeInstanceOf(StreamAbortError)
    await expect(stream.done).rejects.toMatchObject({ name: 'AbortError', reason: 'empty answer', recalled: true })
    stream.update('ignored')
    await advance(1000)
    expect(driver.calls.map(c => c.op)).toEqual(['open'])
  })

  it('abort without recall ends platform streaming on the shown state', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    const stream = createMessageStream(host)
    stream.update('a')
    await flush()
    stream.update('ab')
    expect(await stream.abort()).toBe(false)
    expect(host.recalls).toEqual([])
    expect(driver.calls.map(c => [c.op, c.text])).toEqual([['open', 'a'], ['close', 'a']])
  })

  it('abort reports a recall the platform refused', async () => {
    const driver = fakeDriver('patch')
    const host = fakeHost(driver)
    host.canRecall = false
    const stream = createMessageStream(host)
    stream.update('a')
    await flush()
    expect(await stream.abort({ recall: true })).toBe(false)
    expect(host.recalls).toHaveLength(1)
    expect(stream.state).toBe('closed')
  })

  it('abort during an in-flight open waits for the handle and recalls it', async () => {
    const driver = fakeDriver('patch')
    driver.latency.open = 500
    const host = fakeHost(driver)
    const stream = createMessageStream(host)
    stream.update('a')
    await flush()
    const aborted = stream.abort({ recall: true })
    await advance(500)
    await aborted
    expect(host.recalls.map(h => h.parts[0]!.id)).toEqual(['m1'])
    await expect(stream.done).rejects.toBeInstanceOf(StreamAbortError)
  })

  it('abort before anything was published only rejects done', async () => {
    const host = fakeHost(undefined)
    const stream = createMessageStream(host)
    stream.update('a')
    await stream.abort({ recall: true })
    expect(host.recalls).toEqual([])
    expect(host.sends).toEqual([])
    await expect(stream.done).rejects.toBeInstanceOf(StreamAbortError)
  })

  it('the SendOptions signal aborts the stream', async () => {
    const controller = new AbortController()
    const driver = fakeDriver('patch')
    const stream = createMessageStream(fakeHost(driver), { signal: controller.signal } satisfies StreamOptions)
    stream.update('a')
    await flush()
    controller.abort()
    await advance(10)
    await expect(stream.done).rejects.toBeInstanceOf(StreamAbortError)
    expect(stream.state).toBe('closed')
  })

  it('abort after close is a no-op', async () => {
    const host = fakeHost(undefined)
    const stream = createMessageStream(host)
    const result = await closeAll(stream, 'x')
    await stream.abort({ recall: true })
    expect(host.recalls).toEqual([])
    await expect(stream.done).resolves.toBe(result)
  })

  it('aborts an in-flight createEditDriver.open via ctx.options.signal when stream.abort() is called', async () => {
    let seenSignal: AbortSignal | undefined
    const adapter: EditDriverAdapter = {
      id: 'b',
      sendPayload: (_payload, _target, opts) => new Promise((_resolve, reject) => {
        seenSignal = opts.options?.signal
        seenSignal?.addEventListener('abort', () => reject(seenSignal?.reason), { once: true })
      }),
      editPayload: async () => {},
    }
    const stream = createMessageStream(fakeHost(createEditDriver<FakeTypes>(adapter, { limit: 5 })), { firstDelayMs: 0 })
    stream.update('hello')
    await flush()
    expect(seenSignal).toBeDefined()
    expect(seenSignal?.aborted).toBe(false)
    await stream.abort()
    expect(seenSignal?.aborted).toBe(true)
    await expect(stream.done).rejects.toBeInstanceOf(StreamAbortError)
  })

  it('invalidates the published cache on a failed edit so close still writes back the earlier payload', async () => {
    const edits: unknown[] = []
    let failNext = true
    const adapter: EditDriverAdapter = {
      id: 'b',
      sendPayload: async () => ({ id: 'm1', kind: 'card', time: 1 }),
      editPayload: async (_part, payload) => {
        edits.push(payload)
        if (failNext) {
          failNext = false
          throw new PlatformError('invalid', 'rejected after unknown state')
        }
      },
    }
    const stream = createMessageStream(fakeHost(createEditDriver<FakeTypes>(adapter, { limit: 5 })), {
      firstDelayMs: 0,
      intervalMs: 100,
    })
    stream.update('A')
    await flush()
    stream.update('B')
    await advance(100)
    await closeAll(stream, 'A')
    expect(edits).toEqual([{ text: 'B' }, { text: 'A' }])
  })

  it('aborts an in-flight createEditDriver.tick editPayload when stream.abort() is called', async () => {
    let editSignal: AbortSignal | undefined
    const adapter: EditDriverAdapter = {
      id: 'b',
      sendPayload: async () => ({ id: 'm1', kind: 'card', time: 1 }),
      editPayload: (_part, _payload, _handle, signal) => new Promise((_resolve, reject) => {
        editSignal = signal
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    }
    const stream = createMessageStream(fakeHost(createEditDriver<FakeTypes>(adapter, { limit: 5 })), {
      firstDelayMs: 0,
      intervalMs: 100,
    })
    stream.update('A')
    await flush()
    stream.update('B')
    await advance(100)
    expect(editSignal).toBeDefined()
    expect(editSignal?.aborted).toBe(false)
    await stream.abort({ recall: true })
    expect(editSignal?.aborted).toBe(true)
    await expect(stream.done).rejects.toBeInstanceOf(StreamAbortError)
  })

  it('detaches the caller AbortSignal listener when the stream closes or fails', async () => {
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const stream = createMessageStream(fakeHost(undefined), { signal: controller.signal })
    await closeAll(stream, 'done')
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))

    const controller2 = new AbortController()
    const removeSpy2 = vi.spyOn(controller2.signal, 'removeEventListener')
    const host2 = fakeHost(undefined)
    host2.send = async () => { throw new PlatformError('invalid', 'bad') }
    const stream2 = createMessageStream(host2, { signal: controller2.signal })
    await expect(closeAll(stream2, 'x')).rejects.toThrow('bad')
    expect(removeSpy2).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
