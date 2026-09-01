import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'

/** One pending message, as the inbox records it. */
function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Log an accepted message the way `Inbox.append()` does. */
function accept(session: Session, text: string): void {
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message(text)] })
}

/** Log the step-boundary read of one pending message, as `Inbox.claim()` does. */
function claim(session: Session): void {
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
}

/** Log a cancellation of one pending message, as `Inbox.clear()` does. */
function cancelPending(session: Session): void {
  session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
  })
}

/** Run one whole turn that reached a model step. */
function steppedTurn(session: Session, turn: number, reason: TurnEndReason): void {
  session.append('turn/start', { turn })
  claim(session)
  session.append('step/start', { turn, step: 1 })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason })
}

describe('foldConsumedWork', () => {
  it('reports nothing for a log that consumed no work', () => {
    const session = Session.create(SessionId('empty'))
    accept(session, 'queued')

    expect(foldConsumedWork(session.snapshotEvents())).toEqual({ droppedUnrun: false })
  })

  it('reports the latest turn that entered a model step', () => {
    const session = Session.create(SessionId('stepped'))
    steppedTurn(session, 1, { kind: 'completed' })
    steppedTurn(session, 2, { kind: 'max-tokens' })

    expect(foldConsumedWork(session.snapshotEvents()).end?.data)
      .toEqual({ turn: 2, reason: { kind: 'max-tokens' } })
  })

  it('reports a turn that claimed its input and then failed before any step', () => {
    const session = Session.create(SessionId('failed-claim'))
    steppedTurn(session, 1, { kind: 'completed' })
    // The step boundary runs the durability checkpoint and prompt assembly, so a
    // turn can take its input and then fail without entering a step.
    session.append('turn/start', { turn: 2 })
    claim(session)
    session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'ENOSPC', code: 'UNKNOWN' } } })

    expect(foldConsumedWork(session.snapshotEvents()).end?.data.turn).toBe(2)
  })

  it('reports a turn that claimed its input and was then stopped before any step', () => {
    const session = Session.create(SessionId('stopped-claim'))
    steppedTurn(session, 1, { kind: 'completed' })
    session.append('turn/start', { turn: 2 })
    claim(session)
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })

    expect(foldConsumedWork(session.snapshotEvents()).end?.data.turn).toBe(2)
  })

  it('ignores a turn stopped, failed, or rejected without taking any input', () => {
    const session = Session.create(SessionId('no-claim'))
    steppedTurn(session, 1, { kind: 'completed' })
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'parent' } } })
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
    session.append('turn/start', { turn: 4 })
    session.append('turn/end', { turn: 4, reason: { kind: 'blocked' } })

    // None of these turns describes work: they opened, found nothing of their own, and closed.
    expect(foldConsumedWork(session.snapshotEvents()).end?.data.turn).toBe(1)
  })

  it('reports a turn whose claimed input a pre-step rejection discarded', () => {
    const session = Session.create(SessionId('rejected-claim'))
    steppedTurn(session, 1, { kind: 'completed' })
    session.append('turn/start', { turn: 2 })
    claim(session)
    session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } })

    // Rejection does not retain the claimed messages, so the `blocked` end is
    // the only account of input that will never run.
    expect(foldConsumedWork(session.snapshotEvents()).end?.data.turn).toBe(2)
  })

  it('ignores a claim its own turn emptied', () => {
    const session = Session.create(SessionId('emptied-claim'))
    steppedTurn(session, 1, { kind: 'completed' })
    session.append('turn/start', { turn: 2 })
    claim(session)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    // An emptied claim ran nothing and dropped nothing: a listener rewrote the
    // batch away, which is not this log's account of the work.
    expect(foldConsumedWork(session.snapshotEvents()).end?.data.turn).toBe(1)
  })

  it('credits a claim with no open turn to no turn at all', () => {
    const session = Session.create(SessionId('mid-turn-suffix'))
    steppedTurn(session, 1, { kind: 'completed' })
    // An owned suffix can begin inside a turn whose start it does not contain,
    // so a claim may appear with no turn to attribute it to.
    claim(session)
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })

    expect(foldConsumedWork(session.snapshotEvents()).end?.data.turn).toBe(1)
  })

  it('reports work cancelled out of the inbox after the last accounting turn', () => {
    const session = Session.create(SessionId('dropped'))
    steppedTurn(session, 1, { kind: 'completed' })
    accept(session, 'never runs')
    cancelPending(session)

    // No turn opened over it, so only the cancellation says the work was cut short.
    expect(foldConsumedWork(session.snapshotEvents())).toEqual({
      end: session.snapshotEvents().find(event => event.type === 'turn/end'),
      droppedUnrun: true,
    })
  })

  it('keeps a replacement pending rather than counting it as dropped', () => {
    const session = Session.create(SessionId('replaced'))
    steppedTurn(session, 1, { kind: 'completed' })
    session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [message('rewritten')], outcome: 'canceled',
    })

    expect(foldConsumedWork(session.snapshotEvents()).droppedUnrun).toBe(false)
  })

  it('lets a later accounting turn absorb an earlier drop', () => {
    const session = Session.create(SessionId('absorbed'))
    steppedTurn(session, 1, { kind: 'completed' })
    cancelPending(session)
    steppedTurn(session, 2, { kind: 'completed' })

    expect(foldConsumedWork(session.snapshotEvents())).toEqual({
      end: session.snapshotEvents().findLast(event => event.type === 'turn/end'),
      droppedUnrun: false,
    })
  })
})
