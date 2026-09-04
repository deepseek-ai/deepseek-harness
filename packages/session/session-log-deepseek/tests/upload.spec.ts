import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type CreateSessionOptions,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as SessionLogDeepSeek from '../src/index.ts'
import type { DeepSeekSessionLogExtension } from '../src/types.ts'

const contexts: Context[] = []
const SIGNAL = new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(
  id: string,
  seed?: readonly SessionEvent[],
  creation?: Omit<CreateSessionOptions, 'seed'>,
): Promise<{
  ctx: Context
  session: Session
  disposeUpload: () => Promise<void>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  const upload = ctx.plugin(SessionLogDeepSeek, { enabled: true })
  await upload
  const options = seed === undefined
    ? undefined
    : { seed, ...creation }
  const session = ctx.sessions.create(SessionId(id), options)
  return { ctx, session, disposeUpload: () => upload.dispose() }
}

function body(text = 'x'.repeat(300)) {
  return { messages: [{ role: 'user', content: text }] }
}

describe('incremental DeepSeek session-log upload', () => {
  it('publishes raw numeric sequence fields on its external wire DTO', () => {
    expectTypeOf<DeepSeekSessionLogExtension['sessionFormatVersion']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['afterSeq']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['throughSeq']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['events'][number]['seq']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['events'][number]['data']>().toEqualTypeOf<JsonValue>()
    expectTypeOf<DeepSeekSessionLogExtension['session']['seedLength']>()
      .toEqualTypeOf<number | undefined>()
  })

  it('does not contribute the session log under its default configuration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(SessionLogDeepSeek)
    const session = ctx.sessions.create(SessionId('default-off'))
    session.append('turn/start', { turn: 1 })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: session.id,
    })
    expect(prepared.fields).not.toHaveProperty('dsh_session_log')
  })

  it('uploads the full first prefix, records acceptance, then sends only the appended suffix', async () => {
    const { ctx, session } = await harness('incremental')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })

    const first = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    const firstPayload = first.fields.dsh_session_log
    expect(firstPayload).toMatchObject({
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      afterSeq: -1,
      throughSeq: 1,
    })
    expect(firstPayload?.events).toHaveLength(2)
    await first.accept()
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(1)
    expect(session.snapshotEvents().at(-1)?.data).toEqual({
      sessionId: session.id,
      throughSeq: 1,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
    })

    session.append('step/end', { turn: 1, step: 1 })
    const second = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    expect(second.fields.dsh_session_log).toMatchObject({ afterSeq: 1, throughSeq: 3 })
    expect(second.fields.dsh_session_log?.events).toHaveLength(2)
    expect(second.fields.dsh_session_log?.events[0]).toMatchObject({
      type: 'session-log-deepseek/delivery-accepted',
      seq: 2,
    })
  })

  it('reconstructs a persisted cursor and ignores an inherited parent watermark in a fork', async () => {
    const first = await harness('parent')
    first.session.append('turn/start', { turn: 1 })
    const prepared = await first.ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: first.session.id })
    await prepared.accept()
    const seed = first.session.snapshotEvents()

    const resumed = await harness('parent', seed)
    expect(SessionLogDeepSeek.acceptedThrough(resumed.session)).toBe(0)
    const resumedPayload = await resumed.ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: resumed.session.id,
    })
    expect(resumedPayload.fields.dsh_session_log?.afterSeq).toBe(0)

    const fork = await harness('child', seed, {
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: first.session.id, isSeeded: true },
    })
    expect(SessionLogDeepSeek.acceptedThrough(fork.session)).toBe(-1)
    const forkPayload = await fork.ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: fork.session.id })
    expect(forkPayload.fields.dsh_session_log).toMatchObject({ afterSeq: -1, throughSeq: fork.session.seq - 1 })
  })

  it('takes the maximum watermark when concurrent acceptances settle out of order', async () => {
    const { ctx, session } = await harness('concurrent')
    session.append('turn/start', { turn: 1 })
    const earlier = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    session.append('step/start', { turn: 1, step: 1 })
    const later = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })

    await later.accept()
    await earlier.accept()
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(1)
  })

  it('folds only events appended after the cached acceptance scan', () => {
    const id = SessionId('incremental-fold')
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: SessionSeq(1),
        time: 2,
        data: {
          sessionId: id,
          throughSeq: SessionSeq(0),
          sessionFormatVersion: SESSION_FORMAT_VERSION,
        },
      },
    ]
    let reads = 0
    const session = {
      id,
      header: { version: SESSION_FORMAT_VERSION },
      get seq() { return SessionLogOffset(events.length) },
      eventAt(seq: ReturnType<typeof SessionSeq>) {
        reads++
        return events[seq]
      },
    } as unknown as Session

    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(0)
    expect(reads).toBe(2)
    reads = 0
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(0)
    expect(reads).toBe(0)

    events.push(
      { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: SessionSeq(3),
        time: 4,
        data: {
          sessionId: id,
          throughSeq: SessionSeq(2),
          sessionFormatVersion: SESSION_FORMAT_VERSION,
        },
      },
    )
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(2)
    expect(reads).toBe(2)
  })

  it('rejects a missing event below the captured Session length', () => {
    const session = {
      id: SessionId('missing-event'),
      header: { version: SESSION_FORMAT_VERSION },
      seq: SessionLogOffset(1),
      eventAt: () => undefined,
    } as unknown as Session

    expect(() => SessionLogDeepSeek.acceptedThrough(session))
      .toThrow('session-log-deepseek: missing event 0 below captured length 1')
  })

  it('ignores another format generation before interpreting its frozen sequence', () => {
    const id = SessionId('migrated-generation')
    const events = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: SessionSeq(1),
        time: 2,
        data: { sessionId: id, throughSeq: SessionSeq(99) },
      },
      { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: SessionSeq(3),
        time: 4,
        data: {
          sessionId: id,
          throughSeq: SessionSeq(2),
          sessionFormatVersion: SESSION_FORMAT_VERSION,
        },
      },
    ] as SessionEvent[]
    const migrated = {
      id,
      header: { version: SESSION_FORMAT_VERSION },
      get seq() { return SessionLogOffset(events.length) },
      eventAt: (seq: ReturnType<typeof SessionSeq>) => events[seq],
    } as unknown as Session

    expect(SessionLogDeepSeek.acceptedThrough(migrated)).toBe(2)
  })

  it.each([-1, -0, 0.5])('rejects malformed acceptance format version %s', (sessionFormatVersion) => {
    const id = SessionId(`malformed-format-${sessionFormatVersion}`)
    const events = [{
      type: 'session-log-deepseek/delivery-accepted',
      seq: SessionSeq(0),
      time: 1,
      data: { sessionId: id, throughSeq: SessionSeq(0), sessionFormatVersion },
    }] as unknown as SessionEvent[]
    const session = {
      id,
      header: { version: SESSION_FORMAT_VERSION },
      get seq() { return SessionLogOffset(events.length) },
      eventAt: (seq: ReturnType<typeof SessionSeq>) => events[seq],
    } as unknown as Session

    expect(() => SessionLogDeepSeek.acceptedThrough(session)).toThrow(/malformed acceptance format version/)
  })

  it('omits the field for direct or stale requests and uploads the prior acceptance marker next', async () => {
    const { ctx, session } = await harness('edges')
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL }))
      .resolves.toMatchObject({ fields: {} })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: 'missing' }))
      .resolves.toMatchObject({ fields: {} })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id }))
      .resolves.toMatchObject({ fields: {} })
    session.append('turn/start', { turn: 1 })
    const first = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    await first.accept()
    const current = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    expect(current.fields.dsh_session_log).toMatchObject({
      afterSeq: 0,
      throughSeq: 1,
      events: [{ type: 'session-log-deepseek/delivery-accepted' }],
    })
  })

  it('contributes complete events without reading request messages', async () => {
    const { ctx, session } = await harness('direct-events')
    session.append('turn/start', { turn: 1 })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL, sessionId: session.id })
    expect(prepared.fields.dsh_session_log?.events).toEqual(session.snapshotEvents())
  })

  it('translates logical brands and isSeeded into the raw upload DTO', async () => {
    const firstMessage = createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })
    const replacementMessage = createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'user' },
    })
    const seed = [
      {
        type: 'user/message',
        seq: SessionSeq(0),
        time: 1,
        data: firstMessage,
        ignorable: true,
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: replacementMessage,
        sourceEventSeqs: [SessionSeq(0)],
        surfaceOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(0) },
      },
    ] satisfies SessionEvent[]
    const { ctx, session } = await harness('wire-child', seed, {
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: {
        cwd: '/wire-workspace',
        parentSession: SessionId('wire-parent'),
        isSeeded: true,
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset: 'minimal',
      },
    })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: session.id,
    })
    const wire = JSON.parse(JSON.stringify(prepared.fields.dsh_session_log)) as Record<string, unknown>
    expect(wire.session).toMatchObject({
      version: SESSION_FORMAT_VERSION,
      id: 'wire-child',
      cwd: '/wire-workspace',
      parentSession: 'wire-parent',
      seedLength: seed.length,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'minimal',
    })
    expect(wire.session).not.toHaveProperty('isSeeded')
    expect(typeof wire.afterSeq).toBe('number')
    expect(typeof wire.throughSeq).toBe('number')
    expect(Array.isArray(wire.events)).toBe(true)
    const events = Array.isArray(wire.events) ? wire.events : []
    expect(events[0]).toMatchObject({
      seq: 0,
      ignorable: true,
      surfaceOp: 'append',
    })
    expect(events[0]).not.toHaveProperty('sourceEventSeqs')
    expect(events[1]).toMatchObject({
      seq: 1,
      sourceEventSeqs: [0],
      surfaceOp: { op: 'replace', start: 0, end: 0 },
    })
  })

  it('translates ignorable and surface event envelopes to raw wire values', async () => {
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: 'text', text: 'first' }],
          source: { kind: 'user' },
        }),
        ignorable: true,
        sourceEventSeqs: [SessionSeq(0)],
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        seq: SessionSeq(2),
        time: 3,
        data: createUserMessage({
          content: [{ type: 'text', text: 'replacement' }],
          source: { kind: 'user' },
        }),
        sourceEventSeqs: [SessionSeq(1)],
        surfaceOp: { op: 'replace', start: SessionSeq(1), end: SessionSeq(1) },
      },
    ]
    const { ctx, session } = await harness('wire-events', seed)

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: session.id,
    })
    const events = prepared.fields.dsh_session_log?.events ?? []

    expect(events[0]).not.toHaveProperty('surfaceOp')
    expect(events[1]).toMatchObject({
      type: 'user/message',
      ignorable: true,
      sourceEventSeqs: [0],
      surfaceOp: 'append',
    })
    expect(events[2]).toMatchObject({
      type: 'user/message',
      sourceEventSeqs: [1],
      surfaceOp: { op: 'replace', start: 1, end: 1 },
    })
  })

  it('fails closed on a malformed persisted acceptance watermark', async () => {
    const malformed = [{
      type: 'session-log-deepseek/delivery-accepted',
      seq: 0,
      time: 1,
      data: {
        sessionId: 'malformed',
        throughSeq: 0,
        sessionFormatVersion: SESSION_FORMAT_VERSION,
      },
    }] as unknown as SessionEvent[]
    const session = Session.create(SessionId('malformed'), malformed)
    expect(() => SessionLogDeepSeek.acceptedThrough(session)).toThrow(/malformed acceptance watermark/)
  })

  it('rejects a negative persisted acceptance watermark before comparing it', () => {
    const id = SessionId('negative-watermark')
    const events = [{
      type: 'session-log-deepseek/delivery-accepted',
      seq: SessionSeq(0),
      time: 1,
      data: {
        sessionId: id,
        throughSeq: -1,
        sessionFormatVersion: SESSION_FORMAT_VERSION,
      },
    }] as unknown as SessionEvent[]
    const session = {
      id,
      header: { version: SESSION_FORMAT_VERSION },
      get seq() { return SessionLogOffset(events.length) },
      eventAt: (seq: ReturnType<typeof SessionSeq>) => events[seq],
    } as unknown as Session

    expect(() => SessionLogDeepSeek.acceptedThrough(session)).toThrow(/malformed acceptance watermark/)
  })

  it('withdraws its request field when the contributing plugin reloads', async () => {
    const { ctx, session, disposeUpload } = await harness('hmr')
    session.append('turn/start', { turn: 1 })
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })).fields)
      .toHaveProperty('dsh_session_log')
    await disposeUpload()
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })).fields)
      .not.toHaveProperty('dsh_session_log')
  })
})
