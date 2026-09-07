import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, createMessage, createToolResultMessage, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  adoptSessionEvent,
  SESSION_FORMAT_VERSION,
  Session,
  SessionEvent,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  snapshotSessionEvent,
} from '@deepseek-ai/dsh-session'
import type { CreateSessionOptions, SessionEventType, SessionHeader, SessionSurface } from '@deepseek-ai/dsh-session'

describe('Session', () => {
  it('exposes one stable readonly surface view', () => {
    const session = Session.create(SessionId('surface-view'))
    const surface = session.surface

    expectTypeOf(surface).toEqualTypeOf<SessionSurface>()
    expect(surface).toBe(session.surface)
  })

  it('derives message history from the event log', () => {
    const session = Session.create(SessionId('s1'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/attempt', {
      turn: 1, step: 1,
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['hi'] }],
    })
    session.append('assistant/message', {
      stream: [],
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{}' },
        ],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const messages = session.deriveMessages()
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    // raw chunks must NOT appear in derived history
    expect(messages[1]!.content).toHaveLength(2)
    expect(messages[2]!.content[0]).toMatchObject({ type: 'tool-result', toolCallId: ToolCallId('c1') })
  })

  it('accepts and round-trips a max-tokens turn/end reason', () => {
    // The max-tokens TurnEndReason variant carries no extra data, so it must
    // append and persist like any other reason (JSON-serializable, no fields).
    const session = Session.create(SessionId('s1'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })

    const turnEnd = session.snapshotEvents().findLast(e => e.type === 'turn/end')!
    expect(turnEnd.data.reason).toEqual({ kind: 'max-tokens' })
    // survives a structuredClone (the persistence-serialization boundary)
    expect(structuredClone(turnEnd.data.reason)).toEqual({ kind: 'max-tokens' })
  })

  it('round-trips an aborted turn with its cancellation cause', () => {
    const session = Session.create(SessionId('aborted'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    const replayed = Session.create(SessionId('aborted-replay'), structuredClone(session.snapshotEvents()))
    expect(replayed.snapshotEvents().slice(0, -1)).toEqual(session.snapshotEvents())
    const turnEnd = replayed.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('renders injected-context and user messages as plain user content', () => {
    const session = Session.create(SessionId('s2'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'file changed: a.ts' }],
      source: { kind: 'plugin', plugin: 'watcher' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'focus on tests' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const [contextMessage, steeringMessage] = session.deriveMessages()
    expect(contextMessage!.role).toBe('user')
    expect(contextMessage!.content).toEqual([{ type: 'text', text: 'file changed: a.ts' }])
    expect(steeringMessage!.role).toBe('user')
    expect(steeringMessage!.content).toEqual([{ type: 'text', text: 'focus on tests' }])
  })

  it('keeps the exact identified context message in durable history and projection', () => {
    const session = Session.create(SessionId('s2-raw'))
    const message = createUserMessage({
      content: [{ type: 'text', text: '<system-reminder>Additional instructions from: pkg/AGENTS.md</system-reminder>' }],
      source: { kind: 'plugin', plugin: 'agent-instructions' },
    })
    session.append('user/message', message, { surfaceOp: 'append' })

    expect(session.deriveMessages()).toEqual([message])
    const event = session.snapshotEvents()[0]
    expect(event?.type === 'user/message' && event.data.source).toEqual({ kind: 'plugin', plugin: 'agent-instructions' })
  })

  it('replays identically from a seeded event log', () => {
    const original = Session.create(SessionId('s3'))
    original.append('turn/start', { turn: 1 })
    original.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    original.append('assistant/message', {
      stream: [],
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const replayed = Session.create(SessionId('s3-replay'), original.snapshotEvents())
    expect(replayed.deriveMessages()).toEqual(original.deriveMessages())
    // The seed verbatim, plus the end-seed event the constructor appends.
    expect(replayed.snapshotEvents().slice(0, original.seq)).toEqual(original.snapshotEvents())
    expect(replayed.seq).toBe(original.seq + 1)
    expect(replayed.firstLiveSeq).toBe(original.seq)
  })

  it('marks an explicitly empty seed without marking a fresh session', () => {
    const fresh = Session.create(SessionId('fresh-empty'))
    expect(fresh.snapshotEvents()).toEqual([])

    const resumed = Session.create(SessionId('resumed-empty'), [])
    expect(resumed.firstLiveSeq).toBe(0)
    expect(resumed.snapshotEvents()).toMatchObject([
      { type: 'session/end-seed', seq: 0, data: {} },
    ])

    const reopened = Session.create(SessionId('reopened-empty'), resumed.snapshotEvents())
    expect(reopened.firstLiveSeq).toBe(1)
    expect(reopened.snapshotEvents()).toEqual(resumed.snapshotEvents())
  })

  it('rejects pre-provider request headers and assistant messages on seed/load', () => {
    const requestHeader = {
      type: 'request/header', seq: 0, time: 1,
      data: { header: { config: { model: 'old-model' } }, reason: 'initial' },
    } as unknown as SessionEvent
    expect(() => Session.create(SessionId('old-header'), [requestHeader]))
      .toThrow('seed request/header at index 0 lacks provider/model')

    const assistantMessage = {
      type: 'assistant/message', seq: 0, time: 1,
      data: { turn: 1, step: 1, content: [{ type: 'text', text: 'old' }] },
      surfaceOp: 'append',
    } as unknown as SessionEvent
    expect(() => Session.create(SessionId('old-assistant'), [assistantMessage]))
      .toThrow('seed assistant/message at index 0 lacks an identified message')

    const malformedHeader = {
      type: 'request/header', seq: 0, time: 1,
      data: { header: 'old-header' },
    } as unknown as SessionEvent
    expect(() => Session.create(SessionId('malformed-header'), [malformedHeader]))
      .toThrow('seed request/header at index 0 lacks provider/model')

    const unrelatedPrimitiveData = {
      type: 'plugin/event', seq: 0, time: 1, data: null,
    } as unknown as SessionEvent
    expect(Session.create(SessionId('primitive-plugin-data'), [unrelatedPrimitiveData]).snapshotEvents().slice(0, 1))
      .toEqual([unrelatedPrimitiveData])
  })

  it('validates Assistant settlement fields without replaying embedded streams', () => {
    const id = SessionId('invalid-restored-assistant-stream')
    const header = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
    } as const
    for (const data of [
      null,
      { turn: '1', step: 1, stream: [] },
      { turn: -1, step: 1, stream: [] },
      { turn: -0, step: 1, stream: [] },
      { turn: 1.5, step: 1, stream: [] },
      { turn: 1, step: '1', stream: [] },
      { turn: 1, step: -1, stream: [] },
      { turn: 1, step: -0, stream: [] },
      { turn: 1, step: 1.5, stream: [] },
      { turn: 1, step: 1, stream: null },
    ]) {
      const invalidAttempt = {
        type: 'assistant/attempt', seq: 0, time: 1, data,
      } as unknown as SessionEvent
      expect(() => Session.fromRestore(
        id,
        [invalidAttempt],
        header,
        SessionLogOffset(0),
        'detached',
      ))
        .toThrow(/invalid settlement fields/)
    }

    const mismatchedMessage = {
      type: 'assistant/message',
      seq: 0,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'different' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['streamed'] }],
      },
      surfaceOp: 'append',
    } as unknown as SessionEvent
    const restored = Session.fromRestore(
      id,
      [mismatchedMessage],
      header,
      SessionLogOffset(0),
      'detached',
    )
    expect(restored.eventAt(SessionSeq(0))).toBe(mismatchedMessage)
    expect(Object.isFrozen(mismatchedMessage)).toBe(false)
  })

  it('rejects historical or malformed request-header lifecycle markers on seed/load', () => {
    const base = {
      type: 'request/header', seq: SessionSeq(0), time: 1,
      data: { header: { config: { provider: 'mock', model: 'model' } }, reason: 'initial' },
    } as const
    for (const reason of ['fallback', 'unknown', null]) {
      const invalid = structuredClone(base) as unknown as SessionEvent
      if (invalid.type !== 'request/header') throw new Error('test fixture must be a request header')
      invalid.data.reason = reason as never
      expect(() => Session.create(SessionId('invalid-header-reason'), [invalid]))
        .toThrow('seed request/header at index 0 has an invalid reason')
    }
    for (const startsSeries of [false, 1, 'true']) {
      const invalid = structuredClone(base) as unknown as SessionEvent
      if (invalid.type !== 'request/header') throw new Error('test fixture must be a request header')
      invalid.data.startsSeries = startsSeries as never
      expect(() => Session.create(SessionId('invalid-series-marker'), [invalid]))
        .toThrow('seed request/header at index 0 has an invalid startsSeries marker')
    }
  })

  it('rejects event-specific malformed message shapes on seed/load', () => {
    const user = {
      id: 'user',
      role: 'user',
      content: [{ type: 'text', text: 'content' }],
      source: { kind: 'user' },
    }
    const assistant = {
      id: 'assistant',
      role: 'assistant',
      content: [{ type: 'text', text: 'content' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }
    const tool = {
      id: 'tool',
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call',
        content: [{ type: 'text', text: 'result' }],
      }],
      source: { kind: 'tool', callId: 'call' },
    }
    const invalid = [
      {
        name: 'message record',
        event: {
          type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
          data: null,
        },
        message: 'lacks an identified message',
      },
      {
        name: 'user role',
        event: {
          type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
          data: { ...user, role: 'assistant' },
        },
        message: 'message must have role "user"',
      },
      {
        name: 'source',
        event: {
          type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
          data: { ...user, source: null },
        },
        message: 'message has invalid source',
      },
      {
        name: 'content shape',
        event: {
          type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
          data: { ...user, content: 'not-an-array' },
        },
        message: 'message has invalid content',
      },
      {
        name: 'assistant source',
        event: {
          type: 'assistant/message', seq: 0, time: 1, surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: { ...assistant, source: { kind: 'user' } },
          },
        },
        message: 'message must have model source',
      },
      {
        name: 'tool source',
        event: {
          type: 'tool/result', seq: 0, time: 1, surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: { ...tool, source: { kind: 'user' } },
          },
        },
        message: 'message must have tool source',
      },
      {
        name: 'tool tuple',
        event: {
          type: 'tool/result', seq: 0, time: 1, surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: { ...tool, content: [{ type: 'text', text: 'not a result' }] },
          },
        },
        message: 'message must contain one tool-result block',
      },
      {
        name: 'tool correlation',
        event: {
          type: 'tool/result', seq: 0, time: 1, surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              ...tool,
              source: { kind: 'tool', callId: 'other-call' },
            },
          },
        },
        message: 'message has mismatched tool call ids',
      },
    ] as const

    for (const { name, event, message } of invalid) {
      expect(
        () => Session.create(SessionId(`invalid-${name}`), [event as unknown as SessionEvent]),
        name,
      ).toThrow(message)
    }
  })

  it('snapshots message events without validating plugin-owned block details', () => {
    const boundary = snapshotSessionEvent({
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
    })
    expect(boundary).toEqual({
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
    })

    const extended = snapshotSessionEvent({
      type: 'user/message',
      seq: SessionSeq(0),
      time: 1,
      surfaceOp: 'append',
      data: {
        id: 'extended-message',
        role: 'user',
        content: [{ type: 'plugin-block', value: 1 }],
        source: { kind: 'plugin-source', value: 1 },
      },
    } as unknown as SessionEvent)
    expect(extended.type === 'user/message' && extended.data.content)
      .toEqual([{ type: 'plugin-block', value: 1 }])
  })

  it('adopts exclusively owned messages in place and keeps snapshots detached', () => {
    const owned = {
      type: 'user/message',
      seq: 0,
      time: 1,
      surfaceOp: 'append',
      data: {
        id: 'owned-message',
        role: 'user',
        content: [{ type: 'text', text: 'owned' }],
        source: { kind: 'user' },
      },
    } as SessionEvent<'user/message'>
    expect(adoptSessionEvent(owned)).toBe(owned)
    expect(Object.isFrozen(owned.data)).toBe(true)
    expect(Object.isFrozen(owned.data.content)).toBe(true)

    const source = structuredClone(owned)
    const snapshot = snapshotSessionEvent(source)
    expect(snapshot).not.toBe(source)
    expect(snapshot.data).not.toBe(source.data)
    expect(snapshot.data.content).not.toBe(source.data.content)
  })

  it('validates message shape before adopting ownership', () => {
    const malformed = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: {
        id: 'wrong-role',
        role: 'assistant',
        content: [],
        source: { kind: 'user' },
      },
    } as unknown as SessionEvent
    expect(() => adoptSessionEvent(malformed)).toThrow('message must have role "user"')
  })

  it('round-trips a non-empty reasoning effort and rejects invalid durable values', () => {
    const valid = {
      type: 'request/header',
      seq: SessionSeq(0),
      time: 1,
      data: {
        header: {
          config: {
            provider: 'mock',
            model: 'model',
            reasoningEffort: ReasoningEffortId('adapter-owned'),
          },
        },
        reason: 'initial',
      },
    } as const
    expect(Session.create(SessionId('reasoning-effort'), [valid]).snapshotEvents()[0])
      .toEqual(valid)

    for (const reasoningEffort of ['', 1]) {
      const invalid = structuredClone(valid) as unknown as SessionEvent
      if (invalid.type !== 'request/header') throw new Error('test fixture must be a request header')
      const config = invalid.data.header.config as unknown as Record<string, unknown>
      config.reasoningEffort = reasoningEffort
      expect(() => Session.create(SessionId('invalid-reasoning-effort'), [invalid]))
        .toThrow('seed request/header at index 0 has an invalid reasoningEffort')
    }
  })

  it('round-trips adapter-default markers and rejects invalid durable values', () => {
    const valid = {
      type: 'request/header',
      seq: SessionSeq(0),
      time: 1,
      data: {
        header: {
          config: {
            provider: 'mock',
            model: 'model',
            maxTokens: 256_000,
          },
          adapterDefaults: { maxTokens: true },
        },
        reason: 'initial',
      },
    } as const
    expect(Session.create(SessionId('adapter-defaults'), [valid]).snapshotEvents()[0]).toEqual(valid)

    for (const adapterDefaults of [
      null,
      [],
      { unknown: true },
      { maxTokens: false },
      { reasoningEffort: true },
    ]) {
      const invalid = structuredClone(valid) as unknown as SessionEvent
      if (invalid.type !== 'request/header') throw new Error('test fixture must be a request header')
      invalid.data.header.adapterDefaults = adapterDefaults as never
      expect(() => Session.create(SessionId('invalid-adapter-defaults'), [invalid]))
        .toThrow('seed request/header at index 0 has invalid adapterDefaults')
    }
  })

  it('isolates the log from mutation through a derived message (append-only contract)', () => {
    const session = Session.create(SessionId('s4'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'tool out' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const before = structuredClone(session.snapshotEvents())

    // A misbehaving consumer tries to mutate the messages it was handed.
    const messages = session.deriveMessages()
    const userBlock = messages[0]!.content[0]!
    expect(() => { if (userBlock.type === 'text') userBlock.text = 'HACKED' }).toThrow(TypeError)
    const toolBlock = messages[1]!.content[0]!
    expect(() => {
      if (toolBlock.type === 'tool-result') toolBlock.content.push({ type: 'text', text: 'injected' })
    }).toThrow(TypeError)
    expect(() => { messages[0]!.content.push({ type: 'text', text: 'extra' }) }).toThrow(TypeError)
    // The returned ARRAY is the caller's own snapshot, though — reordering it
    // is the caller's business and never reaches the cache or the log.
    messages.reverse()

    // The log is unchanged: deep-equal to the snapshot taken before mutation.
    expect(session.snapshotEvents()).toEqual(before)
    // And a fresh derivation still reflects the original content and order.
    expect(session.deriveMessages()[0]!.content).toEqual([{ type: 'text', text: 'original' }])
  })

  it('rejects non-JSON-serializable event data at the source (incl. sparse arrays)', () => {
    const session = Session.create(SessionId('s5'))
    const bad = (extra: unknown) => () => session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra } as never, { surfaceOp: 'append' })
    expect(bad(1n)).toThrow(/non-JSON-serializable/)
    expect(bad(() => 0)).toThrow(/non-JSON-serializable/)
    expect(bad(Symbol('s'))).toThrow(/non-JSON-serializable/)
    expect(bad(new Map())).toThrow(/non-JSON-serializable/)
    expect(bad(undefined)).toThrow(/non-JSON-serializable/)
    expect(bad(Infinity)).toThrow(/non-JSON-serializable/)
    // A sparse array: `every` skips the hole but JSON.stringify writes it null.
    // Build the hole without a sparse literal or `delete` (both linted).
    const sparse: unknown[] = Array(3)
    sparse[0] = 1
    sparse[2] = 3 // index 1 stays a hole
    expect(bad(sparse)).toThrow(/non-JSON-serializable/)
    // A DENSE array carrying a non-serializable element is rejected too.
    expect(bad([1, 2n, 3])).toThrow(/non-JSON-serializable/)
    // A nested non-serializable value (inside a plain object) is rejected.
    expect(bad({ nested: { deep: () => 0 } })).toThrow(/non-JSON-serializable/)
    // A circular reference is rejected (the seen-set guard, not a stack blow-up).
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    expect(bad(cyclic)).toThrow(/non-JSON-serializable/)
    // The rejected appends never entered the log.
    expect(session.snapshotEvents()).toHaveLength(0)
  })

  it('rejects a surface-eligible append with no surfaceOp marker (runtime guard for the union-widening loophole)', () => {
    const session = Session.create(SessionId('s5b'))
    session.append('turn/start', { turn: 1 })
    // A widened SessionEventType bypasses the overload's conditional requirement,
    // so the runtime guard must still reject the missing surface marker.
    const widenedType = 'user/message' as SessionEventType
    expect(() => session.append(widenedType, createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    })))
      .toThrow(/surface-eligible and requires a surfaceOp marker/)
    // The rejected append never entered the log (only turn/start is present).
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('accepts dense arrays and nested plain objects', () => {
    const session = Session.create(SessionId('s6'))
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra: [1, 2, [3, { a: null, b: true }]] } as never, { surfaceOp: 'append' })).not.toThrow()
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('validates seed events: rejects a non-JSON-serializable seed', () => {
    // A replay/fork seed must satisfy the SAME invariant as Session.append, or
    // it builds a live log no backend can persist.
    const badSeed = [
      { type: 'user/message' as const, seq: 0, time: 1, data: { content: [{ type: 'text' as const, text: 'x' }], source: { kind: 'user' as const }, bad: 1n } },
    ] as unknown as SessionEvent[]
    expect(() => Session.create(SessionId('seed-bad'), badSeed)).toThrow(/losslessly JSON-serializable/)
  })

  it('validates seed events: rejects a non-contiguous seq', () => {
    const gapSeed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end' as const, seq: 5, time: 2, data: { turn: 1, reason: { kind: 'completed' as const } } }, // gap: expected seq 1
    ] as SessionEvent[]
    expect(() => Session.create(SessionId('seed-gap'), gapSeed)).toThrow(/contiguous|seq/)
  })

  it('validates seed events: rejects a surface-eligible event missing its surfaceOp marker', () => {
    // A surface-eligible event (user/message) with no surfaceOp would load fine
    // but vanish from deriveMessages() (the surface is the sole derivation path),
    // so a resume/fork would silently lose history. append() forbids this at
    // compile time; a raw seed must be rejected at runtime to match.
    const markerlessSeed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message' as const, seq: 1, time: 2, data: createUserMessage({
        content: [{ type: 'text' as const, text: 'hi' }], source: { kind: 'user' as const },
      }) },
      { type: 'turn/end' as const, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' as const } } },
    ] as SessionEvent[]
    expect(() => Session.create(SessionId('seed-no-marker'), markerlessSeed)).toThrow(/requires a surfaceOp marker/)
  })

  it('accepts a well-formed contiguous serializable seed', () => {
    const goodSeed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message' as const, seq: 1, time: 2, data: createUserMessage({
        content: [{ type: 'text' as const, text: 'hi' }], source: { kind: 'user' as const },
      }), surfaceOp: 'append' as const },
      { type: 'turn/end' as const, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' as const } } },
    ] as SessionEvent[]
    const session = Session.create(SessionId('seed-ok'), goodSeed)
    expect(session.snapshotEvents().slice(0, 3)).toEqual(goodSeed)
    expect(session.firstLiveSeq).toBe(3)
  })

  it('reads each seed array entry once so validation and storage use the same event', () => {
    const accepted = {
      type: 'turn/start' as const,
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }
    const drifted = { ...accepted, seq: 99, data: { invalid: 1n } }
    let reads = 0
    const seed = new Array<SessionEvent>(1)
    Object.defineProperty(seed, 0, {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? accepted : drifted
      },
    })

    const session = Session.create(SessionId('seed-entry-snapshot'), seed)

    expect(reads).toBe(1)
    expect(session.snapshotEvents().slice(0, 1)).toEqual([accepted])
  })

  it('reads a nested seed-data getter once and stores its first JSON value', () => {
    let reads = 0
    const data = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 'accepted' : 1n
      },
    })
    const seed = [{ type: 'test/unstable', seq: 0, time: 1, data }] as unknown as SessionEvent[]

    const session = Session.create(SessionId('seed-nested-drift'), seed)

    expect(reads).toBe(1)
    expect(session.snapshotEvents()[0]!.data).toEqual({ value: 'accepted' })
  })

  it('rejects non-JSON surface metadata in a seed event', () => {
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }),
      surfaceOp: { op: 'replace', start: 1n, end: 2 },
    }] as unknown as SessionEvent[]

    expect(() => Session.create(SessionId('seed-bad-metadata'), seed))
      .toThrow(/losslessly JSON-serializable/)
  })

  it('rejects exotic seed metadata before cloning can erase its prototype', () => {
    class ReplaceOp {
      readonly op = 'replace' as const
      readonly start = 0
      readonly end = 0
    }
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }),
      surfaceOp: new ReplaceOp(),
    }] as unknown as SessionEvent[]

    expect(() => Session.create(SessionId('seed-exotic-metadata'), seed))
      .toThrow(/losslessly JSON-serializable/)
  })

  it('rejects an exotic seed event shell before spreading erases its prototype', () => {
    class SeedEvent {
      readonly type = 'turn/start' as const
      readonly seq = SessionSeq(0)
      readonly time = 1
      readonly data = { turn: 1 }
    }
    const seed: SessionEvent[] = [new SeedEvent()]

    expect(() => Session.create(SessionId('seed-exotic-shell'), seed))
      .toThrow(/not losslessly JSON-serializable/)
  })

  it('accepts a null-prototype seed event shell as a plain JSON record', () => {
    const event = Object.assign(Object.create(null) as Record<string, unknown>, {
      type: 'turn/start' as const,
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }) as unknown as SessionEvent

    const session = Session.create(SessionId('seed-null-prototype'), [event])

    expect(session.snapshotEvents().slice(0, 1)).toEqual([{ ...event }])
  })

  it('reads a nested seed-metadata getter once and stores its first JSON value', () => {
    let reads = 0
    const surfaceOp = Object.defineProperty({ op: 'replace', end: 0 }, 'start', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 0 : 1n
      },
    })
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'source' }], source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    }, {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }),
      surfaceOp,
      sourceEventSeqs: [0],
    }] as unknown as SessionEvent[]

    const session = Session.create(SessionId('seed-unstable-metadata'), seed)
    const event = session.snapshotEvents()[1]!
    if (event.type !== 'user/message') throw new Error('test fixture must remain a user/message')

    expect(reads).toBe(1)
    expect(event.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
  })

  it.each([
    ['an Error', new Error('validator failed'), 'validator failed'],
    ['a non-Error value', 'validator failed', 'invalid surface metadata'],
  ] as const)('adds seed context when surface validation throws %s', (_name, failure, expected) => {
    const originalHasOwn = Object.hasOwn
    const hasOwn = vi.spyOn(Object, 'hasOwn').mockImplementation((object: object, property: PropertyKey): boolean => {
      if ((object as Record<string, unknown>)['op'] === 'replace') throw failure
      return originalHasOwn(object, property)
    })
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'source' }], source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    }, {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }),
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [0],
    }] as unknown as SessionEvent[]

    try {
      expect(() => Session.create(SessionId('seed-non-error-metadata-failure'), seed))
        .toThrow(`invalid seed event at index 1: ${expected}`)
    } finally {
      hasOwn.mockRestore()
    }
  })

  it('snapshots the seed: mutating the original after construction does not affect session.snapshotEvents()', () => {
    const seed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message' as const, seq: 1, time: 2, data: {
        id: MessageId('seed-input'),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'original' }], source: { kind: 'user' as const },
      }, surfaceOp: 'append' as const },
      { type: 'turn/end' as const, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' as const } } },
    ] as SessionEvent[]
    const session = Session.create(SessionId('seed-snapshot'), seed)
    // Mutate the ORIGINAL seed objects after construction: a shared reference
    // would let this rewrite the forked log (or reintroduce non-serializable
    // data past validation). The snapshot must shield session.snapshotEvents().
    const um = seed[1]!
    ;(um.data as { content: { type: 'text'; text: string }[] }).content[0]!.text = 'HACKED'
    ;(um.data as Record<string, unknown>)['injected'] = 1n // would have failed validation
    const logged = session.snapshotEvents()[1]!
    expect(logged.type === 'user/message' && (logged.data.content[0] as { text: string }).text).toBe('original')
    expect((logged.data as Record<string, unknown>)['injected']).toBeUndefined()
  })

  it('snapshots append data: mutating the passed object after append does not affect session.snapshotEvents()', () => {
    const session = Session.create(SessionId('append-snapshot'))
    const data = {
      id: MessageId('append-input'),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'original' }],
      source: { kind: 'user' as const },
    }
    const event = session.append('user/message', data, { surfaceOp: 'append' })
    // Mutate the caller's object after append returns. A shared reference would
    // make session.snapshotEvents() diverge from the value that passed validation.
    data.content[0]!.text = 'HACKED'
    ;(data as Record<string, unknown>)['injected'] = 1n
    const logged = session.snapshotEvents()[0]!
    expect(logged.type === 'user/message' && (logged.data.content[0] as { text: string }).text).toBe('original')
    expect((logged.data as Record<string, unknown>)['injected']).toBeUndefined()
    // The returned event carries the same snapshot, not the caller's input.
    expect((event.data.content[0] as { text: string }).text).toBe('original')
  })

  it('reads a nested append-data getter once and stores its first JSON value', () => {
    const session = Session.create(SessionId('append-nested-drift'))
    let reads = 0
    const data = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 'accepted' : 1n
      },
    })

    const event = session.append('request/context', data as never)

    expect(reads).toBe(1)
    expect(event.data).toEqual({ value: 'accepted' })
    expect(session.snapshotEvents()).toEqual([event])
  })

  it('rejects non-JSON surface metadata before appending the event', () => {
    const session = Session.create(SessionId('append-bad-metadata'))

    expect(() => session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }),
      { surfaceOp: { op: 'replace', start: 1n, end: 2 } } as never,
    )).toThrow(/non-JSON-serializable surface metadata/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('rejects exotic surface metadata before cloning can erase its prototype', () => {
    class ReplaceOp {
      readonly op = 'replace' as const
      readonly start = SessionSeq(0)
      readonly end = SessionSeq(0)
    }
    const session = Session.create(SessionId('append-exotic-metadata'))

    expect(() => session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }),
      { surfaceOp: new ReplaceOp() },
    )).toThrow(/non-JSON-serializable surface metadata/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('reads a nested append-metadata getter once and stores its first JSON value', () => {
    const session = Session.create(SessionId('append-unstable-metadata'))
    const source = session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'source' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    let reads = 0
    const surfaceOp = Object.defineProperty({ op: 'replace', end: 0 }, 'start', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 0 : 1n
      },
    })

    const event = session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
      }),
      { surfaceOp, sourceEventSeqs: [0] } as never,
    )

    expect(reads).toBe(1)
    expect(event.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
    expect(session.snapshotEvents()).toEqual([source, event])
  })

  it('rejects invalid plain surface metadata shapes at append', () => {
    const session = Session.create(SessionId('append-invalid-surface-shape'))
    const appendRaw = session.append.bind(session) as unknown as (
      type: SessionEventType,
      data: unknown,
      opts?: unknown,
    ) => SessionEvent
    const data = { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }

    expect(() => appendRaw('user/message', data, { surfaceOp: 'invalid' }))
      .toThrow(/invalid surfaceOp/)
    expect(() => appendRaw('user/message', data, {
      surfaceOp: { op: 'replace', start: -1, end: 0 },
    })).toThrow(/invalid replace surfaceOp/)
    expect(() => appendRaw('user/message', data, {
      surfaceOp: 'append',
      sourceEventSeqs: [0, -1],
    })).toThrow(/non-negative safe integers/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('rejects surface metadata on non-surface append and seed events', () => {
    const session = Session.create(SessionId('non-surface-metadata'))
    const appendRaw = session.append.bind(session) as unknown as (
      type: SessionEventType,
      data: unknown,
      opts?: unknown,
    ) => SessionEvent

    expect(() => appendRaw(
      'turn/start',
      { turn: 1 },
      { surfaceOp: 'append' },
    )).toThrow(/not surface-eligible and cannot carry surfaceOp/)
    expect(() => Session.create(SessionId('non-surface-metadata-seed'), [{
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
      surfaceOp: 'append',
    } as unknown as SessionEvent])).toThrow(/invalid seed event.*not surface-eligible/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('deep-freezes seeded and appended event snapshots', () => {
    const seeded = Session.create(SessionId('seed-frozen'), [{
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
    }])
    const seededEvent = seeded.snapshotEvents()[0]!
    if (seededEvent.type !== 'turn/start') throw new Error('test fixture must remain a turn/start')
    expect(Object.isFrozen(seededEvent)).toBe(true)
    expect(Object.isFrozen(seededEvent.data)).toBe(true)
    expect(() => { seededEvent.data.turn = 99 }).toThrow(TypeError)

    const appended = Session.create(SessionId('append-frozen'))
    const appendedEvent = appended.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(Object.isFrozen(appendedEvent)).toBe(true)
    expect(Object.isFrozen(appendedEvent.data)).toBe(true)
    expect(Object.isFrozen(appendedEvent.data.content)).toBe(true)
    expect(Object.isFrozen(appendedEvent.data.content[0])).toBe(true)
    expect(() => { (appendedEvent.data.content[0] as { text: string }).text = 'mutated' }).toThrow(TypeError)
  })

  it('returns cached frozen event-array snapshots that do not grow after append', () => {
    const session = Session.create(SessionId('events-snapshot'))
    session.append('turn/start', { turn: 1 })
    const before = session.snapshotEvents()
    const beforeEvent = before[0]!
    if (beforeEvent.type !== 'turn/start') throw new Error('test fixture must remain a turn/start')

    expect(session.snapshotEvents()).toBe(before)
    expect(Object.isFrozen(before)).toBe(true)
    expect(() => { (before as SessionEvent[]).push(beforeEvent) }).toThrow(TypeError)
    expect(() => { beforeEvent.data.turn = 99 }).toThrow(TypeError)

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const after = session.snapshotEvents()
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(2)
    expect(after).not.toBe(before)
    expect(session.snapshotEvents()).toBe(after)
  })

  it('reads one event without materializing an array and snapshots half-open ranges', () => {
    const session = Session.create(SessionId('event-reads'))
    const start = session.append('turn/start', { turn: 1 })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(session.eventAt(SessionSeq(0))).toBe(start)
    expect(session.eventAt(SessionSeq(1))).toBe(end)
    expect(session.eventAt(SessionSeq(2))).toBeUndefined()

    const range = session.snapshotEvents(SessionLogOffset(1), SessionLogOffset(2))
    expect(range).toEqual([end])
    expect(Object.isFrozen(range)).toBe(true)

    session.append('turn/start', { turn: 2 })
    expect(range).toEqual([end])
  })

  it('detaches and freezes an explicitly supplied session header', () => {
    const input = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('header-owned'),
      createdAt: 123,
      cwd: '/accepted',
      parentSession: SessionId('parent'),
      isSeeded: true,
    } satisfies SessionHeader

    const session = Session.create(SessionId('header-owned'), [], input, SessionLogOffset(0))
    input.cwd = '/caller-mutated'

    expect(session.header).toEqual({
      version: SESSION_FORMAT_VERSION,
      id: 'header-owned',
      createdAt: 123,
      cwd: '/accepted',
      parentSession: 'parent',
      isSeeded: true,
    })
    expect(session.header).not.toBe(input)
    expect(Object.isFrozen(session.header)).toBe(true)
    expect(Reflect.set(session.header, 'cwd', '/published-mutated')).toBe(false)
    expect(session.id).toBe('header-owned')
    expect(session.header.cwd).toBe('/accepted')
  })

  it('rejects an exotic, non-JSON, or mismatched supplied header', () => {
    class ExoticHeader implements SessionHeader {
      readonly version = SESSION_FORMAT_VERSION
      readonly id = SessionId('header-invalid')
      readonly createdAt = 123
      readonly isSeeded = false
    }

    expect(() => Session.create(SessionId('header-invalid'), undefined, new ExoticHeader()))
      .toThrow(/not losslessly JSON-serializable/)
    expect(() => Session.fromRestore(
      SessionId('header-invalid'),
      [],
      new ExoticHeader(),
      SessionLogOffset(0),
      'detached',
    ))
      .toThrow(/not a plain JSON record/)
    for (const header of [null, 1, []]) {
      expect(() => Session.fromRestore(
        SessionId('header-invalid'),
        [],
        header as unknown as SessionHeader,
        SessionLogOffset(0),
        'detached',
      )).toThrow(/not a plain JSON record/)
    }
    expect(() => Session.create(SessionId('header-invalid'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('header-invalid'),
      createdAt: 123,
      isSeeded: false,
      parentSession: 1n,
    } as unknown as SessionHeader)).toThrow(/not losslessly JSON-serializable/)
    expect(() => Session.create(SessionId('header-invalid'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('other'),
      createdAt: 123,
      isSeeded: false,
    })).toThrow(/does not match session id/)
  })

  it('rejects invalid scalar fields in an explicitly supplied header', () => {
    const base = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('header-shape'),
      createdAt: 123,
      isSeeded: false,
    }
    const cases: Array<{ header: unknown; error: RegExp }> = [
      { header: 1, error: /not a plain JSON record/ },
      { header: null, error: /not a plain JSON record/ },
      { header: { ...base, version: SESSION_FORMAT_VERSION + 1 }, error: /header version/ },
      { header: { ...base, createdAt: '123' }, error: /createdAt must be a non-negative safe integer/ },
      { header: { ...base, cwd: 1 }, error: /header cwd must be a string/ },
      { header: { ...base, cwd: 'relative' }, error: /header cwd must be an absolute path/ },
      { header: { ...base, parentSession: 1 }, error: /header parentSession must be a string/ },
      { header: { ...base, isSeeded: 'yes' }, error: /isSeeded must be a boolean/ },
      { header: { ...base, seedLength: 1 }, error: /invalid field "seedLength"/ },
    ]

    for (const { header, error } of cases) {
      expect(() => Session.create(SessionId('header-shape'), undefined, header as SessionHeader)).toThrow(error)
    }
  })

  it('retains opaque logical header metadata except the physical v0 seed field', () => {
    const id = SessionId('header-extension')
    const session = Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 123,
      isSeeded: false,
      extension: { value: 'kept' },
    } as SessionHeader)

    expect((session.header as SessionHeader & { extension: { value: string } }).extension)
      .toEqual({ value: 'kept' })
  })

  it('rejects seed records with invalid fixed-envelope fields', () => {
    const base = {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }
    const cases: unknown[] = [
      { ...base, extra: true },
      { ...base, type: 1 },
      { ...base, seq: '0' },
      { ...base, seq: 0.5 },
      { ...base, seq: -1 },
      { ...base, time: '1' },
      { ...base, time: 0.5 },
      { type: base.type, seq: base.seq, time: base.time },
      { ...base, ignorable: false },
      { ...base, ignorable: 'yes' },
    ]

    for (const [index, event] of cases.entries()) {
      expect(() => Session.create(SessionId(`bad-envelope-${index}`), [event as SessionEvent]))
        .toThrow(/invalid event envelope/)
    }

    // `ignorable: true` is the one accepted marker value (unknown-type skip contract).
    const marked = Session.create(SessionId('ignorable-envelope'), [
      { ...base, ignorable: true } as SessionEvent,
    ])
    expect(marked.snapshotEvents()[0]?.ignorable).toBe(true)
  })
})


