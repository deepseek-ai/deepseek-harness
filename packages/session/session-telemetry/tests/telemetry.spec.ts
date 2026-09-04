import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
/**
 * Coordinator semantics against a bare fake backend — the RFC's named unit
 * tier for the seam: adoption (fresh, seeded, re-adoption via the handoff
 * cursor), lifecycle-suffix replay, deep-copy isolation, turn-latency and
 * dispose-ordering pins, failure containment, and the `agent/error` relay.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  SessionTelemetryCoordinator,
  type SessionTelemetrySink,
  type SessionTelemetryCapture,
  type SessionTelemetryRecord,
} from '../src/index.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Test-only merged event proving unknown types flow through unchanged.
     * @mode emit
     * @param payload - opaque test payload
     */
    'telemetry-test/opaque': { payload: { nested: string[] } }
  }
}

class FakeBackend implements SessionTelemetrySink {
  records: SessionTelemetryRecord[] = []
  calls: string[] = []
  emitError: Error | undefined
  rejectSeq: number | undefined
  shutdownError: Error | undefined
  shutdownResolved = false

  emit(record: SessionTelemetryRecord): void {
    if (this.emitError) throw this.emitError
    if (this.rejectSeq !== undefined && record.attributes['event.seq'] === this.rejectSeq) {
      throw new Error(`backend rejected seq ${this.rejectSeq}`)
    }
    this.records.push(record)
    this.calls.push(`emit:${String(record.attributes['event.seq'] ?? record.attributes['telemetry.op'])}`)
  }

  flush = vi.fn()

  async shutdown(): Promise<void> {
    this.calls.push('shutdown')
    await new Promise(resolve => setTimeout(resolve, 5))
    if (this.shutdownError) throw this.shutdownError
    this.shutdownResolved = true
  }

  ledger(): SessionTelemetryRecord[] {
    return this.records.filter(r => r.channel === 'ledger')
  }
}

async function setup(
  backend: FakeBackend = new FakeBackend(),
  capture: SessionTelemetryCapture = 'live',
) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  let coordinator!: SessionTelemetryCoordinator
  const fiber = await ctx.plugin({
    name: 'fake-telemetry',
    inject: ['sessions'],
    apply: (inner: Context) => {
      coordinator = new SessionTelemetryCoordinator(inner, backend, capture)
    },
  })
  return { ctx, backend, coordinator, fiber }
}

function liveSession(ctx: Context, id = `s-${Math.random().toString(36).slice(2)}`): Session {
  return ctx.sessions.create(SessionId(id), { meta: {} })
}

function appendTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendAssistantMessage(
  session: Session,
  turn: number,
  step: number,
  texts: readonly string[],
  time0 = 100,
): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: texts.join('') }],
      source: { provider: 'mock', model: 'mock' },
    }),
    stream: [
      { type: 'text-chunks', time0, index: 0, dt: texts.slice(1).map(() => 5), texts: [...texts] },
      { type: 'chunk', time: time0 + Math.max(0, texts.length - 1) * 5, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ],
  }, { surfaceOp: 'append' })
}

