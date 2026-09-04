import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId , createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'

const SURFACE = { surfaceOp: 'append' as const }

function seqOf(session: Session, type: SessionEvent['type'], nth = 0): SessionSeqType {
  return session.snapshotEvents().filter(event => event.type === type)[nth]!.seq
}

function surfaceSeq(session: Session, seq: SessionSeqType): SessionSeqType {
  const current = session.surface.nodes.find(candidate => candidate === seq)
  if (current === undefined) throw new Error(`seq ${seq} is not on the surface`)
  return current
}

function before(session: Session, type: SessionEvent['type'], nth = 0): boolean {
  return toolPairingBalancedBefore(session, surfaceSeq(session, seqOf(session, type, nth)))
}

function after(session: Session, type: SessionEvent['type'], nth = 0): boolean {
  return toolPairingBalancedAfter(session, surfaceSeq(session, seqOf(session, type, nth)))
}

function closedToolStep(): Session {
  const session = Session.create(SessionId('closed-tool-step'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'go' }],
    source: { kind: 'user' },
  }), SURFACE)
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: 'mock', model: 'mock' },
      },
    }),
  }, SURFACE)
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('c1'),
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    }),
  }, SURFACE)
  return session
}

describe('tool-pairing boundaries', () => {
  it('classifies closed and open single-call steps', () => {
    const closed = closedToolStep()
    expect(before(closed, 'user/message')).toBe(true)
    expect(after(closed, 'user/message')).toBe(true)
    expect(before(closed, 'assistant/message')).toBe(true)
    expect(after(closed, 'assistant/message')).toBe(false)
    expect(before(closed, 'tool/result')).toBe(false)
    expect(after(closed, 'tool/result')).toBe(true)

    const open = Session.create(SessionId('open-tool-step'))
    open.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('open'), name: 'bash', arguments: '{}' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, SURFACE)
    expect(toolPairingBalancedAfter(open, open.surface.nodes[0]!)).toBe(false)
  })

  it('requires every result from a multiple-call assistant message', () => {
    const session = Session.create(SessionId('multiple-calls'))
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: ToolCallId('c1'), name: 'one', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('c2'), name: 'two', arguments: '{}' },
        ],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, SURFACE)
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [],
        isError: false,
      }),
    }, SURFACE)
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c2'),
        content: [],
        isError: false,
      }),
    }, SURFACE)

    expect(after(session, 'tool/result', 0)).toBe(false)
    expect(after(session, 'tool/result', 1)).toBe(true)
  })

  it('keeps neutral nodes inside an open pair unbalanced and free nodes balanced', () => {
    const midStep = Session.create(SessionId('neutral-mid-step'))
    midStep.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, SURFACE)
    midStep.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'background update' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), SURFACE)
    midStep.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [],
        isError: false,
      }),
    }, SURFACE)
    expect(before(midStep, 'user/message')).toBe(false)
    expect(after(midStep, 'user/message')).toBe(false)

    const free = Session.create(SessionId('neutral-free'))
    free.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'idle injection' }],
      source: { kind: 'user' },
    }), SURFACE)
    expect(before(free, 'user/message')).toBe(true)
    expect(after(free, 'user/message')).toBe(true)
  })
})

describe('tool-pairing surface identity', () => {
  it('rebuilds after replace and rejects sequences removed from current membership', () => {
    const session = closedToolStep()
    const staleTail = surfaceSeq(session, seqOf(session, 'tool/result'))
    expect(toolPairingBalancedAfter(session, staleTail)).toBe(true)

    const nodes = session.surface.nodes
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
      sourceEventSeqs: [...nodes],
    })

    const checkpoint = session.surface.nodes[0]!
    expect(toolPairingBalancedBefore(session, checkpoint)).toBe(true)
    expect(toolPairingBalancedAfter(session, checkpoint)).toBe(true)
    expect(() => toolPairingBalancedBefore(session, staleTail)).toThrow(/surface seq .* not found/)
    expect(() => toolPairingBalancedAfter(session, staleTail)).toThrow(/surface seq .* not found/)
  })

  it('answers repeated queries from cached balances', () => {
    const session = closedToolStep()
    const assistant = surfaceSeq(session, seqOf(session, 'assistant/message'))
    expect(toolPairingBalancedAfter(session, assistant)).toBe(false)
    expect(toolPairingBalancedAfter(session, assistant)).toBe(false)
  })

  it('rejects missing seqs before and after, including an empty surface', () => {
    const session = Session.create(SessionId('missing-membership'))
    const missing = SessionSeq(999)
    expect(() => toolPairingBalancedBefore(session, missing)).toThrow(/surface seq 999 not found/)
    expect(() => toolPairingBalancedAfter(session, missing)).toThrow(/surface seq 999 not found/)

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first node after empty cache' }],
      source: { kind: 'user' },
    }), SURFACE)
    expect(toolPairingBalancedAfter(session, session.surface.nodes[0]!)).toBe(true)
  })
})

