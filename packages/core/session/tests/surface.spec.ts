import { describe, expect, it } from 'vitest'
import type { SessionEvent, SurfaceEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'
import {
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  foldSurface,
  isAppendSurfaceEvent,
  isReplacementSurfaceEvent,
  isSurfaceEligibleType,
  isSurfaceEvent,
} from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  ToolCallId,
  MessageId,
} from '@deepseek-ai/dsh-llm'

type TestSurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

function surfaceOp(value: TestSurfaceOp): SurfaceEvent['surfaceOp'] {
  return value === 'append'
    ? value
    : { op: 'replace', start: SessionSeq(value.start), end: SessionSeq(value.end) }
}

function sourceSeqs(...values: number[]) {
  return values.map(SessionSeq)
}

/** Build a minimal session with turn boundaries and a single user message. */
function surfaceSession(): Session {
  const s = Session.create(SessionId('ss'))
  s.append('turn/start', { turn: 1 })
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  s.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      source: {
        kind: 'model',
        ...{ provider: 'mock', model: 'mock' },
      },
    }),
  }, { surfaceOp: 'append' })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return s
}

function provenanceEvent(seq: SessionSeq, sourceEventSeqs: unknown): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: createUserMessage({
      content: [], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
  } as unknown as SessionEvent
}

function toolResultEvent(
  seq: SessionSeq,
  callId: string,
  op: TestSurfaceOp = 'append',
  sourceEventSeqs?: number[],
): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text: `result ${seq}` }],
        isError: false,
      }),
    },
    surfaceOp: surfaceOp(op),
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs: sourceSeqs(...sourceEventSeqs) },
  }
}

describe('foldSurface source-event references', () => {
  it('accepts absent or valid source-event references and complete replacement coverage', () => {
    const events = [
      provenanceEvent(SessionSeq(0), undefined),
      provenanceEvent(SessionSeq(1), undefined),
      {
        ...provenanceEvent(SessionSeq(2), [0, 1]),
        surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 1 }),
      },
    ] as SessionEvent[]
    expect(() => foldSurface(events)).not.toThrow()
  })

  it('rejects source-event references on a non-surface event', () => {
    const event = {
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
      sourceEventSeqs: sourceSeqs(0),
    } as unknown as SessionEvent
    expect(() => foldSurface([event])).toThrow(/cannot carry sourceEventSeqs/)
  })

  it('accepts an explicit empty source-event list on an assistant message', () => {
    const event = {
      type: 'assistant/message',
      seq: SessionSeq(0),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      surfaceOp: 'append',
      sourceEventSeqs: [],
    } as SessionEvent
    expect(() => foldSurface([event])).not.toThrow()
  })

  it.each([
    ['a non-array', [{ ...provenanceEvent(SessionSeq(0), undefined), sourceEventSeqs: 'invalid' }], /must be an array/],
    ['an empty array', [provenanceEvent(SessionSeq(0), [])], /must not be empty/],
    ['duplicates', [provenanceEvent(SessionSeq(0), undefined), provenanceEvent(SessionSeq(1), [0, 0])], /must not contain duplicates/],
    ['a sparse array', [provenanceEvent(SessionSeq(0), Array<number>(1))], /densely contain/],
    ['a non-number', [{ ...provenanceEvent(SessionSeq(0), undefined), sourceEventSeqs: ['0'] }], /non-negative safe integers/],
    ['a fractional number', [provenanceEvent(SessionSeq(0), [0.5])], /non-negative safe integers/],
    ['a negative number', [provenanceEvent(SessionSeq(0), [-1])], /non-negative safe integers/],
    ['a self reference', [provenanceEvent(SessionSeq(0), [0])], /must reference earlier events/],
    ['a non-contiguous event seq', [provenanceEvent(SessionSeq(0), undefined), provenanceEvent(SessionSeq(2), [1])], /seq 2 is not contiguous; expected 1/],
    ['incomplete replacement coverage', [
      provenanceEvent(SessionSeq(0), undefined),
      provenanceEvent(SessionSeq(1), undefined),
      { ...provenanceEvent(SessionSeq(2), [0]), surfaceOp: { op: 'replace', start: 0, end: 1 } },
    ], /missing 1/],
  ] as const)(
    'rejects %s',
    (_name, events, expected) => {
      expect(() => foldSurface(events as unknown as SessionEvent[])).toThrow(expected)
    },
  )
})

