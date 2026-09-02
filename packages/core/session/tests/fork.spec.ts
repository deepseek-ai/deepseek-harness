import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId , createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionForkError, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

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
      firstUserMessage(child.snapshotEvents()).data.content[0] = { type: 'text', text: 'child mutation' }
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
    expect(child.firstLiveSeq).toBe(open.seq + 1)
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

  it('rejects selected slices whose boundary is inside an open turn', async () => {
    const { ctx, sessions } = await setup()
    const cases: [string, (session: Session) => number][] = [
      ['turn/start', (session) => {
        session.append('turn/start', { turn: 1 })
        return lastSeq(session)
      }],
      ['step/start', (session) => {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        return lastSeq(session)
      }],
      ['user/message', (session) => {
        session.append('turn/start', { turn: 1 })
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'open' }], source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        return lastSeq(session)
      }],
      ['assistant/message', (session) => {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/message', {
          turn: 1, step: 1,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
            source: {
              kind: 'model',
              ...{ provider: 'mock', model: 'mock' },
            },
          }),
        }, { surfaceOp: 'append' })
        return lastSeq(session)
      }],
      ['tool/call', (session) => {
        const callId = ToolCallId('call-open')
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
            source: {
              kind: 'model',
              ...{ provider: 'mock', model: 'mock' },
            },
          }),
        }, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
        return lastSeq(session)
      }],
    ]

    for (const [lastType, build] of cases) {
      const source = ctx.sessions.create(SessionId(`open-${lastType}`))
      const boundary = build(source)

      expect(() => sessions.fork(source, SessionSeq(boundary)))
        .toThrow(new SessionForkError(`fork boundary ${boundary} in session "open-${lastType}" ends inside open turn 1`, 'OPEN_TURN'))
    }
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