describe('SessionTelemetryCoordinator capture', () => {
  it('hands every appended event over with envelope identity and cloned body', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx, 'cap')
    appendTurn(session)

    const start = backend.ledger()[0]!
    const message = backend.ledger()[1]!
    expect(start.attributes).toMatchObject({
      'session.id': 'cap',
      'session.format_version': SESSION_FORMAT_VERSION,
      'event.type': 'turn/start',
      'event.seq': 0,
    })
    expect(start.time).toBe(session.snapshotEvents()[0]!.time)
    expect(start.severity).toBe('info')
    expect(message.attributes['event.seq']).toBe(1)
    // Deep-copy isolation: mutating the handed-off body never reaches the log.
    ;(message.body as { content: { text: string }[] }).content[0]!.text = 'tampered'
    const logged = session.snapshotEvents()[1] as SessionEvent<'user/message'>
    expect(logged.data.content[0]).toMatchObject({ text: 'hello' })
  })

  it('stamps header facts on every record when present', async () => {
    const { ctx, backend } = await setup()
    const parent = SessionId('parent')
    const session = ctx.sessions.create(SessionId('child'), { meta: { cwd: '/tmp/proj', parentSession: parent } })
    appendTurn(session)
    for (const record of backend.ledger()) {
      expect(record.attributes['session.format_version']).toBe(SESSION_FORMAT_VERSION)
      expect(record.attributes['session.cwd']).toBe('/tmp/proj')
      expect(record.attributes['session.parent_id']).toBe('parent')
    }
  })

  it('maps outcome flags to severity, unknown types falling through as info', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx)
    session.append('turn/start', { turn: 1 })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: 'c1' as never,
        content: [],
        isError: true,
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: 'c2' as never,
        content: [],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('telemetry-test/opaque', { payload: { nested: [] } })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    const severities = backend.ledger().map(r => [r.attributes['event.type'], r.severity])
    expect(severities).toEqual([
      ['turn/start', 'info'],
      ['tool/result', 'error'],
      ['tool/result', 'info'],
      ['telemetry-test/opaque', 'info'],
      ['turn/end', 'error'],
    ])
  })

  it('passes unknown merged event types through unchanged', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx)
    session.append('telemetry-test/opaque', { payload: { nested: ['a', 'b'] } })
    const record = backend.ledger()[0]!
    expect(record.attributes['event.type']).toBe('telemetry-test/opaque')
    expect(record.severity).toBe('info')
    expect(record.body).toEqual({ payload: { nested: ['a', 'b'] } })
  })

  it('ships every assistant stream in canonical order with its complete body', async () => {
    const { ctx, backend } = await setup()
    const a = liveSession(ctx, 'a')
    const b = liveSession(ctx, 'b')
    appendAssistantMessage(a, 1, 1, ['a11-first', 'a11-second'], 110)
    appendAssistantMessage(a, 1, 2, ['a12-first'], 120)
    appendAssistantMessage(b, 1, 1, ['b11-first', 'b11-second'], 210)
    const shipped = backend.ledger().map(r => [
      r.attributes['session.id'],
      r.attributes['event.seq'],
      (r.body as SessionEvent<'assistant/message'>['data']).stream,
    ])
    expect(shipped).toEqual([
      ['a', 0, [
        { type: 'text-chunks', time0: 110, index: 0, dt: [5], texts: ['a11-first', 'a11-second'] },
        { type: 'chunk', time: 115, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ]],
      ['a', 1, [
        { type: 'text-chunks', time0: 120, index: 0, dt: [], texts: ['a12-first'] },
        { type: 'chunk', time: 120, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ]],
      ['b', 0, [
        { type: 'text-chunks', time0: 210, index: 0, dt: [5], texts: ['b11-first', 'b11-second'] },
        { type: 'chunk', time: 215, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ]],
    ])
  })
})

describe('SessionTelemetryCoordinator on-demand capture', () => {
  it('captures one canonical-log prefix at a time without following later events', async () => {
    const { ctx, backend, coordinator } = await setup(new FakeBackend(), 'on-demand')
    const session = liveSession(ctx, 'on-demand-prefix')
    appendTurn(session)
    appendAssistantMessage(session, 1, 1, ['first'], 100)
    const firstBoundary = session.snapshotEvents()[2]!.seq
    appendAssistantMessage(session, 1, 2, ['second'], 200)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(backend.records).toEqual([])

    coordinator.captureSession(session, firstBoundary)
    expect(backend.ledger().map(record => record.attributes['event.type'])).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
    ])
    expect(backend.ledger().map(record => record.attributes['event.seq'])).toEqual([0, 1, 2])
    expect(backend.ledger()[2]!.body).toMatchObject({
      stream: [
        { type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['first'] },
        { type: 'chunk', time: 100, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    })

    expect(backend.ledger()).toHaveLength(3)
    coordinator.captureSession(session)
    coordinator.captureSession(session)
    expect(backend.ledger().map(record => record.attributes['event.type'])).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'assistant/message',
      'turn/end',
    ])
    expect(backend.ledger().map(record => record.attributes['event.seq'])).toEqual([0, 1, 2, 3, 4])
    expect(backend.ledger()[3]!.body).toMatchObject({
      stream: [
        { type: 'text-chunks', time0: 200, index: 0, dt: [], texts: ['second'] },
        { type: 'chunk', time: 200, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    })
  })

  it('runs the currently mounted redaction policy during canonical-log capture', async () => {
    const { ctx, backend, coordinator } = await setup(new FakeBackend(), 'on-demand')
    const session = liveSession(ctx, 'on-demand-redacted')
    session.append('turn/start', { turn: 1 })
    const disposeRule = ctx.on('session-telemetry/record', (_record, next) => ({
      ...next(),
      body: { scrubbed: true },
    }))

    coordinator.captureSession(session)
    expect(backend.ledger()[0]!.body).toEqual({ scrubbed: true })
    disposeRule()

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    coordinator.captureSession(session)
    expect(backend.ledger()[1]!.body).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('contains each backend failure independently while replaying a prefix', async () => {
    const backend = new FakeBackend()
    backend.rejectSeq = 1
    const { ctx, coordinator } = await setup(backend, 'on-demand')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = liveSession(ctx, 'on-demand-failure')
    appendTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    coordinator.captureSession(session)
    expect(backend.ledger().map(record => record.attributes['event.seq'])).toEqual([0, 2])
    expect(warn).toHaveBeenCalled()
  })

  it('captures a pending prefix after coordinator reload without retained records', async () => {
    const first = new FakeBackend()
    const { ctx, fiber } = await setup(first, 'on-demand')
    const session = liveSession(ctx, 'on-demand-reload')
    session.append('turn/start', { turn: 1 })
    await fiber.dispose()
    expect(first.records).toEqual([])

    const second = new FakeBackend()
    let coordinator!: SessionTelemetryCoordinator
    await ctx.plugin({
      name: 'fake-telemetry-after-on-demand-reload',
      inject: ['sessions'],
      apply: (inner: Context) => {
        coordinator = new SessionTelemetryCoordinator(inner, second, 'on-demand')
      },
    })
    coordinator.captureSession(session)
    expect(second.ledger().map(record => record.attributes['event.seq'])).toEqual([0])
  })

  it('registers no continuous capture, flush, or ops listeners', async () => {
    const { ctx, backend, coordinator, fiber } = await setup(new FakeBackend(), 'on-demand')
    const redact = vi.fn((_record: SessionTelemetryRecord, next: () => SessionTelemetryRecord) => next())
    ctx.on('session-telemetry/record', redact)
    const session = liveSession(ctx, 'on-demand-ledger-only')
    session.append('turn/start', { turn: 1 })
    await ctx.parallel('session/flush', session)
    const agent = { id: 'agent-1', session } as Agent
    ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('local only') })
    expect(backend.flush).not.toHaveBeenCalled()
    expect(backend.records).toEqual([])
    expect(redact).not.toHaveBeenCalled()

    coordinator.captureSession(session)
    expect(redact).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(backend.records.map(record => record.channel)).toEqual(['ledger'])
  })
})

describe('SessionTelemetryCoordinator adoption', () => {
  it('replays a new fork object from its constructor boundary without its inherited prefix', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const parent = liveSession(ctx, 'seed-parent')
    appendTurn(parent)
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
    })
    const child = ctx.sessions.prepare(SessionId('seeded'), { seed: [...parent.snapshotEvents()], meta: {} })
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.sessions.enter(child)
    ctx.sessions.announce(child)

    const seqs = backend.ledger().map(r => [r.attributes['session.id'], r.attributes['event.seq']])
    expect(seqs).toEqual(expect.arrayContaining([['seed-parent', 0], ['seed-parent', 1]]))
    expect(seqs.filter(([id]) => id === 'seeded')).toEqual([
      ['seeded', 2],
      ['seeded', 3],
    ])
  })

  it('replays a restored post-migration Session from its constructor boundary', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const donor = Session.create(SessionId('donor'))
    donor.append('turn/start', { turn: 1 })
    appendAssistantMessage(donor, 1, 1, ['first'], 100)
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
    })
    // Session persistence migrates before it constructs the restored Session;
    // telemetry therefore receives a current-format object with the complete
    // migrated canonical seed.
    const resumed = ctx.sessions.prepare(SessionId('resumed'), {
      seed: structuredClone(donor.snapshotEvents()) as SessionEvent[],
      meta: {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('resumed'),
        createdAt: 1,
        isSeeded: false,
      },
      inheritedEventCount: SessionLogOffset(0),
      seedSource: 'persistence',
    })
    ctx.sessions.enter(resumed)
    ctx.sessions.announce(resumed)
    const ofResumed = () => backend.ledger()
      .filter(r => r.attributes['session.id'] === 'resumed')
    expect(ofResumed().map(r => r.attributes['event.seq'])).toEqual([2])
    expect(ofResumed().every(r => r.attributes['session.format_version'] === SESSION_FORMAT_VERSION)).toBe(true)
    appendAssistantMessage(resumed, 1, 1, ['continuation'], 200)
    appendAssistantMessage(resumed, 1, 2, ['next step'], 300)
    expect(ofResumed().map(r => r.attributes['event.seq'])).toEqual([2, 3, 4])
    expect(ofResumed().map(r => (r.body as { stream?: { type: string; texts?: string[] }[] }).stream?.[0]?.texts)).toEqual([
      undefined,
      ['continuation'],
      ['next step'],
    ])
  })

  it('stamps session.seed_length from the exact Session cut so receivers can stitch fork streams', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const parent = liveSession(ctx, 'stitch-parent')
    appendTurn(parent)
    const child = ctx.sessions.create(SessionId('stitch-child'), {
      seed: [...parent.snapshotEvents()],
      inheritedEventCount: SessionLogOffset(parent.snapshotEvents().length),
      meta: { parentSession: SessionId('stitch-parent'), isSeeded: true },
    })
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
    })
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const record = backend.ledger().find(r => r.attributes['session.id'] === 'stitch-child')!
    expect(record.attributes['session.parent_id']).toBe('stitch-parent')
    expect(record.attributes['session.seed_length']).toBe(2)
  })

  it('adopts exactly once when created fires after the sweep', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The enter/announce window: prepare+enter puts the session in the store
    // (visible to the constructor sweep) before `session/created` fires, so a
    // coordinator loaded inside that window sees the session twice — sweep
    // first, created second. The second adoption must be a no-op.
    const session = ctx.sessions.prepare(SessionId('overlap'))
    appendTurn(session)
    ctx.sessions.enter(session)
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
    })
    expect(backend.ledger()).toHaveLength(2)
    ctx.sessions.announce(session)
    expect(backend.ledger()).toHaveLength(2)
  })

  it('resumes from the handoff cursor across same-object re-adoption without duplicates', async () => {
    const backend = new FakeBackend()
    const { ctx, fiber } = await setup(backend)
    const session = liveSession(ctx, 'hmr')
    session.append('turn/start', { turn: 1 })
    appendAssistantMessage(session, 1, 1, ['first'], 100)
    expect(backend.ledger()).toHaveLength(2)

    await fiber.dispose()
    // The reload window: appends while no telemetry listener is registered.
    appendAssistantMessage(session, 1, 2, ['mid-step continuation'], 200)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const second = new FakeBackend()
    await ctx.plugin({
      name: 'fake-telemetry-2',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, second),
    })
    // Only window events past the same object's cursor are re-handed.
    expect(second.ledger().map(r => [r.attributes['event.seq'], r.attributes['event.type']])).toEqual([
      [2, 'assistant/message'],
      [3, 'turn/end'],
    ])
  })

  it('replays past a record the backend rejects: one event withheld, the rest adopted', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = liveSession(ctx, 'partial')
    appendTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The backend rejects exactly the middle historical event: fail-closed
    // must withhold THAT record only — an adoption replay that dies on the
    // first contained failure would silently skip the rest of the log while
    // the session stays marked adopted.
    backend.rejectSeq = 1
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
    })
    expect(backend.ledger().map(r => r.attributes['event.seq'])).toEqual([0, 2])
    expect(warn).toHaveBeenCalled()
  })

  it('re-hands the full log when no cursor survived (fresh session object)', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = liveSession(ctx, 'fresh')
    appendTurn(session)
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
    })
    expect(backend.ledger().map(r => r.attributes['event.seq'])).toEqual([0, 1])
  })
})