describe('foldSurface tool-result rewrites', () => {
  it('rejects a replacement spanning multiple current nodes', () => {
    const events = [
      provenanceEvent(SessionSeq(0), undefined),
      provenanceEvent(SessionSeq(1), undefined),
      toolResultEvent(SessionSeq(2), 'rewrite', { op: 'replace', start: 0, end: 1 }, [0, 1]),
    ]
    expect(() => foldSurface(events)).toThrow(/must rewrite exactly one current node/)
  })

  it('rejects a replacement targeting a non-result node', () => {
    const events = [
      provenanceEvent(SessionSeq(0), undefined),
      toolResultEvent(SessionSeq(1), 'rewrite', { op: 'replace', start: 0, end: 0 }, [0]),
    ]
    expect(() => foldSurface(events)).toThrow(/must target a current tool\/result/)
  })

  it('rejects changes outside tool-result content', () => {
    const events = [
      toolResultEvent(SessionSeq(0), 'original'),
      toolResultEvent(SessionSeq(1), 'changed', { op: 'replace', start: 0, end: 0 }, [0]),
    ]
    expect(() => foldSurface(events)).toThrow(/may change only content/)
  })

  it.each([
    ['toolCallId', { toolCallId: ToolCallId('changed') }],
    ['isError', { isError: true }],
  ] as const)('rejects a replacement that changes the result block %s', (_field, patch) => {
    const original = toolResultEvent(SessionSeq(0), 'original')
    const data = original.data as Extract<SessionEvent, { type: 'tool/result' }>['data']
    const result = data.message.content[0]
    const replacement = {
      ...original,
      seq: SessionSeq(1),
      time: 1,
      data: {
        ...data,
        message: freezeMessage({
          ...data.message,
          content: [{ ...result, ...patch }] as [typeof result],
        }),
      },
      surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 0 }),
      sourceEventSeqs: sourceSeqs(0),
    } as SessionEvent
    expect(() => foldSurface([original, replacement])).toThrow(/may change only content/)
  })

  it('compares array-valued rest fields structurally (meta arrays: equal accepted, drifted rejected)', () => {
    const withMeta = (seq: SessionSeq, meta: unknown, op: TestSurfaceOp = 'append', sourceEventSeqs?: number[]): SessionEvent => {
      const event = toolResultEvent(SessionSeq(seq), 'c-meta', op, sourceEventSeqs)
      const data = event.data as Extract<SessionEvent, { type: 'tool/result' }>['data']
      return {
        ...event,
        data: {
          ...data,
          message: freezeMessage({ ...data.message, id: MessageId('meta-message') }),
          meta,
        },
      } as SessionEvent
    }
    // Structurally equal arrays (fresh references) pass the rest-field equality.
    expect(() => foldSurface([
      withMeta(SessionSeq(0), { tags: ['a', { n: 1 }] }),
      withMeta(SessionSeq(1), { tags: ['a', { n: 1 }] }, { op: 'replace', start: 0, end: 0 }, [0]),
    ])).not.toThrow()
    // Same length, drifted element: the array branch must reject.
    expect(() => foldSurface([
      withMeta(SessionSeq(0), { tags: ['a'] }),
      withMeta(SessionSeq(1), { tags: ['b'] }, { op: 'replace', start: 0, end: 0 }, [0]),
    ])).toThrow(/may change only content/)
    // Array vs non-array on one side: the mixed-shape guard rejects.
    expect(() => foldSurface([
      withMeta(SessionSeq(0), { tags: ['a'] }),
      withMeta(SessionSeq(1), { tags: 'a' }, { op: 'replace', start: 0, end: 0 }, [0]),
    ])).toThrow(/may change only content/)
    // Same key count, different key names: the hasOwn branch rejects.
    expect(() => foldSurface([
      withMeta(SessionSeq(0), { left: 1 }),
      withMeta(SessionSeq(1), { right: 1 }, { op: 'replace', start: 0, end: 0 }, [0]),
    ])).toThrow(/may change only content/)
    // Different key counts: the key-length branch rejects.
    expect(() => foldSurface([
      withMeta(SessionSeq(0), { one: 1 }),
      withMeta(SessionSeq(1), { one: 1, two: 2 }, { op: 'replace', start: 0, end: 0 }, [0]),
    ])).toThrow(/may change only content/)
  })
})

