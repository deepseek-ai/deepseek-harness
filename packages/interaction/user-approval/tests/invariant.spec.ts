import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import * as ApprovalInvariant from '@deepseek-ai/dsh-user-approval/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ApprovalInvariant)
  return ctx
}

function startTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
}

describe('approval invariants', () => {
  it('accepts paired audit events and closed policy values', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = ApprovalRequestId('ask-1')
    session.append('approval/asked', { id, toolName: 'bash' })
    session.append('approval/decided', { id, outcome: 'allowed-once' })
    session.append('approval/policy', { policy: 'never' })
  })

  it('rebuilds an unmatched question from an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('ask-resume')
    session.append('approval/asked', { id, toolName: 'bash' })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ApprovalInvariant)
    expect(() => session.append('approval/decided', { id, outcome: 'cancelled' })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session first observed through publication', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('bare-approval-session'))
    const id = ApprovalRequestId('bare-ask')
    const asked = {
      type: 'approval/asked', seq: SessionSeq(0), time: 0, data: { id, toolName: 'bash' },
    } as const
    const decided = {
      type: 'approval/decided', seq: SessionSeq(1), time: 1, data: { id, outcome: 'rejected' as const },
    } as const
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: SessionSeq(0), time: 0,
        data: { turn: 1 },
      })
      ctx.emit('session/event', session, asked)
      ctx.emit('session/event', session, decided)
    }).not.toThrow()
  })

  it('rejects audit events outside any open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('approval/asked', {
      id: ApprovalRequestId('ask-1'), toolName: 'bash',
    })).toThrow(/outside any open turn/)
    expect(() => session.append('approval/decided', {
      id: ApprovalRequestId('ask-1'), outcome: 'rejected',
    })).toThrow(/outside any open turn/)
  })

  it('rejects an unenclosed audit event when replaying an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('approval/asked', {
      id: ApprovalRequestId('ask-replay'), toolName: 'bash',
    })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(ApprovalInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it('rejects malformed and unpaired audit events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = ApprovalRequestId('ask-1')
    expect(() => session.append('approval/asked', { id, toolName: '' }))
      .toThrow(/toolName must be non-empty/)
    session.append('approval/asked', { id, toolName: 'bash' })
    expect(() => session.append('approval/asked', { id, toolName: 'bash' }))
      .toThrow(/repeated open id/)
    expect(() => session.append('approval/decided', {
      id: ApprovalRequestId('missing'), outcome: 'rejected',
    })).toThrow(/no matching approval\/asked/)
    expect(() => session.append('approval/decided', { id, outcome: 'maybe' as never }))
      .toThrow(/unknown outcome/)
    expect(() => session.append('approval/policy', { policy: 'always' as never }))
      .toThrow(/unknown policy/)
  })
})
