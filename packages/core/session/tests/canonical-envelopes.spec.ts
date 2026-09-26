import { Context } from '@deepseek-ai/cordis'
import { createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import SessionStore, {
  adoptSessionEvent,
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  snapshotSessionEvent,
  type SessionEvent,
  type SurfaceEvent,
  type SurfaceEventType,
  type SurfaceIntent,
  type SurfaceOp,
} from '@deepseek-ai/dsh-session'

const id = SessionId('canonical-envelopes')
const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false } as const
const config = { provider: 'mock', model: 'mock', maxTokens: 1 }
const failure = { name: 'ToolError', code: 'FAILED' }

function requestEvent(data: unknown): SessionEvent {
  return { type: 'request/header', seq: SessionSeq(0), time: 1, data } as SessionEvent
}

function toolEvent(data: unknown): SessionEvent {
  return { type: 'tool/result', seq: SessionSeq(0), time: 1, data, surfaceOp: 'append' } as SessionEvent
}

function toolData(isError: boolean) {
  return {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('tool'), content: [], isError }),
  }
}

function appendEvent(session: Session, event: SessionEvent) {
  const append = session.append.bind(session) as (
    type: SessionEvent['type'], data: unknown, metadata?: unknown,
  ) => SessionEvent
  return append(event.type, event.data, {
    ...event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp },
    ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
  })
}

const entryPaths: Record<string, (event: SessionEvent) => unknown> = {
  append: (event: SessionEvent) => appendEvent(Session.create(id), event),
  seed: (event: SessionEvent) => Session.create(id, [event]),
  restore: (event: SessionEvent) => Session.fromRestore(id, [event], { ...header }, SessionLogOffset(0), 'detached'),
  adopt: adoptSessionEvent,
  snapshot: snapshotSessionEvent,
}

const invalidData = [
  ...[null, [], 1, 'invalid'].flatMap(data => [
    { name: 'request data is not an object', event: requestEvent(data), rule: /data must be an object/ },
    { name: 'request header is not an object', event: requestEvent({ header: data, reason: 'initial' }), rule: /header must be an object/ },
    { name: 'tool data is not an object', event: toolEvent(data), rule: /data must be an object/ },
  ]),
  { name: 'missing request header', event: requestEvent({ reason: 'initial' }), rule: /header must be an object/ },
  ...[{ tools: [] }, { adapterDefaults: {} }].map(optional => ({
    name: 'empty optional request field',
    event: requestEvent({ header: { config, ...optional }, reason: 'initial' }),
    rule: /must omit empty/,
  })),
  ...['', ' ', 'system', null, [], {}].map(system => ({
    name: 'obsolete request header system',
    event: requestEvent({ header: { config, system }, reason: 'initial' }),
    rule: /must omit header.system/,
  })),
  { name: 'successful tool has failure metadata', event: toolEvent({ ...toolData(false), error: failure }), rule: /error requires/ },
  ...[undefined, null, [], {}, { isError: 'true' }, { content: [{ isError: true }] }].map(message => ({
    name: 'malformed tool message with failure metadata',
    event: toolEvent({ turn: 1, step: 1, ...message === undefined ? {} : { message }, error: failure }),
    rule: /error requires/,
  })),
]

