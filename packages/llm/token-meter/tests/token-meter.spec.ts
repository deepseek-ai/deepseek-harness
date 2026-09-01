import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, createMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement, TokenMeterConfig } from '@deepseek-ai/dsh-token-meter'

function header(model: string, extras: Omit<EpochHeader, 'config'> = {}): EpochHeader {
  return canonicalHeader({ config: { provider: 'mock', model }, ...extras })
}

function textMessage(text: string, role: Message['role'] = 'user'): Message {
  return createMessage({
    role,
    content: [{ type: 'text', text }],
    source: role === 'assistant'
      ? { kind: 'model', provider: 'mock', model: 'mock' }
      : { kind: 'user' },
  })
}

function appendHeader(session: Session, value: EpochHeader): void {
  session.append('request/header', { header: value, reason: 'initial' })
}

/** Inject malformed persisted history after the live append boundary for defensive replay tests. */
function appendUnchecked(session: Session, event: SessionEvent): void {
  const log = (session as unknown as { log: SessionEvent[] }).log
  log.push(event)
}

interface SuccessfulCallOptions {
  turn?: number
  step?: number
  providerText?: string
  durableText?: string
  usage?: TokenUsage
  provenance?: 'exact' | 'empty' | 'absent'
}

function appendSuccessfulCall(
  session: Session,
  value: EpochHeader,
  options: SuccessfulCallOptions = {},
): void {
  const turn = options.turn ?? 1
  const step = options.step ?? 1
  const providerText = options.providerText ?? 'provider answer'
  const durableText = options.durableText ?? providerText
  const provenance = options.provenance ?? 'exact'
  session.append('step/start', { turn, step })
  appendHeader(session, value)

  const sources: number[] = []
  if (provenance === 'exact') {
    const chunks = [
      { type: 'block-start' as const, index: 0, blockType: 'text' as const },
      { type: 'text-delta' as const, index: 0, text: providerText },
      { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: providerText } },
      ...options.usage === undefined ? [] : [{ type: 'usage' as const, usage: options.usage }],
      { type: 'finish' as const, reason: { kind: 'stop' as const } },
    ]
    for (const chunk of chunks) {
      sources.push(session.append('assistant/chunk', { turn, step, chunk }).seq)
    }
  }

  const intent = provenance === 'absent'
    ? { surfaceOp: 'append' as const }
    : { surfaceOp: 'append' as const, sourceEventSeqs: provenance === 'empty' ? [] : sources }
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: durableText.length === 0 ? [] : [{ type: 'text', text: durableText }],
      source: {
        kind: 'model',
        ...{
          provider: value.config.provider,
          model: value.config.model,
        },
      },
    }),
    ...options.usage === undefined ? {} : { usage: options.usage },
  }, intent)
  session.append('step/end', { turn, step })
}

function meter(config: TokenMeterConfig = {}): TokenMeter {
  const ctx = new Context()
  // The registry is a required injection of the service (its three projection
  // units register in the constructor); mount it synchronously.
  new SessionProjectionRegistry(ctx)
  return new TokenMeter(ctx, config)
}

function expectSurfaceTotal(measurement: TokenMeasurement): void {
  expect(measurement.nodes.reduce((total, node) => total + node.tokens, 0))
    .toBe(measurement.surfaceTokens)
}

describe('TokenMeter configuration and registration', () => {
  it('exposes an empty public configuration type', () => {
    expectTypeOf<{}>().toExtend<TokenMeterConfig>()
    expectTypeOf<{ contextWindow: number }>().not.toExtend<TokenMeterConfig>()
  })

  it.each(['models', 'contextWindow', 'contextWidow'])(
    'rejects stale or unknown top-level config key %s',
    (key) => {
      expect(() => meter({ [key]: {} } as unknown as TokenMeterConfig))
        .toThrow(`TokenMeterConfig: unknown key "${key}"`)
    },
  )

  it('registers and unregisters ctx.tokenMeter with its plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(TokenMeter)
    expect(ctx.get('tokenMeter')).toBeInstanceOf(TokenMeter)
    await fiber.dispose()
    expect(ctx.get('tokenMeter')).toBeUndefined()
  })
})

