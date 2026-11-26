import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionLogOffset, type SessionEvent, type SessionEventMap, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { inboxProjectionDefinition as projection, type InboxProjectionState } from '../src/inbox.ts'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const a = message('a')
const b = message('b')
const c = message('c')
const edited = { ...a, content: [{ type: 'text' as const, text: 'a edited' }] }

function state(parts: {
  nextTurn?: typeof a[]
  nextStep?: typeof a[]
  pending?: typeof a[]
  interrupted?: typeof a[]
} = {}): InboxProjectionState {
  return {
    queues: { 'next-turn': parts.nextTurn ?? [], 'next-step': parts.nextStep ?? [] },
    claim: { pending: parts.pending ?? [], interrupted: parts.interrupted ?? [] },
  }
}

/** Committed events with real seqs, independent of any prior state. */
function scratch() {
  return Session.create(brandString<SessionId>('inbox-transition'))
}

function splice(data: Partial<SessionEventMap['agent/inbox/spliced']> & Pick<SessionEventMap['agent/inbox/spliced'], 'target'>) {
  return scratch().append('agent/inbox/spliced', { start: 0, inserted: [], ...data })
}

function stepStart() {
  return scratch().append('step/start', { turn: 1, step: 1 })
}

function turnEnd(reason: SessionEventMap['turn/end']['reason']) {
  return scratch().append('turn/end', { turn: 1, reason })
}

function fold(events: readonly SessionEvent[], initial = projection.init()) {
  return events.reduce((current, event) => projection.apply(current, event), initial)
}

describe('inbox projection transitions', () => {
  it.each<{ name: string; from: InboxProjectionState; event: SessionEvent; to: InboxProjectionState }>([
    {
      name: 'insert into next-turn extends the queue and leaves the claim alone',
      from: state({ nextTurn: [a], pending: [c] }),
      event: splice({ target: 'next-turn', start: 1, inserted: [b] }),
      to: state({ nextTurn: [a, b], pending: [c] }),
    },
    {
      name: 'insert into next-step extends that queue only',
      from: state({ nextTurn: [a] }),
      event: splice({ target: 'next-step', inserted: [b] }),
      to: state({ nextTurn: [a], nextStep: [b] }),
    },
    {
      name: 'removal without an outcome is a claim: removed messages append to pending in queue order',
      from: state({ nextTurn: [a, b], pending: [c] }),
      event: splice({ target: 'next-turn', removedCount: 2 }),
      to: state({ pending: [c, a, b] }),
    },
    {
      name: 'canceled removal discards the message from the queue and from both claim lists',
      from: state({ nextTurn: [a, b], pending: [a], interrupted: [b] }),
      event: splice({ target: 'next-turn', removedCount: 2, outcome: 'canceled' }),
      to: state(),
    },
    {
      name: 'canceled replacement under the same identity keeps the claim lists',
      from: state({ nextTurn: [a], interrupted: [a] }),
      event: splice({ target: 'next-turn', removedCount: 1, inserted: [edited], outcome: 'canceled' }),
      to: state({ nextTurn: [edited], interrupted: [a] }),
    },
    {
      name: 'canceled replacement under a new identity discards the claim',
      from: state({ nextTurn: [a], interrupted: [a] }),
      event: splice({ target: 'next-turn', removedCount: 1, inserted: [b], outcome: 'canceled' }),
      to: state({ nextTurn: [b] }),
    },
    {
      name: 'step/start settles the pending claim and keeps the interrupted one',
      from: state({ nextTurn: [b], pending: [a], interrupted: [c] }),
      event: stepStart(),
      to: state({ nextTurn: [b], interrupted: [c] }),
    },
    {
      name: 'turn/end interrupted moves the pending claim to interrupted',
      from: state({ pending: [a], interrupted: [c] }),
      event: turnEnd({ kind: 'interrupted' }),
      to: state({ interrupted: [a] }),
    },
    {
      name: 'turn/end with any other reason drops both claim lists',
      from: state({ nextTurn: [b], pending: [a], interrupted: [c] }),
      event: turnEnd({ kind: 'aborted', reason: { kind: 'user' } }),
      to: state({ nextTurn: [b] }),
    },
    {
      name: 'an inherited seed cut keeps the parent queue and drops the parent claims',
      from: state({ nextTurn: [b], pending: [a], interrupted: [c] }),
      event: scratch().append('session/end-seed', { inherited: true }),
      to: state({ nextTurn: [b] }),
    },
  ])('$name', ({ from, event, to }) => {
    expect(projection.apply(from, event)).toEqual(to)
  })

  it.each<{ name: string; from: InboxProjectionState; event: SessionEvent }>([
    { name: 'step/start without a pending claim', from: state({ interrupted: [a] }), event: stepStart() },
    { name: 'turn/end without any claim', from: state({ nextTurn: [a] }), event: turnEnd({ kind: 'completed' }) },
    { name: 'an inherited seed cut without claims', from: state({ nextTurn: [a] }), event: scratch().append('session/end-seed', { inherited: true }) },
    { name: 'a resume seed marker', from: state({ interrupted: [a] }), event: scratch().append('session/end-seed', {}) },
    { name: 'an unrelated event', from: state({ nextTurn: [a], pending: [b] }), event: scratch().append('turn/start', { turn: 1 }) },
  ])('$name returns the same state reference', ({ from, event }) => {
    expect(projection.apply(from, event)).toBe(from)
  })

  it('reuses the queue object across claim-only changes so the wire view does not republish', () => {
    const from = state({ nextTurn: [b], pending: [a] })
    const settled = projection.apply(from, stepStart())
    expect(settled).not.toBe(from)
    expect(projection.wire.view(settled)).toBe(projection.wire.view(from))
  })

  it.each<{ name: string; from: InboxProjectionState; event: SessionEvent }>([
    { name: 'start past the queue end', from: state({ nextTurn: [a] }), event: splice({ target: 'next-turn', start: 2 }) },
    { name: 'removal past the queue end', from: state({ nextTurn: [a] }), event: splice({ target: 'next-turn', removedCount: 2 }) },
    { name: 'a negative start', from: state(), event: splice({ target: 'next-turn', start: -1 }) },
    { name: 'an identity already pending in the other queue', from: state({ nextStep: [a] }), event: splice({ target: 'next-turn', inserted: [a] }) },
  ])('rejects $name with the event seq', ({ from, event }) => {
    expect(() => projection.apply(from, event)).toThrow(`invalid persisted inbox splice at session seq ${event.seq}`)
  })
})

