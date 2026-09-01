import { createUserMessage } from '@deepseek-ai/dsh-llm'
/**
 * The `session-telemetry/record` waterfall contract: pass-through when no listener is
 * mounted, listener stacking and replacement, ops-record coverage, the
 * untouched canonical log, and the fail-closed containment of a throwing rule.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionTelemetryCoordinator,
  type SessionTelemetrySink,
  type SessionTelemetryRecord,
} from '../src/index.ts'

const FIXTURE_SECRET = 'sk-fixture1234567890'

class CollectingBackend implements SessionTelemetrySink {
  records: SessionTelemetryRecord[] = []
  emit(record: SessionTelemetryRecord): void {
    this.records.push(record)
  }
  async shutdown(): Promise<void> {}
}

async function setup() {
  const backend = new CollectingBackend()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin({
    name: 'fake-telemetry',
    inject: ['sessions'],
    apply: (inner: Context) => void new SessionTelemetryCoordinator(inner, backend),
  })
  return { ctx, backend, fiber }
}

describe('session-telemetry/record waterfall', () => {
  it('passes records through unchanged when no listener is mounted', async () => {
    const { ctx, backend } = await setup()
    const session = ctx.sessions.create(SessionId('w'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `key ${FIXTURE_SECRET}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const body = backend.records[0]!.body as { content: { text: string }[] }
    expect(body.content[0]!.text).toBe(`key ${FIXTURE_SECRET}`)
  })

  it('applies a mounted rule to every outbound record, ops records included', async () => {
    const { ctx, backend, fiber } = await setup()
    ctx.on('session-telemetry/record', (_record, next) => {
      const record = next()
      return { ...record, body: { scrubbed: true } }
    })
    const session = ctx.sessions.create(SessionId('rule'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: FIXTURE_SECRET }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(backend.records[0]!.body).toEqual({ scrubbed: true })
    // The dispose-time shutdown ops record passes through the same waterfall.
    await fiber.dispose()
    const ops = backend.records.filter(record => record.channel === 'ops')
    expect(ops).toHaveLength(1)
    expect(ops[0]!.body).toEqual({ scrubbed: true })
  })

  it('keeps the canonical log untouched by a mounted rule', async () => {
    const { ctx } = await setup()
    ctx.on('session-telemetry/record', (_record, next) => ({ ...next(), body: null }))
    const session = ctx.sessions.create(SessionId('log'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: FIXTURE_SECRET }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const logged = session.snapshotEvents()[0]!.data as { content: { text: string }[] }
    expect(logged.content[0]!.text).toBe(FIXTURE_SECRET)
  })

  it('stacks listeners outermost-first around next()', async () => {
    const { ctx, backend } = await setup()
    const order: string[] = []
    ctx.on('session-telemetry/record', (_record, next) => {
      order.push('outer-before')
      const record = next()
      order.push('outer-after')
      return { ...record, attributes: { ...record.attributes, outer: 1 } }
    })
    ctx.on('session-telemetry/record', (_record, next) => {
      order.push('inner')
      const record = next()
      return { ...record, attributes: { ...record.attributes, inner: 1 } }
    })
    const session = ctx.sessions.create(SessionId('stack'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(order).toEqual(['outer-before', 'inner', 'outer-after'])
    expect(backend.records[0]!.attributes).toMatchObject({ outer: 1, inner: 1 })
  })

  it('a listener that skips next() replaces everything beneath it', async () => {
    const { ctx, backend } = await setup()
    const inner = { called: false }
    ctx.on('session-telemetry/record', () => ({ channel: 'ops', time: 0, severity: 'info', attributes: {}, body: 'replaced' } satisfies SessionTelemetryRecord))
    ctx.on('session-telemetry/record', (_record, next) => {
      inner.called = true
      return next()
    })
    const session = ctx.sessions.create(SessionId('veto'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(backend.records[0]!.body).toBe('replaced')
    expect(inner.called).toBe(false)
  })

  it('a throwing rule withholds the record fail-closed without disturbing the log', async () => {
    const { ctx, backend } = await setup()
    ctx.on('session-telemetry/record', () => {
      throw new Error('rule exploded')
    })
    const session = ctx.sessions.create(SessionId('closed'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(backend.records).toHaveLength(0)
    expect(session.snapshotEvents()).toHaveLength(1)
  })
})