describe('TokenMeter pricing', () => {
  it('prices every built-in content shape and merge-extended blocks with one fixed heuristic', () => {
    const service = meter()
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'abcd' },
      { type: 'reasoning', text: 'ab' },
      { type: 'tool-call', id: ToolCallId('c'), name: 'read', arguments: '{"x":1}' },
      {
        type: 'tool-result',
        toolCallId: ToolCallId('c'),
        content: [{ type: 'text', text: 'xy' }],
        isError: false,
      },
      { type: 'future-block', payload: 'abcd' } as unknown as ContentBlock,
    ]
    const estimated = service.estimateMessage(createMessage({
      role: 'assistant', content: blocks,
      source: { kind: 'plugin', plugin: 'test' },
    }))
    expect(estimated).toBeGreaterThan(30)
    expect(service.estimateMessage(textMessage('abcd'))).toBe(9)
  })

  it('returns a detached deeply immutable empty measurement', () => {
    const service = meter()
    const session = Session.create(SessionId('empty'))
    const result = service.measure(session)
    expect(result).toEqual({
      logRevision: 0,
      baseline: { kind: 'none', tokens: 0 },
      surfaceDeltaTokens: 0,
      totalTokens: 0,
      surfaceTokens: 0,
      nodes: [],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.baseline)).toBe(true)
    expect(Object.isFrozen(result.nodes)).toBe(true)
    expectSurfaceTotal(result)
    expect(() => {
      ;(result as { totalTokens: number }).totalTokens = 1
    }).toThrow(TypeError)
  })

  it('keeps an earlier unified snapshot detached from later replay', () => {
    const service = meter()
    const session = Session.create(SessionId('detached'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const snapshot = service.measure(session)
    const snapshotCopy = structuredClone(snapshot)
    expect(Object.isFrozen(snapshot.nodes)).toBe(true)
    expect(Object.isFrozen(snapshot.nodes[0])).toBe(true)
    expectSurfaceTotal(snapshot)
    expect(() => {
      ;(snapshot.nodes as Array<{ seq: number; tokens: number; heuristicTokens: number }>)
        .push({ seq: 99, tokens: 1, heuristicTokens: 1 })
    }).toThrow(TypeError)
    expect(() => {
      ;(snapshot.nodes[0] as { seq: number; tokens: number }).tokens = 1
    }).toThrow(TypeError)

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const advanced = service.measure(session)
    expect(advanced.logRevision).toBe(2)
    expect(advanced.nodes).toHaveLength(2)
    expectSurfaceTotal(advanced)
    expect(snapshot).toEqual(snapshotCopy)
    expect(snapshot.logRevision).toBe(1)
    expect(snapshot.nodes).toHaveLength(1)
  })

  it('prices header, tools, and surface when no reusable usage exists', () => {
    const service = meter()
    const session = Session.create(SessionId('heuristic'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendHeader(session, header('deepseek-v4-flash', {
      system: 'system',
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    }))
    const result = service.measure(session)
    expect(result.baseline.kind).toBe('estimated')
    expect(result.totalTokens).toBeGreaterThan(result.surfaceTokens)
    expect(result.logRevision).toBe(session.snapshotEvents().length)
    expectSurfaceTotal(result)
  })

  it('keeps request-header overrides out of the returned surface', () => {
    const service = meter()
    const session = Session.create(SessionId('override-surface'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const logged = service.measure(session)
    const overridden = service.measure(session, header('another-model', {
      system: 'large override '.repeat(100),
    }))
    expect(overridden.totalTokens).toBeGreaterThan(logged.totalTokens)
    expect(overridden.surfaceTokens).toBe(logged.surfaceTokens)
    expect(overridden.nodes).toEqual(logged.nodes)
    expectSurfaceTotal(overridden)
  })
})

describe('replay anchors and surface folds', () => {
  const USAGE: TokenUsage = {
    inputTokens: 20,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    outputTokens: 7,
    reasoningTokens: 6,
  }

  it('uses disjoint provider usage and signed durable-output rewrites', () => {
    const service = meter()
    const session = Session.create(SessionId('usage'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'before' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendSuccessfulCall(session, header('deepseek-v4-flash'), {
      providerText: 'short',
      durableText: 'a much longer rewritten durable assistant answer',
      usage: USAGE,
    })
    const result = service.measure(session)
    expect(result.baseline).toMatchObject({ kind: 'usage', tokens: 34, usage: USAGE })
    expect(result.surfaceDeltaTokens).toBeGreaterThan(0)
    expect(result.totalTokens).toBe(34 + result.surfaceDeltaTokens)
    expect(() => {
      ;((result.baseline as { usage: { inputTokens: number } }).usage.inputTokens) = 1
    }).toThrow(TypeError)
  })

  it('selects a heuristic anchor when provider usage would undercut its scale', () => {
    const service = meter()
    const session = Session.create(SessionId('low-usage-anchor'))
    const system = 'system context'
    const requestHeader = header('deepseek-v4-flash', { system })
    appendSuccessfulCall(session, requestHeader, {
      providerText: 'abcd'.repeat(512),
      usage: { inputTokens: 20, outputTokens: 7 },
    })

    const anchored = service.measure(session)
    expect(anchored.baseline.kind).toBe('estimated')
    const assistant = anchored.nodes[0]!.seq
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'short' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: assistant, end: assistant },
      sourceEventSeqs: [assistant],
    })

    const shrunken = service.measure(session)
    expect(27 + shrunken.surfaceDeltaTokens).toBeLessThan(0)
    expect(shrunken.totalTokens).toBeGreaterThan(0)
    expect(shrunken.totalTokens).toBe(service.measure(
      session,
      header('different-model', { system }),
    ).totalTokens)
  })

  it('uses an estimated anchor when provider usage is absent', () => {
    const service = meter()
    const session = Session.create(SessionId('missing-usage'))
    appendSuccessfulCall(session, header('deepseek-v4-flash', { system: 's' }), {
      providerText: 'provider',
      durableText: 'rewritten',
    })
    const anchored = service.measure(session)
    expect(anchored.baseline.kind).toBe('estimated')
    expect(anchored.surfaceDeltaTokens).toBe(0)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'later' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const advanced = service.measure(session)
    expect(advanced.surfaceDeltaTokens).toBeGreaterThan(0)
  })

  it('distinguishes an explicit empty source-event list from an absent legacy list', () => {
    const explicit = Session.create(SessionId('explicit-empty'))
    const legacy = Session.create(SessionId('legacy-absent'))
    appendSuccessfulCall(explicit, header('deepseek-v4-flash'), {
      durableText: 'listener injected text',
      providerText: '',
      usage: USAGE,
      provenance: 'empty',
    })
    appendSuccessfulCall(legacy, header('deepseek-v4-flash'), {
      durableText: 'listener injected text',
      providerText: '',
      usage: USAGE,
      provenance: 'absent',
    })
    const service = meter()
    expect(service.measure(explicit).surfaceDeltaTokens).toBeGreaterThan(0)
    expect(service.measure(legacy).surfaceDeltaTokens).toBe(0)
  })

  it('keeps only the latest successful request anchor across model switches', () => {
    const service = meter()
    const session = Session.create(SessionId('switch'))
    const alphaHeader = header('alpha', { system: 'same envelope' })
    appendSuccessfulCall(session, alphaHeader, { usage: USAGE, providerText: 'alpha' })
    expect(service.measure(session).baseline).toMatchObject({ kind: 'usage', tokens: 34 })

    appendSuccessfulCall(session, header('beta'), {
      turn: 1,
      step: 2,
      usage: { inputTokens: 100, outputTokens: 50 },
      providerText: 'beta response',
    })
    expect(service.measure(session).baseline).toMatchObject({ kind: 'usage', tokens: 150 })

    appendHeader(session, alphaHeader)
    const switchedBack = service.measure(session)
    expect(switchedBack.baseline.kind).toBe('estimated')
    expect(switchedBack.surfaceDeltaTokens).toBe(0)
  })

  it('invalidates usage for any canonical envelope change or explicit override', () => {
    const service = meter()
    const session = Session.create(SessionId('envelope'))
    const anchoredHeader = header('deepseek-v4-flash', { system: 'one' })
    appendSuccessfulCall(session, anchoredHeader, { usage: USAGE })
    expect(service.measure(session, { ...anchoredHeader, tools: [] }).baseline.kind).toBe('usage')
    expect(service.measure(session, header('deepseek-v4-flash', { system: 'two' })).baseline.kind)
      .toBe('estimated')
    expect(service.measure(session, header('deepseek-v4-pro', { system: 'one' })).baseline.kind)
      .toBe('estimated')
    expect(service.measure(session, {
      ...anchoredHeader,
      config: { ...anchoredHeader.config, temperature: 0.2 },
    }).baseline.kind).toBe('estimated')
    expect(service.measure(session, {
      ...anchoredHeader,
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    }).baseline.kind).toBe('estimated')
  })

  it('folds the latest full header snapshot into the effective envelope', () => {
    const session = Session.create(SessionId('header-snapshot'))
    appendHeader(session, header('deepseek-v4-flash'))
    session.append('request/header', {
      header: header('deepseek-v4-pro'),
      reason: 'change',
    })
    const result = meter().measure(session)
    expect(result.baseline.kind).toBe('estimated')
    expect(result.logRevision).toBe(2)
  })

  it('replays seeded append and replace operations with signed deltas', () => {
    const service = meter()
    const original = Session.create(SessionId('surface-original'))
    appendSuccessfulCall(original, header('deepseek-v4-flash'), {
      usage: USAGE,
      providerText: 'long provider answer '.repeat(100),
    })
    original.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'new tail' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const seeded = Session.create(SessionId('surface-seeded'), original.snapshotEvents())
    const before = service.measure(seeded)
    expect(before.nodes).toHaveLength(2)
    expect(before.surfaceDeltaTokens).toBeGreaterThan(0)
    expectSurfaceTotal(before)

    const first = seeded.surface.nodes[0]!
    seeded.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: { op: 'replace', start: first, end: first }, sourceEventSeqs: [first] })
    const after = service.measure(seeded)
    expect(after.nodes).toHaveLength(2)
    expect(after.nodes[0]!.seq).toBe(seeded.snapshotEvents().length - 1)
    expect(after.logRevision).toBe(seeded.snapshotEvents().length)
    expect(Object.isFrozen(after.nodes)).toBe(true)
    expect(Object.isFrozen(after.nodes[0])).toBe(true)
    expect(after.surfaceDeltaTokens).toBeLessThan(0)
    expectSurfaceTotal(after)
    expect(before.nodes).toHaveLength(2)
    // The earlier snapshot still reports the log it measured: seed + boundary.
    expect(before.logRevision).toBe(original.snapshotEvents().length + 1)
    expect(before.surfaceDeltaTokens).toBeGreaterThan(0)
  })

  it('prices an empty assistant surface anchor as zero', () => {
    const session = Session.create(SessionId('empty-assistant'))
    appendSuccessfulCall(session, header('deepseek-v4-flash'), {
      providerText: '',
      durableText: '',
      provenance: 'empty',
    })
    const measurement = meter().measure(session)
    const assistant = session.snapshotEvents().find(event => event.type === 'assistant/message')!
    expect(measurement.nodes).toEqual([{ seq: assistant.seq, tokens: 0, heuristicTokens: 0 }])
    expect(measurement.surfaceTokens).toBe(0)
    expectSurfaceTotal(measurement)
  })
})

describe('malformed replay and listener lifecycle', () => {
  function expectRepeatedFailure(service: TokenMeter, session: Session, pattern: RegExp): void {
    expect(() => service.measure(session)).toThrow(pattern)
    expect(() => service.measure(session)).toThrow(pattern)
  }

  it('rejects an assistant without its step boundary transactionally', () => {
    const session = Session.create(SessionId('bad-step'))
    appendHeader(session, header('deepseek-v4-flash'))
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'bad' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'deepseek-v4-flash' },
        },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    expectRepeatedFailure(meter(), session, /no matching step\/start/)
  })

  it('leaves the priced surface uncommitted when a later validation step rejects the event', () => {
    // A valid append plan whose anchor validation throws: only commit
    // ordering keeps the surface from double-counting across retries.
    const session = Session.create(SessionId('bad-step-surface'))
    appendHeader(session, header('deepseek-v4-flash'))
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'planned but never committed' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'deepseek-v4-flash' },
        },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    const service = meter()
    const states = (service as unknown as {
      states: WeakMap<Session, { surface: unknown[] }>
    }).states
    expectRepeatedFailure(service, session, /no matching step\/start/)
    const state = states.get(session)
    expect(state?.surface).toEqual([])
  })

  it('clears completed step boundaries and rejects overlapping or late step events', () => {
    const overlapping = Session.create(SessionId('overlapping-step'))
    overlapping.append('step/start', { turn: 1, step: 1 })
    overlapping.append('step/start', { turn: 1, step: 2 })
    expectRepeatedFailure(
      meter(),
      overlapping,
      /arrived before turn 1\/step 1 ended/,
    )

    const late = Session.create(SessionId('late-assistant'))
    late.append('step/start', { turn: 1, step: 1 })
    appendHeader(late, header('deepseek-v4-flash'))
    late.append('step/end', { turn: 1, step: 1 })
    late.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'deepseek-v4-flash' },
        },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    expectRepeatedFailure(
      meter(),
      late,
      /no matching step\/start/,
    )

    const mismatchedEnd = Session.create(SessionId('mismatched-end'))
    mismatchedEnd.append('step/start', { turn: 1, step: 1 })
    mismatchedEnd.append('step/end', { turn: 1, step: 2 })
    expectRepeatedFailure(
      meter(),
      mismatchedEnd,
      /step\/end .* no matching step\/start/,
    )
  })

  it('rejects invalid assistant source-event references', () => {
    const cases: Array<{
      name: string
      appendSource(session: Session): number[]
      pattern: RegExp
    }> = [
      {
        name: 'non-chunk',
        appendSource(session) {
          return [session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: 'x' }],
            source: { kind: 'user' },
          }), { surfaceOp: 'append' }).seq]
        },
        pattern: /is not assistant\/chunk/,
      },
      {
        name: 'wrong-step',
        appendSource(session) {
          return [session.append('assistant/chunk', {
            turn: 1,
            step: 2,
            chunk: { type: 'finish', reason: { kind: 'stop' } },
          }).seq]
        },
        pattern: /belongs to another step/,
      },
    ]
    for (const testCase of cases) {
      const session = Session.create(SessionId(`bad-source-${testCase.name}`))
      session.append('step/start', { turn: 1, step: 1 })
      appendHeader(session, header('deepseek-v4-flash'))
      const sourceEventSeqs = testCase.appendSource(session)
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'bad' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'deepseek-v4-flash' },
          },
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      }, { surfaceOp: 'append', sourceEventSeqs })
      expect(() => meter().measure(session)).toThrow(testCase.pattern)
    }
  })

  it('rejects repeated and non-earlier assistant source-event references', () => {
    const duplicate = Session.create(SessionId('duplicate-source'))
    duplicate.append('step/start', { turn: 1, step: 1 })
    appendHeader(duplicate, header('deepseek-v4-flash'))
    const source = duplicate.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'finish', reason: { kind: 'stop' } },
    }).seq
    appendUnchecked(duplicate, {
      type: 'assistant/message',
      seq: duplicate.seq,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'deepseek-v4-flash' },
          },
        }),
        usage: { inputTokens: 1, outputTokens: 0 },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [source, source],
    })
    expect(() => meter().measure(duplicate)).toThrow(/repeats source seq/)

    const future = Session.create(SessionId('future-source'))
    future.append('step/start', { turn: 1, step: 1 })
    appendHeader(future, header('deepseek-v4-flash'))
    appendUnchecked(future, {
      type: 'assistant/message',
      seq: future.seq,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'deepseek-v4-flash' },
          },
        }),
        usage: { inputTokens: 1, outputTokens: 0 },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [99],
    })
    expect(() => meter().measure(future)).toThrow(/is not earlier/)
  })

  it('does not partially apply a malformed assistant replacement', () => {
    const session = Session.create(SessionId('transactional-replace'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'head' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendHeader(session, header('deepseek-v4-flash'))
    const head = session.snapshotEvents()[0]!.seq
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'replacement' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'deepseek-v4-flash' },
        },
      }),
    }, { surfaceOp: { op: 'replace', start: head, end: head }, sourceEventSeqs: [head] })
    expectRepeatedFailure(
      meter(),
      session,
      /no matching step\/start/,
    )
  })

  it('rejects corrupt replacement ranges without advancing the replay cursor', () => {
    const session = Session.create(SessionId('bad-replace'))
    const head = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'head' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    appendUnchecked(session, {
      type: 'user/message',
      seq: session.seq,
      time: 0,
      data: createUserMessage({
        content: [{ type: 'text', text: 'bad' }],
        source: { kind: 'user' },
      }),
      surfaceOp: { op: 'replace', start: 99, end: 99 },
      sourceEventSeqs: [head],
    })
    expectRepeatedFailure(meter(), session, /invalid current range/)
  })

  it('handles earlier-reader catch-up, eager observation, and service reload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    let activeMeter: TokenMeter | undefined
    const revisions: number[] = []
    ctx.on('session/event', (session) => {
      if (activeMeter !== undefined) revisions.push(activeMeter.measure(session).logRevision)
    })
    const firstFiber = await ctx.plugin(TokenMeter)
    activeMeter = ctx.tokenMeter
    const session = ctx.sessions.create(SessionId('listener-order'), { seed: [{
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }] })
    activeMeter.measure(session)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'one' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // Seed, end-seed, then one live append. Only the last event published:
    // end-seed predates store attachment, like the seed.
    expect(revisions).toEqual([3])
    expect(activeMeter.measure(session).logRevision).toBe(3)

    await firstFiber.dispose()
    const secondFiber = await ctx.plugin(TokenMeter)
    activeMeter = ctx.tokenMeter
    expect(activeMeter.measure(session).logRevision).toBe(3)
    await secondFiber.dispose()
  })
})
