import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type CreateSessionOptions,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { createDeveloperMessage, createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as SessionLogDeepSeek from '../src/index.ts'
import type { DeepSeekSessionLogExtension, DeepSeekSessionLogWireEvent, DeepSeekSessionLogWireSurfaceOp } from '../src/types.ts'

const contexts: Context[] = []
const SIGNAL = new AbortController().signal

afterEach(async () => {
  vi.restoreAllMocks()
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

  it('requires surface placement and restricts sources to non-assistant surface wire events', () => {
    type System = Extract<DeepSeekSessionLogWireEvent, { type: 'system/message' }>
    type Assistant = Extract<DeepSeekSessionLogWireEvent, { type: 'assistant/message' }>
    type User = Extract<DeepSeekSessionLogWireEvent, { type: 'user/message' }>
    type Tool = Extract<DeepSeekSessionLogWireEvent, { type: 'tool/result' }>
    type LogOnly = Extract<DeepSeekSessionLogWireEvent, { type: 'turn/start' }>
    type Replace = Exclude<DeepSeekSessionLogWireSurfaceOp, 'append'>
    expectTypeOf<System['surfaceOp']>().toEqualTypeOf<DeepSeekSessionLogWireSurfaceOp>()
    expectTypeOf<System['sourceEventSeqs']>().toEqualTypeOf<readonly number[] | undefined>()
    expectTypeOf<Assistant['surfaceOp']>().toEqualTypeOf<DeepSeekSessionLogWireSurfaceOp>()
    expectTypeOf<User['surfaceOp']>().toEqualTypeOf<DeepSeekSessionLogWireSurfaceOp>()
    expectTypeOf<Tool['surfaceOp']>().toEqualTypeOf<DeepSeekSessionLogWireSurfaceOp>()
    expectTypeOf<Assistant['sourceEventSeqs']>().toEqualTypeOf<undefined>()
    expectTypeOf<LogOnly['sourceEventSeqs']>().toEqualTypeOf<undefined>()
    expectTypeOf<LogOnly['surfaceOp']>().toEqualTypeOf<undefined>()
    expectTypeOf<User['sourceEventSeqs']>().toEqualTypeOf<readonly number[] | undefined>()
    expectTypeOf<Tool['sourceEventSeqs']>().toEqualTypeOf<readonly number[] | undefined>()
    expectTypeOf<Replace>().toEqualTypeOf<{
      readonly op: 'replace'
      readonly startSeq: number
      readonly endSeq: number
    }>()
  })

  it('uploads developer changes with their placement and source-event references', async () => {
    const { ctx, session } = await harness('wire-developer')
    const message = createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'search' }], source: { kind: 'tool-registry' } })
    const headerSeq = session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'search', description: 'Search', parameters: {} }] } }).seq
    const first = session.append('developer/message', { turn: 1, step: 1, headerSeq, message }, { surfaceOp: 'append' })
    session.append('developer/message', {
      turn: 1, step: 1,
      message: createDeveloperMessage({ content: [{ type: 'tool-removal', toolName: 'search' }], source: { kind: 'tool-registry' } }),
    }, { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq] })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    expect(prepared.fields.dsh_session_log?.events).toEqual(session.snapshotEvents())
  })

  it('uploads Assistant provider metadata only through its embedded stream', async () => {
    const { ctx, session } = await harness('wire-assistant')
    const assistant = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Answer' }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['Answer'] }],
    }, { surfaceOp: 'append' })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: session.id,
    })
    expect(prepared.fields.dsh_session_log?.events).toEqual([{
      type: assistant.type,
      seq: Number(assistant.seq),
      time: assistant.time,
      data: assistant.data,
      surfaceOp: 'append',
    }])
  })

  it('uploads system append and replacement placement with unchanged data and source-event references', async () => {
    const { ctx, session } = await harness('wire-system')
    const headData = { turn: 1, step: 1, message: createSystemMessage('head'), extra: { retained: true } }
    const head = session.append('system/message', headData, { surfaceOp: 'append' })
    session.append('system/message', {
      turn: 1, step: 2, message: createSystemMessage('later'),
    }, { surfaceOp: 'append' })
    session.append('system/message', {
      turn: 1, step: 3, message: createSystemMessage('new head'),
    }, { surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    expect(prepared.fields.dsh_session_log?.events).toEqual(session.snapshotEvents())
  })

  it.each(['extension/event', 'tool/code-dispatch', 'tool/code-dispatch-start'])('uploads opaque ignorable %s without interpreting its metadata', async (type) => {
    for (const metadata of [
      {},
      { surfaceOp: null },
      { sourceEventSeqs: null },
      { surfaceOp: { opaque: ['retained'] }, sourceEventSeqs: { opaque: [null] } },
    ]) {
      const event = {
        type, seq: SessionSeq(0), time: 1, data: { nested: [null, true] }, ignorable: true, ...metadata,
      } as unknown as SessionEvent
      const { ctx, session } = await harness('wire-opaque', [event])
      const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
      expect(prepared.fields.dsh_session_log?.events[0]).toStrictEqual(event)
      expect(session.deriveMessages()).toEqual([])
    }
  })

  it.each(['turn/start', 'assistant/attempt', 'request/context', 'tool/ptc-dispatch'])('rejects known log-only %s metadata before uploading', async (type) => {
    for (const metadata of [{ surfaceOp: 'append' }, { sourceEventSeqs: [0] }]) {
      const event = {
        type, seq: SessionSeq(0), time: 1, data: { turn: 1, step: 1, stream: [] }, ignorable: true, ...metadata,
      } as unknown as SessionEvent
      await expect(harness('wire-invalid', [event])).rejects.toThrow(/not surface-eligible/)
    }
  })

  it('does not contribute the session log when explicitly disabled', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(SessionLogDeepSeek, { enabled: false })
    const session = ctx.sessions.create(SessionId('explicit-off'))
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

  it('uploads a migrated V3 log from the beginning before resuming current-generation acknowledgements', async () => {
    const id = SessionId('migrated-v3-delivery')
    const reader = createSessionFormatCatalogWithChildren([]).createRestore({
      type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0,
    }, { recovery: 'strict', validation: 'current' })
    reader.decodeRow({ type: 'feedback/record', seq: 0, time: 2, data: { text: 'retained' } })
    reader.decodeRow({
      type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 3,
      data: { sessionId: id, throughSeq: 0, sessionFormatVersion: 3 },
    })
    const artifact = reader.finish()
    const session = Session.fromRestore(id, artifact.events as SessionEvent[],
      artifact.header as unknown as SessionHeader, SessionLogOffset(artifact.inheritedEventCount), 'detached')
    const { ctx } = await harness('delivery-migration-owner')
    ctx.effect(() => ctx.sessions.enter(session))

    const first = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: id })
    expect(first.fields.dsh_session_log).toMatchObject({ sessionFormatVersion: SESSION_FORMAT_VERSION, afterSeq: -1 })
    expect(first.fields.dsh_session_log?.events[0]?.seq).toBe(0)
    expect(first.fields.dsh_session_log?.events[1]).toMatchObject({ data: { sessionFormatVersion: 3, throughSeq: 0 } })
    const throughSeq = session.seq - 1
    await first.accept()
    expect(session.snapshotEvents().at(-1)?.data).toEqual({ sessionId: id, sessionFormatVersion: SESSION_FORMAT_VERSION, throughSeq })

    const second = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: id })
    expect(second.fields.dsh_session_log?.afterSeq).toBe(throughSeq)
    expect(second.fields.dsh_session_log?.events.map(event => event.seq)).toEqual([throughSeq + 1])
    expect(session.eventAt(SessionSeq(1))?.data).toMatchObject({ sessionFormatVersion: 3, throughSeq: 0 })
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
        surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
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
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
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
        surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
      },
    ]
    const { ctx, session } = await harness('wire-events', seed)

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: session.id,
    })
    const events = prepared.fields.dsh_session_log?.events ?? []

    expect(events[0]).not.toHaveProperty('surfaceOp')
    expect(events[0]).not.toHaveProperty('sourceEventSeqs')
    expect(events[1]).toMatchObject({
      type: 'user/message',
      ignorable: true,
      sourceEventSeqs: [0],
      surfaceOp: 'append',
    })
    expect(events[2]).toMatchObject({
      type: 'user/message',
      sourceEventSeqs: [1],
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
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

describe('byte-bounded DeepSeek session-log upload', () => {
  /** User messages with fixed times, so equal texts serialize to equal byte counts. */
  function userMessages(texts: readonly string[]): SessionEvent[] {
    return texts.map((text, index): SessionEvent => ({
      type: 'user/message',
      seq: SessionSeq(index),
      time: index + 1,
      data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    }))
  }

  function bytes(value: DeepSeekSessionLogExtension): number {
    return Buffer.byteLength(JSON.stringify(value))
  }

  /** The field value carrying only the first `count` events of `value`. */
  function prefix(value: DeepSeekSessionLogExtension, count: number): DeepSeekSessionLogExtension {
    return { ...value, throughSeq: value.events[count - 1]!.seq, events: value.events.slice(0, count) }
  }

  async function prepareField(ctx: Context, session: Session): Promise<DeepSeekSessionLogExtension | undefined> {
    return (await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })).fields.dsh_session_log
  }

  /** Mount the contribution with one byte limit around `run`. */
  async function withMaxBytes<T>(ctx: Context, maxBytes: number, run: () => Promise<T>): Promise<T> {
    const upload = ctx.plugin(SessionLogDeepSeek, { enabled: true, maxBytes })
    await upload
    try {
      return await run()
    } finally {
      await upload.dispose()
    }
  }

  /** Capture every pending event under the default limit, which these small logs stay below. */
  async function unbounded(id: string, texts: readonly string[]): Promise<{
    ctx: Context
    session: Session
    full: DeepSeekSessionLogExtension
  }> {
    const { ctx, session, disposeUpload } = await harness(id, userMessages(texts))
    const full = await prepareField(ctx, session)
    if (full === undefined) throw new Error('expected a session-log field')
    await disposeUpload()
    return { ctx, session, full }
  }

  it('applies the 8 MiB default when the composition sets no limit', async () => {
    const { ctx, session } = await harness('bounded-default', userMessages(['a', 'b', 'c'].map(letter => letter.repeat(3 * 1024 * 1024))))
    const value = await prepareField(ctx, session)
    expect(value?.events.map(event => event.seq)).toEqual([0, 1])
    expect(bytes(value!)).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('fills a request up to exactly maxBytes and leaves the next event for a later request', async () => {
    const { ctx, session, full } = await unbounded('bounded-exact', ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)])
    const limit = bytes(prefix(full, 2))
    const atLimit = await withMaxBytes(ctx, limit, () => prepareField(ctx, session))
    expect(atLimit).toEqual(prefix(full, 2))
    expect(bytes(atLimit!)).toBe(limit)
    expect(await withMaxBytes(ctx, limit - 1, () => prepareField(ctx, session))).toEqual(prefix(full, 1))
  })

  it('measures maxBytes in UTF-8 bytes', async () => {
    const { ctx, session, full } = await unbounded('bounded-utf8', ['界'.repeat(100), '界'.repeat(100)])
    const limit = bytes(prefix(full, 2)) - 1
    // UTF-16 code units undercount this field, so a code-unit budget would still admit both messages.
    expect(JSON.stringify(prefix(full, 2)).length).toBeLessThan(limit)
    expect(await withMaxBytes(ctx, limit, () => prepareField(ctx, session))).toEqual(prefix(full, 1))
  })

  it('drains a backlog larger than maxBytes through consecutive accepted requests', async () => {
    const { ctx, session, full } = await unbounded('bounded-drain', Array.from({ length: 6 }, (_, index) => String(index).repeat(200)))
    const maxBytes = bytes(prefix(full, 2))
    const batches = await withMaxBytes(ctx, maxBytes, async () => {
      const values: DeepSeekSessionLogExtension[] = []
      for (let request = 0; request < 10 && SessionLogDeepSeek.acceptedThrough(session) < full.throughSeq; request++) {
        const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
        values.push(prepared.fields.dsh_session_log!)
        await prepared.accept()
      }
      return values
    })
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBeGreaterThanOrEqual(full.throughSeq)
    expect(batches[0]).toEqual(prefix(full, 2))
    expect(batches.length).toBeGreaterThan(2)
    for (const value of batches) {
      expect(bytes(value)).toBeLessThanOrEqual(maxBytes)
      expect(value.events.map(event => event.seq))
        .toEqual(Array.from({ length: value.throughSeq - value.afterSeq }, (_, index) => value.afterSeq + 1 + index))
    }
    expect(batches.map(value => value.afterSeq)).toEqual([-1, ...batches.slice(0, -1).map(value => value.throughSeq)])
    expect(batches.flatMap(value => value.events).filter(event => event.type !== 'session-log-deepseek/delivery-accepted'))
      .toEqual(full.events)
  })

  it('omits the field and keeps the watermark while the next pending event alone exceeds maxBytes', async () => {
    const { ctx, session, full } = await unbounded('bounded-oversized', ['x'.repeat(1000)])
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const limit = bytes(prefix(full, 1)) - 1
    await withMaxBytes(ctx, limit, async () => {
      const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
      expect(prepared.fields).not.toHaveProperty('dsh_session_log')
      await prepared.accept()
      session.append('turn/start', { turn: 1 })
      expect(await prepareField(ctx, session)).toBeUndefined()
    })
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(-1)
    const warning = `session-log-deepseek: event 0 of session "bounded-oversized" needs a ${String(limit + 1)}-byte dsh_session_log field,`
      + ` above maxBytes ${String(limit)}; this session's upload stays at event 0 until maxBytes admits it`
    expect(warnings).toEqual([[warning], [warning]])
  })

  it('omits the field without failing the request when the next pending event exceeds the string limit', async () => {
    const { ctx, session } = await harness('bounded-string-limit', userMessages(['x'.repeat(100)]))
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const isBlocked = (value: unknown): boolean => typeof value === 'object' && value !== null
      && 'type' in value && value.type === 'user/message' && 'seq' in value && value.seq === 0
    let overflows = 0
    const stringify = JSON.stringify.bind(JSON)
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown, replacer?: (number | string)[] | null, space?: string | number) => {
      if (isBlocked(value) || (typeof value === 'object' && value !== null && 'events' in value
        && Array.isArray(value.events) && value.events.some(isBlocked))) {
        overflows++
        throw new RangeError('Invalid string length')
      }
      return stringify(value, replacer, space)
    })
    try {
      for (let request = 0; request < 2; request++) {
        const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
        expect(prepared.fields).not.toHaveProperty('dsh_session_log')
        await prepared.accept()
      }
    } finally {
      spy.mockRestore()
    }
    // One serialization attempt per request: the warning reuses the measured size.
    expect(overflows).toBe(2)
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(-1)
    const warning = 'session-log-deepseek: event 0 of session "bounded-string-limit" is too large to serialize into a dsh_session_log field;'
      + " this session's upload stays at event 0"
    expect(warnings).toEqual([[warning], [warning]])
  })
})