describe('canonical event payload acceptance', () => {
  it('restores system prompts only with system-prompt producer attribution', () => {
    const message = createSystemMessage('prompt')
    const event: SessionEvent<'system/message'> = {
      type: 'system/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, message },
    }
    for (const accept of [entryPaths.seed!, entryPaths.restore!, entryPaths.adopt!, entryPaths.snapshot!]) {
      expect(() => accept(structuredClone(event))).not.toThrow()
      for (const source of [{ kind: 'runtime-context' }, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, { kind: 'user' }]) {
        const invalid = { ...event, data: { ...event.data, message: { ...message, source } } }
        expect(() => accept(invalid as unknown as SessionEvent)).toThrow(/system-prompt source/)
      }
    }
  })

  for (const [path, accept] of Object.entries(entryPaths)) {
    describe(path, () => {
      it.each(invalidData)('rejects $name with a located error', ({ event, rule }) => {
        const input = structuredClone(event)
        let caught: unknown
        try { accept(input) } catch (error: unknown) { caught = error }
        expect(caught).toBeInstanceOf(Error)
        expect(caught).not.toBeInstanceOf(TypeError)
        expect((caught as Error).message).toMatch(rule)
        expect((caught as Error).message).toMatch(/(?:seq|index) 0/)
        expect(input).toEqual(event)
      })

      it('accepts absent optional fields, nonempty fields, and optional failure identity', () => {
        const events = [
          requestEvent({ header: { config }, reason: 'initial' }),
          requestEvent({ header: { config, extension: { nested: true }, tools: [{ name: 'tool', description: '', parameters: {} }], adapterDefaults: { maxTokens: true } }, reason: 'initial' }),
          toolEvent(toolData(false)),
          toolEvent(toolData(true)),
          toolEvent({ ...toolData(true), error: failure }),
        ]
        for (const event of events) expect(() => accept(structuredClone(event))).not.toThrow()
      })
    })
  }

  it('preserves nested header, source, and data extras without normalizing accepted events', () => {
    const message = createSystemMessage('prompt')
    const events: SessionEvent[] = [
      requestEvent({ header: { config, extra: { nested: [true, null] } }, reason: 'initial', extra: ['retained'] }),
      { type: 'system/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append', data: {
        turn: 1, step: 1, message: { ...message, source: { ...message.source, extra: { nested: true } } }, extra: ['retained'],
      } } as unknown as SessionEvent,
    ]
    for (const event of events) {
      for (const [path, accept] of Object.entries(entryPaths)) {
        const copy = structuredClone(event)
        expect(() => accept(copy)).not.toThrow()
        expect(copy).toEqual(event)
        if (path === 'adopt' || path === 'snapshot') expect(accept(copy)).toEqual(event)
      }
      expect(Session.create(id, [event]).eventAt(SessionSeq(0))).toEqual(event)
    }
  })

  it('rejects any own header.system even when its value is undefined at adoption', () => {
    const event = requestEvent({ header: { config, system: undefined }, reason: 'initial' })
    expect(() => adoptSessionEvent(event)).toThrow(/must omit header.system/)
  })

  it('adopts an assistant message and freezes its identified message', () => {
    const event: SessionEvent<'assistant/message'> = {
      type: 'assistant/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, stream: [], message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }) },
    }
    const owned = structuredClone(event)
    expect(adoptSessionEvent(owned)).toBe(owned)
    expect(Object.isFrozen(owned.data.message)).toBe(true)
    expect(Object.isFrozen(owned.data.message.content)).toBe(true)
    expect(snapshotSessionEvent(event)).toEqual(event)
  })

  it.each([null, 'invalid'])('rejects a non-object restored request config (%j)', (config) => {
    const event = requestEvent({ header: { config }, reason: 'initial' })
    expect(() => Session.create(id, [event])).toThrow('lacks provider/model')
    expect(() => Session.fromRestore(id, [event], { ...header }, SessionLogOffset(0), 'detached'))
      .toThrow('lacks provider/model')
  })

  it('updates the frozen request-header cache only for accepted snapshots', () => {
    const session = Session.create(id)
    session.append('request/header', { header: { config, tools: [{ name: 'tool', description: '', parameters: {} }] }, reason: 'initial' })
    const first = session.requestHeader()
    expect(first).toEqual({ config, tools: [{ name: 'tool', description: '', parameters: {} }] })
    expect(Object.isFrozen(first)).toBe(true)
    expect(session.requestHeader()).toBe(first)
    expect(() => appendEvent(session, requestEvent({ header: { config, system: '' }, reason: 'change' })))
      .toThrow(/must omit header.system/)
    expect(session.requestHeader()).toBe(first)
    session.append('request/header', { header: { config }, reason: 'change' })
    expect(session.requestHeader()).toEqual({ config })
    expect(first).toEqual({ config, tools: [{ name: 'tool', description: '', parameters: {} }] })
  })

  it.each(['detached', 'shared-frozen'] as const)('prepares owned restored events without publication (%s)', async (eventState) => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionStore)
    await fiber
    try {
      const event = requestEvent({ header: { config }, reason: 'initial' })
      const created = vi.fn()
      ctx.on('session/created', created)
      const prepared = ctx.sessions.prepare(id, {
        seed: [event], meta: { ...header }, inheritedEventCount: SessionLogOffset(0), eventState,
      })
      expect(prepared.eventAt(SessionSeq(0))).toBe(event)
      expect(prepared.requestHeader()).toEqual({ config })
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect(created).not.toHaveBeenCalled()
      const invalid = requestEvent({ header: { config, tools: [] }, reason: 'initial' })
      expect(() => ctx.sessions.prepare(id, {
        seed: [invalid], meta: { ...header }, inheritedEventCount: SessionLogOffset(0), eventState,
      })).toThrow(/must omit empty tools/)
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect(created).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })

  it('does not publish rejected appends or seeds or change derived state', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SessionStore)
    await fiber
    try {
      const session = ctx.sessions.create(id)
      const created = vi.fn()
      const published = vi.fn()
      ctx.on('session/created', created)
      ctx.on('session/event', published)
      const events = session.snapshotEvents()
      const messages = session.deriveMessages()
      for (const { event } of invalidData) {
        expect(() => appendEvent(session, event)).toThrow()
        expect(() => ctx.sessions.create(SessionId('invalid-seed'), { seed: [event] })).toThrow()
        expect(ctx.sessions.get(SessionId('invalid-seed'))).toBeUndefined()
        expect(session.seq).toBe(0)
        expect(session.snapshotEvents()).toBe(events)
        expect(session.surface.nodes).toEqual([])
        expect(session.surface.replaceGeneration).toBe(0)
        expect(session.deriveMessages()).toEqual(messages)
        expect(session.requestHeader()).toBeUndefined()
      }
      expect(created).not.toHaveBeenCalled()
      expect(published).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })

  it.each([null, [], 1, 'invalid'])('reports malformed restored event envelopes without TypeError (%j)', (value) => {
    expect(() => Session.fromRestore(id, [value] as never, { ...header }, SessionLogOffset(0), 'detached'))
      .toThrow('seed event at index 0 has an invalid event envelope')
  })
})

