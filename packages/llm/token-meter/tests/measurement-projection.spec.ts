/** Recovery facts survive JSON checkpoints while positional prices are rebuilt independently. */
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { measurementProjectionDefinition } from '../src/measurement-projection.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx
}

function prefix() {
  const session = Session.create(SessionId('measurement-checkpoint'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } })
  return session
}

function answer(session: Session) {
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [], usage: { inputTokens: 1000, outputTokens: 10 },
    message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
}

describe('measurement recovery facts', () => {
  it('restores an open step from JSON and folds only the suffix; cold prices may read the prefix', async () => {
    const ctx = await harness()
    const session = prefix()
    ctx.tokenMeter.measure(session)
    const checkpoint = JSON.parse(JSON.stringify(ctx.sessionProjections.checkpoint(session))) as ProjectionCheckpoint
    const cut = session.seq
    answer(session)
    const expected = ctx.tokenMeter.measure(session)
    const events = session.snapshotEvents()
    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'detached')
    const apply = vi.spyOn(measurementProjectionDefinition, 'apply')
    onTestFinished(() => { apply.mockRestore() })
    ctx.sessionProjections.hydrate(restored, checkpoint, events.slice(cut), cut)
    expect(apply.mock.calls.map(([, event]) => event.seq)).toEqual(events.slice(cut).map(event => event.seq))
    apply.mockClear()
    const read = vi.spyOn(restored, 'eventAt')
    onTestFinished(() => { read.mockRestore() })
    expect(ctx.tokenMeter.measure(restored)).toEqual({ ...expected, logRevision: restored.seq })
    expect(read).toHaveBeenCalledWith(0)
    expect(apply.mock.calls.map(([, event]) => event.type)).toEqual(['session/end-seed'])
    read.mockClear()
    expect(ctx.tokenMeter.measure(restored)).toEqual({ ...expected, logRevision: restored.seq })
    expect(read).not.toHaveBeenCalled()
    expect(ctx.sessionProjections.snapshot(restored).values).not.toHaveProperty('tokenMeasurement')
  })

  it('keeps unrelated projections and checkpoints available for invalid measurement history', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create()
    const changed: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => { changed.push(key) })
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [], usage: { inputTokens: 1000, outputTokens: 10 },
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
    expect(changed).toContain('tokenUsage')
    expect(() => ctx.sessionProjections.snapshot(session)).not.toThrow()
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    expect(() => ctx.sessionProjections.restore(
      JSON.parse(JSON.stringify(checkpoint)) as ProjectionCheckpoint, [], session.seq,
      session.header, session.inheritedEventCount,
    )).not.toThrow()
    expect(() => ctx.tokenMeter.measure(session)).toThrow('no matching step/start event')
    session.append('step/start', { turn: 2, step: 1 })
    expect(() => ctx.sessionProjections.checkpoint(session)).not.toThrow()
    expect(() => ctx.tokenMeter.measure(session)).toThrow('no matching step/start event')
  })

  it('round-trips provider usage without imposing new value or field restrictions', () => {
    const session = prefix()
    const usage = { inputTokens: 1000, outputTokens: -1, providerDetail: { total: 7 } }
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [], usage,
      message: createAssistantMessage({ content: [], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
    const state = session.snapshotEvents().reduce(
      (value, event) => measurementProjectionDefinition.apply(value, event),
      measurementProjectionDefinition.init(),
    )
    expect(measurementProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(state.anchor?.usage).toEqual(usage)
  })

  it('keeps stream decode errors local to measurement with their original error type', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create()
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } })
    const data: unknown = {
      turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 10 },
      stream: [{ type: 'unsupported' }],
      message: createAssistantMessage({ content: [], source: { provider: 'test', model: 'test' } }),
    }
    // Durable malformed streams were accepted at this existing append boundary.
    session.append('assistant/message', data as SessionEvent<'assistant/message'>['data'], { surfaceOp: 'append' })
    expect(() => ctx.sessionProjections.snapshot(session)).not.toThrow()
    expect(() => ctx.sessionProjections.checkpoint(session)).not.toThrow()
    expect(() => ctx.tokenMeter.measure(session)).toThrow(Error)
    expect(() => ctx.tokenMeter.measure(session)).toThrow('unreachable variant in assembleAssistantStream')
  })

  it('retains only the step coordinates from diagnostic event fields', () => {
    const session = Session.create(SessionId('measurement-step-diagnostics'))
    const data = { turn: -1.5, step: 0.5, diagnostic: 'not measurement state' }
    session.append('step/start', data)
    const state = measurementProjectionDefinition.apply(measurementProjectionDefinition.init(), session.snapshotEvents()[0]!)
    expect(state.stepStart).toEqual({ turn: -1.5, step: 0.5 })
    expect(measurementProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it('rebuilds distinct current and successful-call headers after JSON recovery', async () => {
    const ctx = await harness()
    const session = prefix()
    answer(session)
    const anchorHeader = { config: { provider: 'test', model: 'test' } }
    session.append('request/header', {
      reason: 'change', header: { config: { provider: 'test', model: 'next' } },
    })
    const expected = ctx.tokenMeter.measure(session)
    const anchored = ctx.tokenMeter.measure(session, anchorHeader)
    const checkpoint = JSON.parse(JSON.stringify(ctx.sessionProjections.checkpoint(session))) as ProjectionCheckpoint
    const events = session.snapshotEvents()
    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'detached')
    const recovered = await harness()
    recovered.sessionProjections.hydrate(restored, checkpoint, [], session.seq)
    expect(recovered.tokenMeter.measure(restored)).toEqual({ ...expected, logRevision: restored.seq })
    expect(recovered.tokenMeter.measure(restored, anchorHeader)).toEqual({ ...anchored, logRevision: restored.seq })
    const read = vi.spyOn(restored, 'eventAt')
    onTestFinished(() => { read.mockRestore() })
    recovered.tokenMeter.measure(restored)
    recovered.tokenMeter.measure(restored, anchorHeader)
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps checkpoint fields independent of message count', async () => {
    const ctx = await harness()
    const session = prefix()
    answer(session)
    const initial = ctx.sessionProjections.checkpoint(session).tokenMeasurement!.val
    for (let n = 0; n < 300; n++) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'message'.repeat(n + 1) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const state = ctx.sessionProjections.checkpoint(session).tokenMeasurement!.val
    expect(state).toEqual(initial)
    expect(measurementProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(JSON.stringify(state).length).toBeLessThan(200)
    expect(state).toEqual({
      headerSeq: 2, stepStart: null, invalidSeq: null,
      anchor: { headerSeq: 2, assistantTokens: 0, usage: { inputTokens: 1000, outputTokens: 10 } },
    })
  })

  it('preserves immediate synchronous reads before activation', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meter = new TokenMeter(ctx)
    const session = prefix()
    answer(session)
    const immediate = meter.measure(session)
    const ready = await harness()
    expect(ready.tokenMeter.measure(session)).toEqual(immediate)
  })

  it('rejects caches and invalid references in persisted measurement state', () => {
    const init = measurementProjectionDefinition.init()
    expect(measurementProjectionDefinition.stateSchema.safeParse({ ...init, surface: [] }).success).toBe(false)
    expect(measurementProjectionDefinition.stateSchema.safeParse({ ...init, headerSeq: -1 }).success).toBe(false)
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 }
    const state = { ...init, anchor: { headerSeq: null, assistantTokens: 0, usage } }
    expect(measurementProjectionDefinition.stateSchema.parse(state)).toEqual(state)
  })

  it.each([
    ['current', 'missing'], ['anchor', 'missing'],
    ['current', 'other'], ['anchor', 'other'],
    ['current', 'absent'], ['anchor', 'absent'],
  ] as const)('rebuilds measurement for a %s header reference that is %s', async (target, replacement) => {
    const ctx = await harness()
    const session = prefix()
    answer(session)
    session.append('request/header', { reason: 'change', header: { config: { provider: 'test', model: 'next' } } })
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const expected = ctx.tokenMeter.measure(session)
    const state = measurementProjectionDefinition.stateSchema.parse(checkpoint.tokenMeasurement!.val)
    const seq = replacement === 'missing' ? 999
      : replacement === 'absent' ? null
        : target === 'current' ? state.anchor!.headerSeq : state.headerSeq
    checkpoint.tokenMeasurement!.val = target === 'current'
      ? { ...state, headerSeq: seq }
      : { ...state, anchor: { ...state.anchor!, headerSeq: seq } }
    const restored = await harness()
    restored.sessionProjections.hydrate(session, checkpoint, [], session.seq)
    expect(restored.tokenMeter.measure(session)).toEqual(expected)
    expect(restored.tokenMeter.measure(session)).toEqual(expected)
  })
})
