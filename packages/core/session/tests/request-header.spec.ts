/** Request-header canonicalization, equality, snapshot folding, and format rejection. */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq, canonicalHeader, foldRequestHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const CONFIG = { provider: 'mock', model: 'm' }

function tool(name: string, description = 'd'): ToolSchema {
  return { name, description, parameters: { type: 'object' } }
}

describe('canonicalHeader', () => {
  it('normalizes empty optional fields to absence and preserves populated fields', () => {
    expect(canonicalHeader({
      config: CONFIG,
      adapterDefaults: {},
      system: '',
      tools: [],
    })).toEqual({ config: CONFIG })
    const full = canonicalHeader({
      config: { ...CONFIG, maxTokens: 256_000 },
      adapterDefaults: { maxTokens: true },
      system: 's',
      tools: [tool('a')],
    })
    expect(full).toEqual({
      config: { ...CONFIG, maxTokens: 256_000 },
      adapterDefaults: { maxTokens: true },
      system: 's',
      tools: [tool('a')],
    })
  })
})

describe('headerEquals', () => {
  const base = canonicalHeader({ config: CONFIG, system: 's', tools: [tool('a')] })

  it('compares every canonical field and preserves tool order', () => {
    expect(headerEquals(base, structuredClone(base))).toBe(true)
    expect(headerEquals(base, { ...base, config: { provider: 'mock', model: 'other' } })).toBe(false)
    expect(headerEquals(base, {
      ...base,
      config: { ...base.config, reasoningEffort: ReasoningEffortId('high') },
    })).toBe(false)
    expect(headerEquals(
      { ...base, config: { ...base.config, maxTokens: 256_000 } },
      {
        ...base,
        config: { ...base.config, maxTokens: 256_000 },
        adapterDefaults: { maxTokens: true },
      },
    )).toBe(false)
    expect(headerEquals(base, { ...base, system: 'other' })).toBe(false)
    expect(headerEquals(base, { ...base, tools: [] })).toBe(false)
    expect(headerEquals(base, { ...base, tools: [tool('a', 'changed')] })).toBe(false)
    expect(headerEquals({ config: CONFIG, tools: [tool('a'), tool('b')] }, { config: CONFIG, tools: [tool('b'), tool('a')] })).toBe(false)
  })

  it('treats absent and empty tool arrays as equivalent canonical absence', () => {
    expect(headerEquals({ config: CONFIG }, { config: CONFIG, tools: [] })).toBe(true)
  })
})

describe('foldRequestHeader', () => {
  it('returns the supplied baseline when no snapshot follows', () => {
    const from: EpochHeader = { config: CONFIG, system: 'baseline' }
    const unrelated: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ]
    expect(foldRequestHeader(unrelated)).toBeUndefined()
    expect(foldRequestHeader(unrelated, from)).toBe(from)
  })

  it('takes the latest full snapshot and skips unrelated events', () => {
    const session = Session.create(SessionId('fold'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: CONFIG, system: 'first' }, reason: 'initial' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'other' }, tools: [] }, reason: 'change' })
    expect(foldRequestHeader(session.snapshotEvents())).toEqual({ config: { provider: 'mock', model: 'other' } })
  })
})

describe('legacy request-header format', () => {
  it('rejects request/header-delta in seeds and untyped appends', () => {
    const legacy = [{
      type: 'request/header-delta', seq: 0, time: 1, data: { config: CONFIG },
    }] as unknown as SessionEvent[]
    expect(() => Session.create(SessionId('legacy'), legacy)).toThrow(/unsupported legacy request\/header-delta/)

    const session = Session.create(SessionId('legacy-append-delta'))
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent
    expect(() => appendLegacy('request/header-delta', { config: CONFIG }))
      .toThrow(/unsupported legacy request\/header-delta/)
    expect(session.snapshotEvents()).toHaveLength(0)
  })

  it('rejects the removed fallback reason in seeds and untyped appends', () => {
    const legacy = [{
      type: 'request/header', seq: 0, time: 1, data: { header: { config: CONFIG }, reason: 'fallback' },
    }] as unknown as SessionEvent[]
    expect(() => Session.create(SessionId('legacy-seed-reason'), legacy))
      .toThrow('unsupported legacy request/header reason "fallback"')

    const session = Session.create(SessionId('legacy-append-reason'))
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent
    expect(() => appendLegacy('request/header', { header: { config: CONFIG }, reason: 'fallback' }))
      .toThrow('unsupported legacy request/header reason "fallback"')
    expect(session.snapshotEvents()).toHaveLength(0)
  })
})

describe('Session.requestContext', () => {
  const CAPACITY = { provider: 'mock', model: 'm', contextWindow: 128_000 }

  /** A turn-enclosed capacity record; the invariant rejects one outside a turn. */
  function seedWith(...records: { provider: string; model: string; contextWindow?: number }[]): SessionEvent[] {
    const events: SessionEvent[] = [{
      type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 },
    }]
    for (const data of records) {
      events.push({ type: 'request/context', seq: SessionSeq(events.length), time: 1, data })
    }
    return events
  }

  it('reads undefined before any record exists', () => {
    expect(Session.create(SessionId('no-capacity')).requestContext()).toBeUndefined()
  })

  it('folds a seeded log on first read, taking the last record', () => {
    // The fold watermark starts at 0 with the seed already in the log, so the
    // first read must consume the whole seed rather than skip it.
    const session = Session.create(SessionId('seeded-capacity'), seedWith(
      CAPACITY,
      { ...CAPACITY, model: 'later', contextWindow: 256_000 },
    ))
    expect(session.requestContext()).toEqual({ provider: 'mock', model: 'later', contextWindow: 256_000 })
  })

  it('advances incrementally across appends and skips unrelated events', () => {
    const session = Session.create(SessionId('incremental-capacity'), seedWith(CAPACITY))
    expect(session.requestContext()).toEqual(CAPACITY)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(session.requestContext()).toEqual(CAPACITY)
    session.append('request/context', { ...CAPACITY, model: 'next', contextWindow: 64_000 })
    expect(session.requestContext()).toEqual({ provider: 'mock', model: 'next', contextWindow: 64_000 })
    session.append('request/context', { provider: 'mock', model: 'unknown' })
    expect(session.requestContext()).toEqual({ provider: 'mock', model: 'unknown' })
  })

  it('folds a batch appended between two reads', () => {
    const session = Session.create(SessionId('batched-capacity'), seedWith(CAPACITY))
    expect(session.requestContext()).toEqual(CAPACITY)
    session.append('request/context', { ...CAPACITY, contextWindow: 200_000 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/context', { ...CAPACITY, contextWindow: 300_000 })
    expect(session.requestContext()?.contextWindow).toBe(300_000)
  })

  it('exposes a frozen record so a reader cannot desync later comparisons', () => {
    const session = Session.create(SessionId('frozen-capacity'), seedWith(CAPACITY))
    const held = session.requestContext()
    if (held === undefined) throw new Error('expected a folded capacity record')
    expect(Object.isFrozen(held)).toBe(true)
    expect(() => { (held as { contextWindow?: number }).contextWindow = 1 }).toThrow()
  })
})