const invalidOps = [
  { op: 'replace', start: 0, end: 0 },
  { op: 'replace', start: 0, endSeq: 0 },
  { op: 'replace', startSeq: 0, end: 0 },
  { op: 'replace', startSeq: 0, endSeq: 0, start: 0 },
  { op: 'replace', startSeq: 0, endSeq: 0, end: 0 },
  { op: 'replace', startSeq: 0, endSeq: 0, extra: true },
  { op: 'replace', startSeq: -1, endSeq: 0 },
]

function userEvent(): SessionEvent<'user/message'> {
  return {
    type: 'user/message', seq: SessionSeq(0), time: 1,
    data: createUserMessage({ content: [], source: { kind: 'user' } }), surfaceOp: 'append',
  }
}

describe('canonical event-local surface metadata', () => {
  for (const [path, accept] of Object.entries(entryPaths)) {
    it.each(invalidOps)(path + ' rejects noncanonical replace keys (%j)', (surfaceOp) => {
      expect(() => accept({ ...userEvent(), surfaceOp } as unknown as SessionEvent)).toThrow(/invalid replace surfaceOp/)
    })

    it(path + ' requires markers and forbids non-surface and assistant source-event references', () => {
      const { surfaceOp: _op, ...markerless } = userEvent()
      expect(() => accept(markerless as SessionEvent)).toThrow(/requires a surfaceOp marker/)
      expect(() => accept({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 }, surfaceOp: 'append' } as never))
        .toThrow(/not surface-eligible/)
      expect(() => accept({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 }, sourceEventSeqs: [0] } as never))
        .toThrow(/not surface-eligible/)
      const assistant = {
        ...userEvent(), type: 'assistant/message', sourceEventSeqs: [0],
        data: { turn: 1, step: 1, stream: [], message: createMessage({
          role: 'assistant', content: [], source: { kind: 'model', provider: 'mock', model: 'mock' },
        }) },
      } as unknown as SessionEvent
      expect(() => accept(assistant)).toThrow(/cannot carry sourceEventSeqs/)
    })
  }

  it.each(['extension/event', 'tool/code-dispatch', 'tool/code-dispatch-start'])('retains opaque ignorable %s metadata without deriving messages', (type) => {
    const event = {
      type, seq: SessionSeq(0), time: 1, data: { nested: { retained: true } }, ignorable: true,
      surfaceOp: { opaque: ['not', 'placement'] }, sourceEventSeqs: { opaque: [null, true] },
    } as unknown as SessionEvent
    for (const [path, accept] of Object.entries(entryPaths)) {
      if (path === 'append') continue
      expect(() => accept(structuredClone(event))).not.toThrow()
    }
    const session = Session.create(id, [event])
    expect(session.eventAt(SessionSeq(0))).toEqual(event)
    expect(session.surface.nodes).toEqual([])
    expect(session.deriveMessages()).toEqual([])
  })

  it.each(['turn/start', 'assistant/attempt', 'request/context', 'session/title', 'tool/ptc-dispatch'])('rejects known log-only %s metadata even when ignorable', (type) => {
    for (const metadata of [{ surfaceOp: 'append' }, { sourceEventSeqs: [0] }]) {
      const event = {
        type, seq: SessionSeq(0), time: 1, data: { turn: 1, step: 1, stream: [] }, ignorable: true, ...metadata,
      } as unknown as SessionEvent
      for (const accept of Object.values(entryPaths)) expect(() => accept(event)).toThrow(/not surface-eligible/)
    }
  })

  it('requires system placement and preserves system data and source-event references on head replacements', () => {
    const session = Session.create(id)
    const data = { turn: 1, step: 1, message: createSystemMessage('head'), extra: { nested: true } }
    const head = session.append('system/message', data, { surfaceOp: 'append' })
    const next = session.append('system/message', { ...data, message: createSystemMessage('next') }, {
      surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq],
    })
    expect(next.data).toEqual({ ...data, message: next.data.message })
    expect(session.surface.nodes).toEqual([next.seq])
    expect(session.deriveMessages()).toEqual([next.data.message])
    const { surfaceOp: _op, ...markerless } = head
    for (const accept of Object.values(entryPaths)) expect(() => accept(markerless as SessionEvent)).toThrow(/requires a surfaceOp marker/)
  })

  it.each([1, 2])('adoption rejects current or future replacement endpoints (%s)', (endpoint) => {
    const event = { ...userEvent(), seq: SessionSeq(1), surfaceOp: { op: 'replace', startSeq: SessionSeq(endpoint), endSeq: SessionSeq(0) } } as SessionEvent
    expect(() => adoptSessionEvent(event)).toThrow(/must reference earlier events/)
    expect(() => snapshotSessionEvent(event)).toThrow(/must reference earlier events/)
  })

  it('adoption validates only local metadata, not referenced history or endpoint order', () => {
    const event: SessionEvent<'user/message'> = { ...userEvent(), seq: SessionSeq(12), surfaceOp: { op: 'replace', startSeq: SessionSeq(11), endSeq: SessionSeq(4) }, sourceEventSeqs: [SessionSeq(11), SessionSeq(4)] }
    expect(adoptSessionEvent(event)).toBe(event)
    expect(snapshotSessionEvent(event)).toEqual(event)
  })

  it('requires surface intent on event variants and forbids assistant source-event references in types', () => {
    expectTypeOf<SurfaceEvent>().toEqualTypeOf<SessionEvent<SurfaceEventType>>()
    expectTypeOf<Omit<SessionEvent<'user/message'>, 'surfaceOp'>>().not.toExtend<SessionEvent<'user/message'>>()
    expectTypeOf<{ surfaceOp: 'append'; sourceEventSeqs: SessionSeq[] }>().not.toExtend<SurfaceIntent<'assistant/message'>>()
    expectTypeOf<{ op: 'replace'; start: SessionSeq; end: SessionSeq }>().not.toExtend<SurfaceOp>()
    expectTypeOf<SessionEvent<'system/message'>['surfaceOp']>().toEqualTypeOf<SurfaceOp>()
    expectTypeOf<SurfaceIntent<'system/message'>['sourceEventSeqs']>().toEqualTypeOf<SessionSeq[] | undefined>()
    expectTypeOf<SessionEvent<'user/message'>['surfaceOp']>().toEqualTypeOf<SurfaceOp>()
    expectTypeOf<SessionEvent<'assistant/message'>['sourceEventSeqs']>().toEqualTypeOf<undefined>()
    expectTypeOf<SessionEvent<'turn/start'>['surfaceOp']>().toEqualTypeOf<undefined>()
    expectTypeOf<SessionEvent<'turn/start'>['sourceEventSeqs']>().toEqualTypeOf<undefined>()
    expectTypeOf<SurfaceIntent<'assistant/message'>['sourceEventSeqs']>().toEqualTypeOf<undefined>()
    expectTypeOf<Extract<SurfaceOp, { op: 'replace' }>['startSeq']>().toEqualTypeOf<SessionSeq>()
    expectTypeOf<Extract<SurfaceOp, { op: 'replace' }>['endSeq']>().toEqualTypeOf<SessionSeq>()
  })
})