describe('SessionStore', () => {
  it('creates sessions, emits session/created and session/event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    const created: Session[] = []
    const events: [Session, SessionEvent][] = []
    ctx.on('session/created', session => void created.push(session))
    ctx.on('session/event', (session, event) => void events.push([session, event]))

    const session = ctx.sessions.create()
    expect(created).toEqual([session])

    // The store-owned append publication hooks are module-private. A JavaScript caller
    // may create an unrelated property with the old implementation's name,
    // but cannot suppress the durable event feed.
    expect(Reflect.set(session, 'onAppend', undefined)).toBe(true)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'x' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(events).toHaveLength(2)
    expect(events[1]![0]).toBe(session)
    expect(events[1]![1].type).toBe('user/message')

    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(ctx.sessions.list()).toEqual([session])
  })

  it('rejects duplicate ids and supports seeding', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const a = ctx.sessions.create(SessionId('fixed'))
    expect(() => ctx.sessions.create(SessionId('fixed'))).toThrow('already exists')

    a.append('turn/start', { turn: 1 })
    a.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const forked = ctx.sessions.create(SessionId('fork'), { seed: a.snapshotEvents() })
    expect(forked.deriveMessages()).toEqual(a.deriveMessages())
  })

  it('enter() rejects a stale prepared session whose id is already live (no overwrite)', async () => {
    // A stale prepared object must not replace the live same-id entry; its later
    // detach would otherwise remove the wrong session.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const stale = ctx.sessions.prepare(SessionId('racy'))
    const live = ctx.sessions.create(SessionId('racy'))
    expect(() => ctx.sessions.enter(stale)).toThrow(/already exists/)
    // The live session is intact and still the store entry.
    expect(ctx.sessions.get(SessionId('racy'))).toBe(live)
  })

  it('prepare() + enter() + announce() register a session and emit session/created', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const created: Session[] = []
    ctx.on('session/created', session => void created.push(session))

    const session = ctx.sessions.prepare(SessionId('lifecycle'))
    // prepare alone does NOT enter the store.
    expect(ctx.sessions.get(SessionId('lifecycle'))).toBeUndefined()
    const detach = ctx.sessions.enter(session)
    expect(ctx.sessions.get(SessionId('lifecycle'))).toBe(session)
    // enter does NOT announce.
    expect(created).toEqual([])
    ctx.sessions.announce(session)
    expect(created).toEqual([session])
    // The detach disposer removes the entry + stops notification.
    detach()
    detach() // idempotent: cannot disturb a later same-id lifecycle
    expect(ctx.sessions.get(SessionId('lifecycle'))).toBeUndefined()
  })

  it('prevents simultaneous attachment of one session object to two stores', async () => {
    const firstCtx = new Context()
    const secondCtx = new Context()
    await firstCtx.plugin(SessionStore)
    await secondCtx.plugin(SessionStore)
    const session = Session.create(SessionId('owned-key'))
    const detachFirst = firstCtx.sessions.enter(session)

    expect(() => secondCtx.sessions.enter(session)).toThrow(/already attached to a store/)
    expect(firstCtx.sessions.get(SessionId('owned-key'))).toBe(session)

    detachFirst()
    expect(firstCtx.sessions.get(SessionId('owned-key'))).toBeUndefined()
    const detachSecond = secondCtx.sessions.enter(session)
    expect(secondCtx.sessions.get(SessionId('owned-key'))).toBe(session)
    detachSecond()

  })

  it('rejects direct and reentrant repeat announcements to preserve one lifecycle pair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let created = 0
    let disposed = 0
    let reentrantError = ''
    ctx.on('session/created', (session) => {
      created += 1
      try {
        ctx.sessions.announce(session)
      } catch (error: unknown) {
        reentrantError = String(error)
      }
    })
    ctx.on('session/disposed', () => { disposed += 1 })

    const session = ctx.sessions.prepare(SessionId('once'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    expect(reentrantError).toMatch(/already announced/)
    expect(() => { ctx.sessions.announce(session) }).toThrow(/already announced/)
    detach()
    expect({ created, disposed }).toEqual({ created: 1, disposed: 1 })
  })

  it('defers a reentrant detach until the creation dispatch unwinds', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const order: string[] = []
    const session = ctx.sessions.prepare(SessionId('reentrant-detach'))
    const detach = ctx.sessions.enter(session)

    ctx.on('session/created', (created) => {
      order.push('created:first')
      detach()
      expect(ctx.sessions.get(created.id)).toBe(created)
    })
    ctx.on('session/created', (created) => {
      order.push('created:second')
      expect(ctx.sessions.get(created.id)).toBe(created)
    })
    ctx.on('session/disposed', (disposed) => {
      order.push('disposed')
      expect(ctx.sessions.get(disposed.id)).toBeUndefined()
    })

    ctx.sessions.announce(session)

    expect(order).toEqual(['created:first', 'created:second', 'disposed'])
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    detach()
  })

  it('rolls back create when its owner unloads from session/created', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let ownerCtx!: Context
    const owner = await ctx.plugin(Object.assign((inner: Context) => { ownerCtx = inner }, { inject: ['sessions'] }))
    const id = SessionId('create-unload-race')
    ctx.on('session/created', (session) => {
      if (session.id === id) void owner.dispose()
    })

    ownerCtx.sessions.create(id)
    await owner.dispose()
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('synthesizes a minimal current-version header for a bare-created session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('plain'))
    expect(session.header).toMatchObject({ version: SESSION_FORMAT_VERSION, id: 'plain', isSeeded: false })
    expect(Number.isSafeInteger(session.header.createdAt)).toBe(true)
    expect(session.header.cwd).toBeUndefined()
    expect(session.header.parentSession).toBeUndefined()
  })

  it('attaches cwd and parentSession from meta to the header', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('child'), {
      meta: { cwd: '/work/project', parentSession: SessionId('parent') },
    })
    expect(session.header).toMatchObject({
      version: SESSION_FORMAT_VERSION,
      id: 'child',
      cwd: '/work/project',
      parentSession: 'parent',
      isSeeded: false,
    })
  })

  it('attaches subagent origin and delegationDepth from meta to the header', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('delegated-child'), {
      meta: { parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 2 },
    })
    expect(session.header).toMatchObject({
      id: 'delegated-child',
      parentSession: 'parent',
      origin: 'subagent',
      delegationDepth: 2,
    })
  })

  it('rejects non-JSON and invalid scalar session metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const cases: Array<{ meta: unknown; error: RegExp }> = [
      { meta: { parentSession: 1n }, error: /header is not losslessly JSON-serializable/ },
      { meta: { cwd: 1 }, error: /header cwd must be a string/ },
      { meta: { parentSession: 1 }, error: /header parentSession must be a string/ },
      { meta: { createdAt: '123' }, error: /header createdAt must be a non-negative safe integer/ },
      { meta: { createdAt: 1.5 }, error: /header createdAt must be a non-negative safe integer/ },
      { meta: { createdAt: -1 }, error: /header createdAt must be a non-negative safe integer/ },
      { meta: { createdAt: Number.MAX_SAFE_INTEGER + 1 }, error: /header createdAt must be a non-negative safe integer/ },
      { meta: { isSeeded: 'yes' }, error: /isSeeded must be a boolean/ },
      { meta: { origin: 'fork' }, error: /origin must be "subagent"/ },
      { meta: { delegationDepth: '1' }, error: /delegationDepth must be a non-negative safe integer/ },
      { meta: { delegationDepth: 0.5 }, error: /delegationDepth must be a non-negative safe integer/ },
      { meta: { delegationDepth: -1 }, error: /delegationDepth must be a non-negative safe integer/ },
      { meta: { agentPreset: 1 }, error: /agentPreset must be a string/ },
    ]

    for (const [index, { meta, error }] of cases.entries()) {
      expect(() => ctx.sessions.prepare(SessionId(`bad-meta-${index}`), {
        meta: meta as NonNullable<CreateSessionOptions['meta']>,
      })).toThrow(error)
    }
  })

  it('rejects a non-absolute meta.cwd', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    expect(() => ctx.sessions.create(SessionId('rel'), { meta: { cwd: 'relative/path' } }))
      .toThrow(/cwd must be an absolute path/)
    // the rejected session was not registered
    expect(ctx.sessions.get(SessionId('rel'))).toBeUndefined()
  })

  it('a bare Session() constructed without the store still exposes a current-version header', () => {
    const session = Session.create(SessionId('bare'))
    expect(session.header).toMatchObject({ version: SESSION_FORMAT_VERSION, id: 'bare', isSeeded: false })
    expect(typeof session.header.createdAt).toBe('number')
  })

  it('detaches sessions when the creating fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    let session!: Session
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('scoped'))
    }, { inject: ['sessions'] }))
    expect(ctx.sessions.get(SessionId('scoped'))).toBe(session)

    let observed = 0
    ctx.on('session/event', () => void observed++)

    await fiber.dispose()
    expect(ctx.sessions.get(SessionId('scoped'))).toBeUndefined()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'late' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(observed).toBe(0)
  })

  it('pairs a partial session/created announcement with disposal during rollback', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    let threw = false
    const disposed: Session[] = []
    ctx.on('session/disposed', (session) => { disposed.push(session) })
    ctx.on('session/created', () => {
      if (!threw) { threw = true; throw new Error('boom created listener') }
    })

    // The throwing emit must roll the store entry back, not leak it.
    expect(() => ctx.sessions.create(SessionId('fixed'))).toThrow('boom created listener')
    expect(ctx.sessions.get(SessionId('fixed'))).toBeUndefined() // rolled back, not leaked
    expect(disposed.map(session => session.id)).toEqual(['fixed'])

    // A subsequent create of the SAME id succeeds (the already-exists check is
    // not wedged) and its store-owned publication hooks are correctly wired.
    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => void events.push(event))
    const session = ctx.sessions.create(SessionId('fixed'))
    expect(ctx.sessions.get(SessionId('fixed'))).toBe(session)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(events.at(-1)?.type).toBe('user/message')
  })

  it('contains session/event observer failures after the append commit point', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const session = ctx.sessions.create(SessionId('contained-event'))
    const heard: SessionEvent[] = []
    let committedBeforeNotify = false
    ctx.on('session/event', (observedSession, event) => {
      committedBeforeNotify = observedSession.snapshotEvents().at(-1) === event
      throw new Error('sync event observer')
    })
    ctx.on('session/event', () => Promise.reject(new Error('async event observer')) as never)
    ctx.on('session/event', (_observedSession, event) => { heard.push(event) })

    let appended!: SessionEvent
    expect(() => {
      appended = session.append('turn/start', {
        turn: 1,
      })
    }).not.toThrow()
    expect(committedBeforeNotify).toBe(true)
    expect(session.snapshotEvents()).toEqual([appended])
    expect(heard).toEqual([appended])
    await Promise.resolve()
    await Promise.resolve()

    expect(warnings).toEqual([
      'session "contained-event": session/event listener threw: Error: sync event observer',
      'session "contained-event": session/event listener rejected: Error: async event observer',
    ])
  })

  it('runs internal dispatch validation on one frozen candidate before commit and resets after a veto', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('dispatch-veto'))
    const validations: Array<{ event: SessionEvent; logLength: number; frozen: boolean }> = []
    const observed: SessionEvent[] = []
    let reject = true
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const [observedSession, event] = args as [Session, SessionEvent]
      validations.push({
        event,
        logLength: observedSession.snapshotEvents().length,
        frozen: Object.isFrozen(event) && Object.isFrozen(event.data),
      })
      if (reject) {
        reject = false
        throw new Error('reject first candidate')
      }
    })
    ctx.on('session/event', (_observedSession, event) => { observed.push(event) })

    expect(() => session.append('turn/start', {
      turn: 1,
    })).toThrow('reject first candidate')
    expect(session.snapshotEvents()).toEqual([])
    expect(observed).toEqual([])

    const appended = session.append('turn/start', {
      turn: 1,
    })
    expect(validations.map(({ logLength, frozen }) => ({ logLength, frozen }))).toEqual([
      { logLength: 0, frozen: true },
      { logLength: 0, frozen: true },
    ])
    expect(validations.map(({ event }) => event.seq)).toEqual([0, 0])
    expect(validations[1]!.event).toBe(appended)
    expect(session.snapshotEvents()).toEqual([appended])
    expect(observed).toEqual([appended])
  })

  it('does not publish a surface transition rejected by internal dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('surface-dispatch-veto'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'source' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const surface = session.surface
    let reject = true
    ctx.on('internal/dispatch', (_mode, name) => {
      if (name === 'session/event' && reject) {
        reject = false
        throw new Error('reject surface candidate')
      }
    })

    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: SessionSeq(2), end: SessionSeq(2) },
      sourceEventSeqs: [SessionSeq(2)],
    })).toThrow('reject surface candidate')

    expect(session.snapshotEvents()).toHaveLength(3)
    expect(surface.nodes).toEqual([2])
    expect(surface.replaceGeneration).toBe(0)

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'next' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(surface.nodes).toEqual([2, 3])
    expect(surface.replaceGeneration).toBe(0)
  })

  it('resolves session/event dispatch before commit so instrumentation failure cannot hide a logged event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('dispatch-check'))
    const observed: SessionEvent[] = []
    ctx.on('internal/dispatch', (_mode, name) => {
      if (name === 'session/event') throw new Error('dispatch instrumentation rejected the carrier')
    })
    ctx.on('session/event', (_observedSession, event) => { observed.push(event) })

    expect(() => session.append('turn/start', {
      turn: 1,
    })).toThrow('dispatch instrumentation rejected the carrier')
    expect(session.snapshotEvents()).toEqual([])
    expect(observed).toEqual([])
  })

  it('contains a reentrant observer append without reordering later observers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const session = ctx.sessions.create(SessionId('reentrant-observer'))
    const heard: SessionEvent[] = []
    ctx.on('session/event', (observedSession) => {
      observedSession.append('request/context', { provider: 'mock', model: 'mock' })
    })
    ctx.on('session/event', (_observedSession, event) => { heard.push(event) })

    const appended = session.append('turn/start', {
      turn: 1,
    })
    expect(session.snapshotEvents()).toEqual([appended])
    expect(heard).toEqual([appended])
    expect(warnings).toEqual([
      'session "reentrant-observer": session/event listener threw: Error: session append cannot reenter while another append is being published',
    ])
  })

  it('defers detach through dispatch resolution, commit, and observer publication', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const order: string[] = []
    const session = ctx.sessions.prepare(SessionId('detach-during-append'))
    const detach = ctx.sessions.enter(session)
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const session = args[0] as Session
      order.push(`resolve:${ctx.sessions.get(session.id) === session ? 'live' : 'detached'}`)
      detach()
    })
    ctx.on('session/event', (session) => {
      order.push(`observe:${ctx.sessions.get(session.id) === session ? 'live' : 'detached'}`)
    })
    ctx.on('session/disposed', (session) => {
      order.push(`dispose:${ctx.sessions.get(session.id) === session ? 'live' : 'detached'}`)
    })
    ctx.sessions.announce(session)

    const appended = session.append('turn/start', {
      turn: 1,
    })

    expect(session.snapshotEvents()).toEqual([appended])
    expect(order).toEqual(['resolve:live', 'observe:live', 'dispose:detached'])
    expect(ctx.sessions.get(session.id)).toBeUndefined()
  })

  it('observes async session/created rejection without rolling back or starving peers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const heard: string[] = []
    ctx.on('session/created', () => Promise.reject(new Error('late creation failure')) as never)
    ctx.on('session/created', (session) => { heard.push(session.id) })

    const session = ctx.sessions.create(SessionId('async-created'))
    await Promise.resolve()
    await Promise.resolve()

    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(heard).toEqual(['async-created'])
    expect(warnings).toEqual([
      'session "async-created": session/created listener rejected: Error: late creation failure',
    ])
  })

  it('contains synchronous and async session/disposed listener failures per observer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const heard: string[] = []
    ctx.on('session/disposed', () => { throw new Error('sync disposed') })
    ctx.on('session/disposed', () => Promise.reject(new Error('async disposed')) as never)
    ctx.on('session/disposed', (session) => { heard.push(session.id) })

    const unannounced = ctx.sessions.prepare(SessionId('never-announced'))
    const detachUnannounced = ctx.sessions.enter(unannounced)
    detachUnannounced()
    expect(heard).toEqual([])

    const announced = ctx.sessions.prepare(SessionId('contained-disposal'))
    const detach = ctx.sessions.enter(announced)
    ctx.sessions.announce(announced)
    expect(() => { detach() }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(heard).toEqual(['contained-disposal'])
    expect(warnings).toEqual([
      'session "contained-disposal": session/disposed listener threw: Error: sync disposed',
      'session "contained-disposal": session/disposed listener rejected: Error: async disposed',
    ])
  })

  it('contains internal dispatch failure after session detachment', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const heard: Session[] = []
    ctx.on('internal/dispatch', (_mode, name) => {
      if (name === 'session/disposed') throw new Error('disposed dispatch instrumentation')
    })
    ctx.on('session/disposed', (session) => { heard.push(session) })
    const session = ctx.sessions.prepare(SessionId('disposed-dispatch'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)

    expect(() => { detach() }).not.toThrow()
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    expect(heard).toEqual([])
    expect(warnings).toEqual([
      'session "disposed-dispatch": session/disposed dispatch threw: Error: disposed dispatch instrumentation',
    ])
  })

  it('does not let internal dispatch replace the disposed callback tuple', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const replacement = Session.create(SessionId('replacement-disposed'))
    const heard: Session[] = []
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name === 'session/disposed') args[0] = replacement
    })
    ctx.on('session/disposed', (session) => { heard.push(session) })
    const session = ctx.sessions.prepare(SessionId('fixed-disposed-tuple'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)

    detach()

    expect(heard).toEqual([session])
  })
})
