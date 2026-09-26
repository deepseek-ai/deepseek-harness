import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, createMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionForkError, SessionId, SessionLogOffset, SessionSeq, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/log-only': { value: string }
    /** Stands in for a plugin's open/close bracket (`compaction/start`). */
    'test/bracket-open': { id: string }
  }
}

async function setup(): Promise<{ ctx: Context; sessions: SessionStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx, sessions: ctx.sessions }
}

function appendClosedTurn(
  session: Session,
  turn: number,
  text = `hello ${turn}`,
  reason: TurnEndReason = { kind: 'completed' },
): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason })
}

function appendOpenTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `open ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function firstUserMessage(events: readonly SessionEvent[]): SessionEvent<'user/message'> {
  const event = events.find((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
  if (event === undefined) throw new Error('missing user/message')
  return event
}

function lastSeq(session: Session): SessionSeq {
  const event = session.snapshotEvents().at(-1)
  if (event === undefined) throw new Error('missing last event')
  return event.seq
}

/** A seeded child's fork-inherited prefix. */
function inherited(session: Session): readonly SessionEvent[] {
  return session.snapshotEvents(SessionLogOffset(0), session.inheritedEventCount)
}

describe('SessionStore.fork', () => {
  it('forks an empty live session as an empty child with lineage metadata', async () => {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId('empty-parent'), { meta: { cwd: '/workspace' } })

    const child = sessions.fork(source, undefined, SessionId('empty-child'))

    expect(inherited(child)).toEqual([])
    expect(child.header).toMatchObject({
      id: SessionId('empty-child'),
      cwd: '/workspace',
      parentSession: SessionId('empty-parent'),
      isSeeded: true,
    })
    expect(child.inheritedEventCount).toBe(0)
  })

  it('forks the latest completed boundary by default into detached frozen seed events', async () => {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId('parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(source, 1, 'hello')

    const child = sessions.fork(SessionId('parent'), undefined, SessionId('child'))

    expect(inherited(child)).toEqual(source.snapshotEvents())
    expect(child.snapshotEvents()).not.toBe(source.snapshotEvents())
    expect(child.snapshotEvents()[1]).not.toBe(source.snapshotEvents()[1])
    expect(() => {
      (firstUserMessage(child.snapshotEvents()).data as unknown as { content: { type: string; text?: string }[] }).content[0]
        = { type: 'text', text: 'child mutation' }
    }).toThrow(TypeError)
    expect(firstUserMessage(source.snapshotEvents()).data.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(firstUserMessage(child.snapshotEvents()).data.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(child.header).toMatchObject({
      id: SessionId('child'),
      cwd: '/workspace',
      parentSession: SessionId('parent'),
      isSeeded: true,
    })
    expect(child.inheritedEventCount).toBe(source.seq)
  })

  it('includes stable log-only events appended after a closed turn', async () => {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId('log-only-parent'))
    appendClosedTurn(source, 1, 'hello')
    source.append('test/log-only', { value: 'after execution' })

    const child = sessions.fork(source, undefined, SessionId('log-only-child'))

    expect(inherited(child)).toEqual(source.snapshotEvents())
    expect(inherited(child).at(-1)).toMatchObject({
      type: 'test/log-only',
      data: { value: 'after execution' },
    })
  })

  it('forks from an earlier turn boundary even when the source currently has an open tail', async () => {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId('parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(source, 1, 'first')
    const firstBoundary = lastSeq(source)
    appendClosedTurn(source, 2, 'second')
    appendOpenTurn(source, 3)

    const child = sessions.fork(source, firstBoundary, SessionId('child-from-first'))

    expect(inherited(child)).toEqual(source.snapshotEvents().slice(0, firstBoundary + 1))
    expect(child.inheritedEventCount).toBe(firstBoundary + 1)
    expect(child.deriveMessages()).toEqual([{
      id: expect.any(String) as unknown,
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    }])
  })

  it('accepts every turn/end reason as an explicit fork boundary', async () => {
    const { ctx, sessions } = await setup()
    const reasons: TurnEndReason[] = [
      { kind: 'completed' },
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'error', error: { message: 'model failed', code: 'UNKNOWN' } },
      { kind: 'aborted', reason: { kind: 'disposed' } },
      { kind: 'max-tokens' },
      { kind: 'interrupted' },
    ]

    for (const [index, reason] of reasons.entries()) {
      const source = ctx.sessions.create(SessionId(`parent-${index}`))
      appendClosedTurn(source, 1, reason.kind, reason)

      const child = sessions.fork(source, lastSeq(source), SessionId(`child-${index}`))

      expect(inherited(child).at(-1)?.type).toBe('turn/end')
      expect(child.inheritedEventCount).toBe(source.seq)
    }
  })

  it('marks a bracket the child inherited from a still-running parent', async () => {
    // The constructor placement's central claim, unreachable from the
    // persistence load path.
    const { ctx, sessions } = await setup()
    const parent = ctx.sessions.create(SessionId('bracket-parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(parent, 1, 'work')
    const open = parent.append('test/bracket-open', { id: 'op-1' })

    const child = sessions.fork(parent, undefined, SessionId('bracket-child'))

    // Parent: no end-seed event follows the bracket, so its owner treats it as live.
    expect(parent.snapshotEvents().at(-1)).toBe(open)
    expect(parent.snapshotEvents().some(event => event.type === 'session/end-seed')).toBe(false)
    // Child: the same bracket is before end-seed, so it belongs to the seed.
    const boundary = child.snapshotEvents().at(-1)
    expect(boundary).toMatchObject({ type: 'session/end-seed' })
    expect(boundary!.seq).toBeGreaterThan(open.seq)
    expect(child.firstLiveSeq).toBe(open.seq + 2)
    expect(inherited(child).at(-1)).toMatchObject({ type: 'test/bracket-open', data: { id: 'op-1' } })
  })

  it('rejects invalid boundaries before creating a child', async () => {
    const { ctx, sessions } = await setup()
    const empty = ctx.sessions.create(SessionId('empty'))
    expect(() => sessions.fork(empty, SessionSeq(0), SessionId('empty-child')))
      .toThrow(new SessionForkError('fork boundary 0 does not exist in session "empty" (last seq: none)', 'INVALID_BOUNDARY'))
    expect(ctx.sessions.get(SessionId('empty-child'))).toBeUndefined()

    const source = ctx.sessions.create(SessionId('parent'))
    appendClosedTurn(source, 1)
    expect(() => sessions.fork(source, -1 as never, SessionId('negative')))
      .toThrow(/non-negative safe integer/)
    expect(() => sessions.fork(source, 0.5 as never, SessionId('fraction')))
      .toThrow(/non-negative safe integer/)
    expect(() => sessions.fork(source, (Number.MAX_SAFE_INTEGER + 1) as never, SessionId('unsafe')))
      .toThrow(/non-negative safe integer/)
    expect(() => sessions.fork(source, SessionSeq(source.seq), SessionId('past-end')))
      .toThrow(new SessionForkError(`fork boundary ${source.seq} does not exist in session "parent" (last seq: ${source.seq - 1})`, 'INVALID_BOUNDARY'))
  })

  it('rejects a corrupted live source whose array index no longer matches event seq', async () => {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId('corrupt-parent'))
    appendClosedTurn(source, 1)
    const mutableLog = (source as unknown as { log: SessionEvent[] }).log
    mutableLog[2] = { ...mutableLog[2]!, seq: SessionSeq(99) }

    expect(() => sessions.fork(source, SessionSeq(2), SessionId('corrupt-child')))
      .toThrow(new SessionForkError('fork boundary 2 does not match a contiguous event seq in session "corrupt-parent"', 'INVALID_BOUNDARY'))
    expect(ctx.sessions.get(SessionId('corrupt-child'))).toBeUndefined()
  })

  it('rejects an unknown live session id', async () => {
    const { sessions } = await setup()

    expect(() => sessions.fork(SessionId('missing')))
      .toThrow(new SessionForkError('session "missing" not found', 'SESSION_NOT_FOUND'))
  })

  it('rejects a detached Session object that is not live in ctx.sessions', async () => {
    const { sessions } = await setup()
    const detached = Session.create(SessionId('detached'))

    expect(() => sessions.fork(detached))
      .toThrow(new SessionForkError('session "detached" not found', 'SESSION_NOT_FOUND'))
  })

  it('rejects a stale Session object whose id is live on a different instance', async () => {
    const { ctx, sessions } = await setup()
    ctx.sessions.create(SessionId('same-id'))
    const stale = Session.create(SessionId('same-id'))

    expect(() => sessions.fork(stale))
      .toThrow(new SessionForkError('session "same-id" is not the live store instance', 'SESSION_NOT_LIVE'))
  })

  it('rejects a child session id that is already live with a typed fork error', async () => {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId('parent'))
    appendClosedTurn(source, 1)
    ctx.sessions.create(SessionId('child'))

    expect(() => sessions.fork(source, undefined, SessionId('child')))
      .toThrow(new SessionForkError('session "child" already exists', 'SESSION_ALREADY_EXISTS'))
  })

  it('rejects a duplicate child session id before validating the boundary', async () => {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId('open-parent'))
    source.append('turn/start', { turn: 1 })
    ctx.sessions.create(SessionId('child'))

    expect(() => sessions.fork(source, undefined, SessionId('child')))
      .toThrow(new SessionForkError('session "child" already exists', 'SESSION_ALREADY_EXISTS'))
  })
})

describe('fork boundaries inside an open turn', () => {
  /** Open turn 2 after a closed turn 1 and return the source. */
  async function openTurnSource(id: string): Promise<{ ctx: Context; sessions: SessionStore; source: Session }> {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId(id))
    appendClosedTurn(source, 1, 'first')
    source.append('turn/start', { turn: 2 })
    return { ctx, sessions, source }
  }

  /** Append the open step + assistant tool request of turn 2. */
  function appendToolRequest(session: Session, callId: ToolCallId): void {
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 2, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
  }

  it('closes an empty open turn with a synthetic turn/end {forked} outside seedLength', async () => {
    const { sessions, source } = await openTurnSource('open-empty')

    const child = sessions.fork(source, lastSeq(source), SessionId('open-empty-child'))

    const seed = child.snapshotEvents()
    expect(seed.slice(0, source.snapshotEvents().length)).toEqual(source.snapshotEvents())
    expect(seed.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'forked' } },
    })
    // The closer is child work: `seedLength` names only events that exist in
    // the parent's log, so telemetry receivers stitching a fork's prefix from
    // the parent's stream on `(parent_id, seed_length)` read exactly the
    // copied prefix.
    expect(child.inheritedEventCount).toBe(source.snapshotEvents().length)
  })

  it('closes only the turn when the cut lands on a closed step boundary', async () => {
    const { sessions, source } = await openTurnSource('open-step-closed')
    source.append('step/start', { turn: 2, step: 1 })
    source.append('assistant/message', {
      stream: [],
      turn: 2, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'step done' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    source.append('step/end', { turn: 2, step: 1 })

    const child = sessions.fork(source, lastSeq(source), SessionId('open-step-closed-child'))

    expect(child.snapshotEvents().slice(source.snapshotEvents().length + 1).map(e => e.type)).toEqual(['turn/end'])
  })

  it('answers an assistant call cut before its tool/call with a forked not-started error result', async () => {
    const { sessions, source } = await openTurnSource('open-not-started')
    appendToolRequest(source, ToolCallId('call-ns'))

    const child = sessions.fork(source, lastSeq(source), SessionId('open-not-started-child'))

    const closers = child.snapshotEvents().slice(source.snapshotEvents().length + 1)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data).toMatchObject({
      message: {
        id: expect.stringMatching(/^forked-tool-result-call-ns-/) as unknown,
        source: { callId: ToolCallId('call-ns') },
      },
      error: { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
    })
    // The synthetic result is part of the child's model-visible history, not a
    // request-time patch: the derived messages end with the error tool result.
    const derived = child.deriveMessages()
    expect(derived.at(-1)).toMatchObject({
      role: 'tool',
      source: { kind: 'tool', callId: ToolCallId('call-ns') },
      toolCallId: ToolCallId('call-ns'),
      isError: true,
      content: [{ type: 'text' }],
    })
  })

  it('answers a dispatched call cut before its result with an unknown-outcome error citing the tool/call', async () => {
    const { sessions, source } = await openTurnSource('open-unknown')
    appendToolRequest(source, ToolCallId('call-uo'))
    const call = source.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('call-uo'), name: 'bash', arguments: '{}' })

    const child = sessions.fork(source, lastSeq(source), SessionId('open-unknown-child'))

    const closers = child.snapshotEvents().slice(source.snapshotEvents().length + 1)
    expect(closers.map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const result = closers[0]!
    expect(result.type === 'tool/result' && result.data.error).toEqual({
      name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
    })
    expect((result as SurfaceEvent).sourceEventSeqs).toEqual([call.seq])
  })

  it('omits a failed assistant attempt from derived history', async () => {
    const { sessions, source } = await openTurnSource('open-mid-stream')
    source.append('step/start', { turn: 2, step: 1 })
    source.append('assistant/attempt', {
      turn: 2, step: 1, stream: [],
    })

    const child = sessions.fork(source, lastSeq(source), SessionId('open-mid-stream-child'))

    expect(child.snapshotEvents().slice(source.snapshotEvents().length + 1).map(e => e.type)).toEqual(['step/end', 'turn/end'])
    expect(child.deriveMessages().some(message => message.role === 'assistant')).toBe(false)
  })

  it.each([false, true])('preserves a closed step with an unanswered call (turn ended: %s)', async (turnEnded) => {
    const { sessions, source } = await openTurnSource('dangling-closed-step')
    appendToolRequest(source, ToolCallId('call-dangling'))
    source.append('tool/call', {
      turn: 2, step: 1, callId: ToolCallId('call-dangling'), name: 'bash', arguments: '{}',
    })
    source.append('step/end', { turn: 2, step: 1 })
    if (turnEnded) {
      source.append('turn/end', {
        turn: 2, reason: { kind: 'error', error: { message: 'scheduler failed', code: 'UNKNOWN' } },
      })
    }
    const copiedPrefix = source.snapshotEvents()

    const child = sessions.fork(source)

    expect(inherited(child).slice(0, copiedPrefix.length)).toEqual(copiedPrefix)
    expect(child.snapshotEvents().slice(copiedPrefix.length + 1)).toEqual(turnEnded ? [] : [{
      type: 'turn/end', seq: SessionSeq(copiedPrefix.length + 1), time: copiedPrefix.at(-1)!.time,
      data: { turn: 2, reason: { kind: 'forked' } },
    }])
    expect(child.inheritedEventCount).toBe(copiedPrefix.length)
    expect(child.deriveMessages()).toEqual(source.deriveMessages())
  })

  it('leaves a plugin bracket left open at the cut untouched (log-only locks belong to their owner)', async () => {
    const { sessions, source } = await openTurnSource('open-bracket')
    source.append('test/bracket-open', { id: 'op-live' })

    const child = sessions.fork(source, lastSeq(source), SessionId('open-bracket-child'))

    const closers = child.snapshotEvents().slice(source.snapshotEvents().length + 1)
    expect(closers.map(e => e.type)).toEqual(['turn/end'])
    // The unmatched bracket sits before the child's end-seed marker, so its
    // owning plugin decides its staleness from that boundary.
    expect(child.snapshotEvents()[child.inheritedEventCount]).toMatchObject({ type: 'session/end-seed', data: { inherited: true } })
  })
})

describe('fork boundaries around a surface replacement', () => {
  /**
   * A source whose open turn 2 replaces turn 1's user message with a summary
   * (the compaction surface pattern: a `user/message` with a range replace op).
   */
  async function replacementSource(id: string): Promise<{
    sessions: SessionStore
    source: Session
    replacedSeq: SessionSeq
    replacementSeq: SessionSeq
  }> {
    const { ctx, sessions } = await setup()
    const source = ctx.sessions.create(SessionId(id))
    appendClosedTurn(source, 1, 'original request')
    const replacedSeq = firstUserMessage(source.snapshotEvents()).seq
    source.append('turn/start', { turn: 2 })
    const replacement = source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary of earlier work' }],
      source: {
        kind: 'compact-checkpoint',
        compactionId: 'open-bracket' as Extract<MessageSource, { readonly kind: 'compact-checkpoint' }>['compactionId'],
      },
    }), {
      surfaceOp: { op: 'replace', startSeq: replacedSeq, endSeq: replacedSeq },
      sourceEventSeqs: [replacedSeq],
    })
    return { sessions, source, replacedSeq, replacementSeq: replacement.seq }
  }

  it('derives the original message for a cut before the replacement', async () => {
    const { sessions, source, replacementSeq } = await replacementSource('replace-before')

    const child = sessions.fork(source, SessionSeq(replacementSeq - 1), SessionId('replace-before-child'))

    expect(child.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'original request' }],
    ])
  })

  it('derives the compacted surface for a cut after the replacement', async () => {
    const { sessions, source, replacementSeq } = await replacementSource('replace-after')

    const child = sessions.fork(source, replacementSeq, SessionId('replace-after-child'))

    expect(child.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'summary of earlier work' }],
    ])
    expect(child.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'forked' } },
    })
  })
})