function claimedInput() {
  const session = Session.create(brandString<SessionId>('inbox-claim'))
  const queued = message('queued')
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
  session.append('turn/start', { turn: 1 })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  return { session, message: queued }
}

describe('inbox settlement replay', () => {
  it('recovers claims after the last started step when a turn is interrupted', () => {
    const { session } = claimedInput()
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    const next = message('next step')
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [next] })
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    expect(fold(session.snapshotEvents()).claim.interrupted).toEqual([next])
  })

  it('recovers the same claim from a checkpoint and a full replay', () => {
    const { session, message } = claimedInput()
    const before = session.snapshotEvents()
    const checkpoint = projection.stateSchema.parse(JSON.parse(JSON.stringify(fold(before))))
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })

    const events = session.snapshotEvents()
    const state = fold(events.slice(before.length), checkpoint)
    expect(state).toEqual(fold(events))
    expect(state.claim).toEqual({ pending: [], interrupted: [message] })
    expect(projection.wire.view(state)).toBe(projection.wire.view(checkpoint))
  })

  it.each([1, 2])('rebuilds queues and claims from inbox checkpoint version %s', async (version) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(projection)
    const { session, message } = claimedInput()
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    const returned = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    const events = session.snapshotEvents()
    const queues = { 'next-turn': [message], 'next-step': [] }
    const oldRows = {
      inbox: {
        ver: version,
        seq: events[0]!.seq,
        val: version === 1 ? queues : { queues, settlement: { pending: [], dropped: null } },
      },
    }

    expect(ctx.sessionProjections.restoreFloor(oldRows)).toBe(0)
    const restored = ctx.sessionProjections.restore(oldRows, events, SessionLogOffset(0), session.header, SessionLogOffset(0))
    expect(restored.checkpoint).toEqual({ inbox: { ver: 3, seq: returned.seq, val: fold(events) } })
    expect(restored.snapshot.values).toEqual({ inbox: queues })
  })
})