describe('tool-pairing cache refresh', () => {
  it('does no event reads for unchanged or log-only growth, folds only appended nodes, and rebuilds on replace', () => {
    const events: SessionEvent[] = [
      {
        type: 'user/message', seq: SessionSeq(0), time: 0,
        data: createUserMessage({
          content: [{ type: 'text', text: 'user' }], source: { kind: 'user' },
        }),
        surfaceOp: 'append',
      },
      {
        type: 'assistant/message', seq: SessionSeq(1), time: 1,
        data: {
          stream: [],
          turn: 1,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'one', arguments: '{}' }],
            source: {
              kind: 'model',
              ...{ provider: 'mock', model: 'mock' },
            },
          }),
        },
        surfaceOp: 'append',
      },
      {
        type: 'tool/result', seq: SessionSeq(2), time: 2,
        data: {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('c1'),
            content: [],
            isError: false,
          }),
        },
        surfaceOp: 'append',
      },
    ]
    const nodes: SessionSeqType[] = [SessionSeq(0), SessionSeq(1), SessionSeq(2)]
    let generation = 0
    let eventReads = 0
    const surface = {
      get nodes() { return nodes },
      get replaceGeneration() { return generation },
    }
    const session = {
      surface,
      eventAt(seq: number) {
        eventReads += 1
        return events[seq]
      },
    } as unknown as Session

    expect(toolPairingBalancedAfter(session, nodes[2]!)).toBe(true)
    expect(eventReads).toBe(3)

    expect(toolPairingBalancedBefore(session, nodes[0]!)).toBe(true)
    expect(toolPairingBalancedAfter(session, nodes[1]!)).toBe(false)
    expect(eventReads).toBe(3)

    events.push({
      type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(toolPairingBalancedAfter(session, nodes[2]!)).toBe(true)
    expect(eventReads).toBe(3)

    events.push({
      type: 'user/message', seq: SessionSeq(4), time: 4,
      data: createUserMessage({
        content: [{ type: 'text', text: 'tail' }], source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    })
    nodes.push(SessionSeq(4))
    expect(toolPairingBalancedAfter(session, nodes[3]!)).toBe(true)
    expect(eventReads).toBe(4)

    events.push(
      {
        type: 'assistant/message', seq: SessionSeq(5), time: 5,
        data: {
          stream: [],
          turn: 2,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'tool-call', id: ToolCallId('c2'), name: 'two', arguments: '{}' }],
            source: {
              kind: 'model',
              ...{ provider: 'mock', model: 'mock' },
            },
          }),
        },
        surfaceOp: 'append',
      },
      {
        type: 'tool/result', seq: SessionSeq(6), time: 6,
        data: {
          turn: 2, step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('c2'),
            content: [],
            isError: false,
          }),
        },
        surfaceOp: 'append',
      },
    )
    nodes.push(SessionSeq(5), SessionSeq(6))
    expect(toolPairingBalancedAfter(session, nodes[5]!)).toBe(true)
    expect(eventReads).toBe(6)

    events.push({
      type: 'user/message', seq: SessionSeq(7), time: 7,
      data: createUserMessage({
        content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' },
      }),
      surfaceOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(6) },
    })
    nodes.splice(0, nodes.length, SessionSeq(7))
    generation += 1
    expect(toolPairingBalancedAfter(session, nodes[0]!)).toBe(true)
    expect(eventReads).toBe(7)
  })

  it('rebuilds defensively when a same-generation surface entry count regresses', () => {
    const events: SessionEvent[] = [
      {
        type: 'user/message', seq: SessionSeq(0), time: 0,
        data: createUserMessage({
          content: [], source: { kind: 'user' },
        }), surfaceOp: 'append',
      },
      {
        type: 'user/message', seq: SessionSeq(1), time: 1,
        data: createUserMessage({
          content: [], source: { kind: 'user' },
        }), surfaceOp: 'append',
      },
    ]
    const nodes: SessionSeqType[] = [SessionSeq(0), SessionSeq(1)]
    const session = {
      eventAt: (seq: number) => events[seq],
      surface: { nodes, replaceGeneration: 0 },
    } as unknown as Session
    expect(toolPairingBalancedAfter(session, nodes[1]!)).toBe(true)
    nodes.pop()
    expect(toolPairingBalancedAfter(session, nodes[0]!)).toBe(true)
  })
})

describe('tool-pairing corrupt surfaces', () => {
  it('throws for an orphan result during a rebuild', () => {
    const session = Session.create(SessionId('orphan-rebuild'))
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('orphan'),
        content: [],
        isError: false,
      }),
    }, SURFACE)
    expect(() => toolPairingBalancedAfter(session, session.surface.nodes[0]!)).toThrow(/no matching tool-call/)
  })

  it('retries an orphan result in an appended tail without committing partial cache state', () => {
    const session = Session.create(SessionId('orphan-tail'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'safe head' }], source: { kind: 'user' },
    }), SURFACE)
    expect(toolPairingBalancedAfter(session, session.surface.nodes[0]!)).toBe(true)
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('orphan'),
        content: [],
        isError: false,
      }),
    }, SURFACE)
    expect(() => toolPairingBalancedAfter(session, session.surface.nodes[1]!)).toThrow(/no matching tool-call/)
    expect(() => toolPairingBalancedAfter(session, session.surface.nodes[1]!)).toThrow(/no matching tool-call/)
  })

  it('throws when a current surface seq has no matching event or indexes the wrong event', () => {
    const missingSeq = SessionSeq(1)
    const missing = {
      eventAt: (seq: number) => [{
        type: 'user/message', seq: SessionSeq(0), time: 0,
        data: createUserMessage({
          content: [], source: { kind: 'user' },
        }), surfaceOp: 'append',
      } satisfies SessionEvent][seq],
      surface: { nodes: [missingSeq], replaceGeneration: 0 },
    } as unknown as Session
    expect(() => toolPairingBalancedBefore(missing, missingSeq)).toThrow(/no matching session event/)

    const mismatchedSeq = SessionSeq(0)
    const mismatched = {
      eventAt: (seq: number) => [{
        type: 'user/message', seq: SessionSeq(99), time: 0,
        data: createUserMessage({
          content: [], source: { kind: 'user' },
        }), surfaceOp: 'append',
      } satisfies SessionEvent][seq],
      surface: { nodes: [mismatchedSeq], replaceGeneration: 0 },
    } as unknown as Session
    expect(() => toolPairingBalancedBefore(mismatched, mismatchedSeq)).toThrow(/no matching session event/)
  })
})