describe('SurfaceManager', () => {
  it('folds a contiguous window without materializing earlier event sequences', () => {
    const baseSeq = 400_000
    const events = [
      provenanceEvent(SessionSeq(baseSeq), undefined),
      provenanceEvent(SessionSeq(baseSeq + 1), undefined),
      {
        ...provenanceEvent(SessionSeq(baseSeq + 2), [baseSeq]),
        surfaceOp: surfaceOp({ op: 'replace', start: baseSeq, end: baseSeq }),
      },
    ] as SessionEvent[]

    const surface = new SurfaceManager(events, SessionLogOffset(baseSeq))
    expect(surface.nodes).toEqual([baseSeq + 2, baseSeq + 1])
    expect(surface.replaceGeneration).toBe(1)
  })

  it('validates tool-result rewrites against a nonzero window offset', () => {
    const baseSeq = 400_000
    const original = toolResultEvent(SessionSeq(baseSeq), 'call')
    const events: SessionEvent[] = [
      original,
      {
        ...original,
        seq: SessionSeq(baseSeq + 1),
        time: baseSeq + 1,
        surfaceOp: surfaceOp({ op: 'replace', start: baseSeq, end: baseSeq }),
        sourceEventSeqs: sourceSeqs(baseSeq),
      } as SessionEvent,
    ]

    expect(new SurfaceManager(events, SessionLogOffset(baseSeq)).nodes).toEqual([baseSeq + 1])
  })

  it('rejects a replacement that crosses a loaded window head', () => {
    const baseSeq = 400_000
    const events = [
      provenanceEvent(SessionSeq(baseSeq), undefined),
      {
        ...provenanceEvent(SessionSeq(baseSeq + 1), [baseSeq - 1, baseSeq]),
        surfaceOp: surfaceOp({ op: 'replace', start: baseSeq - 1, end: baseSeq }),
      },
    ] as SessionEvent[]

    expect(() => new SurfaceManager(events, SessionLogOffset(baseSeq)).nodes)
      .toThrow(`surface replace: start seq ${baseSeq - 1} not found in surface`)
  })

  it('shares ordered entries and nested replacement ranges with foldSurface', () => {
    const s = Session.create(SessionId('shared-fold'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'summary' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 0 }), sourceEventSeqs: sourceSeqs(0) })
    s.append('assistant/message', {
      turn: 1, step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'summary 2' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: surfaceOp({ op: 'replace', start: 2, end: 1 }), sourceEventSeqs: sourceSeqs(2, 1) })

    const folded = foldSurface(s.snapshotEvents())
    expect(folded.nodes).toEqual(s.surface.nodes)
    expect(folded.replacements).toEqual([
      { seq: 2, start: 0, end: 0, shadowedSeqs: [0] },
      { seq: 3, start: 2, end: 1, shadowedSeqs: [2, 1] },
    ])
    folded.nodes[0] = SessionSeq(99)
    folded.replacements[0]!.shadowedSeqs.push(SessionSeq(99))
    expect(s.surface.nodes).toEqual([3])
    expect(foldSurface(s.snapshotEvents()).nodes).toEqual([3])
    expect(foldSurface(s.snapshotEvents()).replacements[0]!.shadowedSeqs).toEqual([0])
  })

  it('does not retain fold-only replacement history in incremental state', () => {
    const s = Session.create(SessionId('incremental-state'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'b' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 0 }), sourceEventSeqs: sourceSeqs(0) })

    expect(s.surface.nodes).toEqual([1])
    const manager = s.surface as unknown as { _state: object }
    expect(Object.hasOwn(manager._state, 'replacements')).toBe(false)
    expect(foldSurface(s.snapshotEvents()).replacements).toEqual([
      { seq: 1, start: 0, end: 0, shadowedSeqs: [0] },
    ])
  })

  it('foldSurface reports the same invalid replacement failures as the incremental manager', () => {
    const events = [
      provenanceEvent(SessionSeq(0), undefined),
      { ...provenanceEvent(SessionSeq(1), [0]), surfaceOp: { op: 'replace', start: 42, end: 0 } },
    ] as SessionEvent[]

    expect(() => foldSurface(events)).toThrow(/start seq 42 not found/)
    expect(() => Session.create(SessionId('shared-fold-invalid'), events))
      .toThrow(/start seq 42 not found/)
  })

  it('rejects negative-zero replacement event sequences', () => {
    const event = {
      ...provenanceEvent(SessionSeq(0), [0]),
      surfaceOp: { op: 'replace', start: -0, end: -0 },
    } as SessionEvent

    expect(() => foldSurface([event])).toThrow(/invalid replace surfaceOp/)
  })

  it('leaves incremental state unchanged when candidate validation fails', () => {
    const s = Session.create(SessionId('atomic-validation'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const surface = s.surface
    const nodes = surface.nodes

    expect(nodes).toEqual(foldSurface(s.snapshotEvents()).nodes)
    expect(surface.replaceGeneration).toBe(0)

    expect(() => s.append(
      'assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'invalid' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 0 }) },
    )).toThrow(/missing 0/)

    expect(s.snapshotEvents()).toHaveLength(1)
    expect(s.surface).toBe(surface)
    expect(surface.nodes).toEqual([0])
    expect(surface.replaceGeneration).toBe(0)
    expect(surface.nodes).toEqual(foldSurface(s.snapshotEvents()).nodes)

    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(surface.nodes).toBe(nodes)
    expect(surface.nodes).toEqual([0, 1])
    expect(surface.replaceGeneration).toBe(0)
    expect(surface.nodes).toEqual(foldSurface(s.snapshotEvents()).nodes)
  })

  it('foldSurface rejects a surface-eligible event without its mandatory marker', () => {
    const malformed: SessionEvent = {
      type: 'user/message',
      seq: SessionSeq(0),
      time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hidden' }], source: { kind: 'user' },
      }),
    }

    expect(() => foldSurface([malformed]))
      .toThrow(/surface-eligible and requires a surfaceOp marker/)
  })

  it('foldSurface rejects surfaceOp on a non-surface event', () => {
    const malformed = {
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
      surfaceOp: 'append',
    } as unknown as SessionEvent

    expect(() => foldSurface([malformed]))
      .toThrow(/not surface-eligible and cannot carry surfaceOp/)
  })

  it('folds an ordered sequence list from surfaceOp: append markers', () => {
    const s = surfaceSession()
    const nodes = s.surface.nodes
    // Only the user/message and assistant/message carry surfaceOp: 'append'.
    // The turn boundaries do not have surface markers.
    expect(nodes).toEqual([1, 2])
  })

  it('empty surface yields empty nodes', () => {
    const s = Session.create(SessionId('empty'))
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(s.surface.nodes.length).toBe(0)
    expect(s.deriveMessages()).toEqual([])
  })

  it('picks up new events incrementally (delta processing)', () => {
    const s = surfaceSession()
    expect(s.surface.nodes.length).toBe(2)
    s.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    expect(s.surface.nodes.length).toBe(3)
    expect(s.surface.nodes[2]!).toBe(4) // seq 4: after turn/end at seq 3
  })

  it('replays identically from a seeded log with surface markers', () => {
    const original = surfaceSession()
    original.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const replayed = Session.create(SessionId('replay'), original.snapshotEvents())
    expect(replayed.surface.nodes).toEqual([1, 2, 4])
    expect(replayed.deriveMessages()).toEqual(original.deriveMessages())
  })

  it('rebuild with replace operation splices out shadowed nodes', () => {
    const s = surfaceSession()
    s.append('assistant/message',
      {
        turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'summary' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 1, end: 2 }), sourceEventSeqs: sourceSeqs(1, 2) },
    )
    expect(s.surface.nodes).toEqual([4])
  })

  it('replace with both ends at real nodes splices only the range', () => {
    const s = Session.create(SessionId('range'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 0
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 1
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'c' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 2
    // Replace seq 0 through 1 inclusive: shadow a and b, keep c.
    s.append('assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'summary' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 1 }), sourceEventSeqs: sourceSeqs(0, 1) },
    ) // seq 3
    expect(s.surface.nodes).toEqual([3, 2])
  })

  it('single-node replacement (start === end)', () => {
    const s = Session.create(SessionId('single'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 0
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 1
    // Replace only seq 1 (single node).
    s.append('assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 1, end: 1 }), sourceEventSeqs: sourceSeqs(1) },
    ) // seq 2
    expect(s.surface.nodes).toEqual([0, 2])
  })

  it('throws when replace start is not found', () => {
    const s = Session.create(SessionId('bad-start'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 0
    expect(() => s.append('assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'y' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 5, end: 0 }), sourceEventSeqs: sourceSeqs(0) },
    )).toThrow(/surface replace: start seq 5 not found/)
  })

  it('throws when replace end is not found', () => {
    const s = Session.create(SessionId('bad-end'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 0
    expect(() => s.append('assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'y' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 99 }), sourceEventSeqs: sourceSeqs(0) },
    )).toThrow(/surface replace: end seq 99 not found/)
  })

  it('throws when start is after end', () => {
    const s = Session.create(SessionId('reversed'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 0
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 1
    // start=1, end=0 would be reversed order.
    expect(() => s.append('assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'y' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 1, end: 0 }), sourceEventSeqs: sourceSeqs(1, 0) },
    )).toThrow(/start seq 1.*after end seq 0/)
  })

  it('sourceEventSeqs is snapshot so caller mutation does not affect logged event', () => {
    const s = Session.create(SessionId('immutable'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'source' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const sources = sourceSeqs(0)
    s.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'h' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: sources })
    // Mutate caller's array after append.
    sources.push(SessionSeq(1))
    sources[0] = SessionSeq(99)
    const logged = s.snapshotEvents()[1]! as SurfaceEvent
    expect(logged.sourceEventSeqs).toEqual([0])
  })

  it('replace starting at non-head position preserves surrounding order', () => {
    const s = Session.create(SessionId('mid-replace'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 0
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 1
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'c' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }) // seq 2
    // Replace the middle node (seq 1) only, keeping seq 0 and seq 2.
    s.append('assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: surfaceOp({ op: 'replace', start: 1, end: 1 }), sourceEventSeqs: sourceSeqs(1) },
    ) // seq 3
    expect(s.surface.nodes).toEqual([0, 3, 2])
  })

  it('surfaceOp replace object is snapshot so caller mutation is isolated', () => {
    const s = Session.create(SessionId('immutable-op'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const op = { op: 'replace' as const, start: SessionSeq(0), end: SessionSeq(0) }
    s.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 's' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: op, sourceEventSeqs: sourceSeqs(0) })
    // Mutate caller's object after append.
    op.start = SessionSeq(99)
    const logged = s.snapshotEvents()[1]! as SurfaceEvent
    expect(logged.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
  })
})

describe('deriveMessages with surface', () => {
  it('uses the surface path when surface markers are present', () => {
    const s = surfaceSession()
    const messages = s.deriveMessages()
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.content[0]).toMatchObject({ type: 'text', text: 'hi' })
  })

  it('surface path skips non-surface events (chunks, boundaries)', () => {
    const s = Session.create(SessionId('filter'))
    s.append('turn/start', { turn: 1 })
    s.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } })
    s.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'i' } })
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Chunks and boundaries are NOT in the surface, so only 2 messages.
    expect(s.deriveMessages()).toHaveLength(2)
  })

  it('deriveMessages via surface respects replace (shadowed nodes are excluded)', () => {
    const s = Session.create(SessionId('compacted'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'compacted' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: surfaceOp({ op: 'replace', start: 0, end: 0 }), sourceEventSeqs: sourceSeqs(0) })
    // Only the compaction node is visible.
    const messages = s.deriveMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text', text: 'compacted' })
  })

  it('injected-context and user messages appear on surface', () => {
    const s = Session.create(SessionId('ctx'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'file changed' }], source: { kind: 'plugin', plugin: 'watcher' },
    }), { surfaceOp: 'append' })
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'focus' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const messages = s.deriveMessages()
    expect(messages).toHaveLength(2)
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'file changed' }])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'focus' }])
  })
})