describe('SessionTelemetryCoordinator lifecycle and containment', () => {
  it('forwards session/flush as a hint without awaiting backend work', async () => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx)
    let settled = false
    backend.flush.mockImplementation(() => {
      // The backend may kick off arbitrary async work; the loop's parallel must not wait for it.
      void new Promise(resolve => setTimeout(resolve, 50)).then(() => { settled = true })
    })
    await ctx.parallel('session/flush', session)
    expect(backend.flush).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
  })

  it('ignores flush hints for sessions it never adopted', async () => {
    const { ctx, backend } = await setup()
    const stranger = ctx.sessions.prepare(SessionId('stranger'), { meta: {} })
    await ctx.parallel('session/flush', stranger)
    expect(backend.flush).not.toHaveBeenCalled()
  })

  it('emits no marker for a session whose announcement was vetoed before adoption', async () => {
    const backend = new FakeBackend()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // A listener registered BEFORE the coordinator vetoes publication: the
    // store still emits the paired `session/disposed` for rollback, but the
    // coordinator never saw `session/created` — a marker for a session the
    // receiver saw no activity from would be noise, not signal.
    ctx.on('session/created', () => {
      throw new Error('vetoed by an earlier listener')
    })
    await ctx.plugin({
      name: 'fake-telemetry',
      inject: ['sessions'],
      apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
    })
    expect(() => ctx.sessions.create(SessionId('vetoed'), { meta: {} })).toThrow('vetoed')
    expect(backend.records.filter(r => r.channel === 'ops')).toHaveLength(0)
  })

  it('emits each adopted session’s shutdown record before awaiting backend shutdown', async () => {
    const { ctx, backend, fiber } = await setup()
    liveSession(ctx, 's1')
    liveSession(ctx, 's2')
    await fiber.dispose()
    expect(backend.calls).toEqual(['emit:shutdown', 'emit:shutdown', 'shutdown'])
    expect(backend.shutdownResolved).toBe(true)
    const ops = backend.records.filter(r => r.channel === 'ops')
    expect(ops.map(r => r.attributes['session.id']).sort()).toEqual(['s1', 's2'])
    expect(ops.every(r => r.attributes['telemetry.op'] === 'shutdown' && r.severity === 'info')).toBe(true)
    expect(ops.every(r => !('event.seq' in r.attributes) && !('event.type' in r.attributes))).toBe(true)
  })

  it('emits the shutdown marker at the session’s own disposal edge, then retires it', async () => {
    const { ctx, backend, fiber } = await setup()
    liveSession(ctx, 'survivor')
    // A session owned by its own fiber: disposing the fiber detaches it from
    // the store and emits `session/disposed` — the authoritative termination
    // edge. The marker must ride THAT edge (receivers classify a session with
    // activity and no marker as crashed, so a normally closed session in a
    // long-running host must not look like a crash), and the session retires
    // from the adopted set so unload neither retains it nor re-marks it.
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessions.create(SessionId('ephemeral'), { meta: {} })
    }, { inject: ['sessions'] }))
    await owner.dispose()
    const atEdge = backend.records.filter(r => r.channel === 'ops')
    expect(atEdge.map(r => r.attributes['session.id'])).toEqual(['ephemeral'])
    expect(atEdge[0]!.attributes['telemetry.op']).toBe('shutdown')
    await fiber.dispose()
    const ops = backend.records.filter(r => r.channel === 'ops')
    expect(ops.map(r => r.attributes['session.id'])).toEqual(['ephemeral', 'survivor'])
  })

  it('warns instead of throwing when backend shutdown fails', async () => {
    const backend = new FakeBackend()
    backend.shutdownError = new Error('exporter unreachable')
    const { ctx, fiber } = await setup(backend)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    liveSession(ctx)
    await expect(fiber.dispose()).resolves.not.toThrow()
    expect(warn.mock.calls.some(args => String(args[0]).includes('shutdown failed'))).toBe(true)
  })

  it('contains emit failures: the append succeeds and capture heals', async () => {
    const { ctx, backend } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = liveSession(ctx)
    backend.emitError = new Error('backend broke')
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    backend.emitError = undefined
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(backend.ledger().map(r => r.attributes['event.type'])).toEqual(['turn/end'])
  })

  it.each([
    ['Error values', new TypeError('adapter exploded'), 'TypeError', 'adapter exploded'],
    ['non-Error values', 'plain failure', 'Error', 'plain failure'],
  ])('relays agent/error %s as an ops record with normalized identity', async (_label, error, name, message) => {
    const { ctx, backend } = await setup()
    const session = liveSession(ctx, 'erring')
    // Only the members the relay reads; the full Agent surface is irrelevant here.
    const agent = { id: 'agent-1', session } as Agent
    ctx.emit('agent/error', { agent, turn: 3, step: 2, error })
    const record = backend.records.find(r => r.channel === 'ops')!
    expect(record.severity).toBe('error')
    expect(record.attributes).toMatchObject({
      'telemetry.op': 'agent-error',
      'session.id': 'erring',
      'agent.id': 'agent-1',
      'error.name': name,
      turn: 3,
      step: 2,
    })
    expect(record.body).toEqual({ name, message })
  })
})