describe('Session.append surface opts', () => {
  it('records sourceEventSeqs and surfaceOp on the event', () => {
    const s = Session.create(SessionId('opts'))
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    const event = s.append('assistant/message',
      {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'h' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      { surfaceOp: 'append', sourceEventSeqs: sourceSeqs(0, 1) },
    )
    expect(event.sourceEventSeqs).toEqual([0, 1])
    expect(event.surfaceOp).toBe('append')
    // The logged event matches the returned event.
    expect((s.snapshotEvents()[2]! as SurfaceEvent).sourceEventSeqs).toEqual([0, 1])
    expect((s.snapshotEvents()[2]! as SurfaceEvent).surfaceOp).toBe('append')
  })

  it('deriveMessages skips a surface node that derives to null (empty assistant/message)', () => {
    // An empty-content assistant/message is surface-eligible (it can host usage)
    // but _deriveOneMessage returns null for it, so the surface derivation path's
    // null-check is exercised — the node is on the surface yet produces no message.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: SessionSeq(2), time: 3, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      }, surfaceOp: 'append' },
      { type: 'step/end', seq: SessionSeq(3), time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(4), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const s = Session.create(SessionId('nomessage'), seed)
    // The empty assistant/message is on the surface but _deriveOneMessage returns null for it.
    expect(s.deriveMessages()).toHaveLength(0)
  })

  it('a non-surface event carries no surface fields', () => {
    const s = Session.create(SessionId('noopts'))
    s.append('turn/start', { turn: 1 })
    expect((s.snapshotEvents()[0] as SessionEvent<SurfaceEventType>).sourceEventSeqs).toBeUndefined()
    expect((s.snapshotEvents()[0] as SessionEvent<SurfaceEventType>).surfaceOp).toBeUndefined()
  })

  it('surfaceOp primitives are not cloned (they are immutable)', () => {
    const s = Session.create(SessionId('prim'))
    const event = s.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    // The string 'append' is a primitive — identity-preserving is fine.
    expect(event.surfaceOp).toBe('append')
  })

  it('isSurfaceEvent rejects a surface-eligible type missing its surfaceOp marker', () => {
    // A raw event (not built via append, which mandates the marker) of a
    // surface-eligible type but with no surfaceOp must NOT narrow to a
    // SurfaceEvent — it would otherwise be silently dropped from the surface.
    const noMarker: SessionEvent = {
      type: 'user/message', seq: SessionSeq(0), time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
      }),
    }
    expect(isSurfaceEvent(noMarker)).toBe(false)
    // A non-surface type is rejected too (the type gate).
    const boundary: SessionEvent = { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } }
    expect(isSurfaceEvent(boundary)).toBe(false)
    // A properly-marked surface event narrows.
    const marked = { ...noMarker, surfaceOp: 'append' } as SurfaceEvent
    expect(isSurfaceEvent(marked)).toBe(true)
  })
})

describe('surface type guards', () => {
  it('isSurfaceEligibleType is true only for message-producing types', () => {
    expect(isSurfaceEligibleType('user/message')).toBe(true)
    expect(isSurfaceEligibleType('assistant/message')).toBe(true)
    expect(isSurfaceEligibleType('tool/result')).toBe(true)
    expect(isSurfaceEligibleType('turn/start')).toBe(false)
    expect(isSurfaceEligibleType('assistant/chunk')).toBe(false)
  })

  it('isSurfaceEvent narrows a fully-formed surface event', () => {
    const s = surfaceSession()
    const userMessage = s.snapshotEvents().find(e => e.type === 'user/message')!
    expect(isSurfaceEvent(userMessage)).toBe(true)
  })

  it('isSurfaceEvent rejects a non-surface-eligible type', () => {
    const s = surfaceSession()
    const turnStart = s.snapshotEvents().find(e => e.type === 'turn/start')!
    expect(isSurfaceEvent(turnStart)).toBe(false)
  })

  it('isSurfaceEvent rejects a surface-eligible type missing its surfaceOp marker', () => {
    // A surface-eligible type whose mandatory surfaceOp is absent — the state a
    // seed/load log can carry before the marker is validated. surfaceOp is
    // optional on SessionEvent, so this is a representable runtime value.
    const markerless: SessionEvent = {
      type: 'user/message',
      seq: SessionSeq(0),
      time: 0,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
      }),
    }
    expect(isSurfaceEligibleType(markerless.type)).toBe(true)
    expect(isSurfaceEvent(markerless)).toBe(false)
  })

  it('splits surface events into append-origin and replacement by their marker', () => {
    const s = surfaceSession()
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: surfaceOp({ op: 'replace', start: 1, end: 2 }), sourceEventSeqs: sourceSeqs(1, 2) })
    const appended = s.snapshotEvents().find(e => e.type === 'user/message')!
    const replacement = s.snapshotEvents().at(-1)!

    expect(isAppendSurfaceEvent(appended)).toBe(true)
    expect(isReplacementSurfaceEvent(appended)).toBe(false)
    expect(isAppendSurfaceEvent(replacement)).toBe(false)
    expect(isReplacementSurfaceEvent(replacement)).toBe(true)
  })

  it('rejects log-only and markerless events from both marker guards', () => {
    const s = surfaceSession()
    const turnStart = s.snapshotEvents().find(e => e.type === 'turn/start')!
    // A surface-eligible type whose mandatory marker is absent has no origin at
    // all: it never entered the surface.
    const markerless: SessionEvent = {
      type: 'user/message',
      seq: SessionSeq(0),
      time: 0,
      data: createUserMessage({
        content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
      }),
    }

    expect(isAppendSurfaceEvent(turnStart)).toBe(false)
    expect(isReplacementSurfaceEvent(turnStart)).toBe(false)
    expect(isAppendSurfaceEvent(markerless)).toBe(false)
    expect(isReplacementSurfaceEvent(markerless)).toBe(false)
  })
})

describe('SurfaceManager.replaceGeneration', () => {
  it('folds the pending log delta on access and counts replaces', () => {
    const s = Session.create(SessionId('gen'))
    s.append('turn/start', { turn: 1 })
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'one' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'two' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // Read the generation FIRST — before nodes — so the getter itself folds
    // the pending delta rather than piggybacking on a nodes read.
    expect(s.surface.replaceGeneration).toBe(0)

    const nodes = s.surface.nodes
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[1]! }, sourceEventSeqs: [nodes[0]!, nodes[1]!] })
    expect(s.surface.replaceGeneration).toBe(1)
  })
})
