import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, AgentStatus, CancelOptions } from '@deepseek-ai/dsh-agent'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'

type CancelCall = [AgentCancelCause, CancelOptions | undefined]

/** A registered Agent double whose status the test flips and whose cancels it records. */
type LiveAgent = Agent & { cancels: CancelCall[]; setStatus(status: AgentStatus): void }

async function liveAgent(ctx: Context, rawId: string, initial: AgentStatus): Promise<LiveAgent> {
  const id = SessionId(rawId)
  const cancels: CancelCall[] = []
  let status = initial
  const agent: LiveAgent = {
    id,
    options: {},
    session: Session.create(id),
    inbox: { nextTurn: [], nextStep: [] } as never,
    get status() { return status },
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: (cause, options) => { cancels.push([cause, options]) },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
    cancels,
    setStatus: (next) => { status = next },
  }
  await ctx.agents.register(agent)
  return agent
}

function ask(ctx: Context, sessionId: SessionId): Promise<readonly SessionActivity[]> {
  return ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
}

function stop(ctx: Context, sessionId: SessionId): Promise<void> {
  return ctx.parallel('workspace/session-stop', { sessionId })
}

describe('Turn archive admission', () => {
  it('reports the turn family only while the session\'s Agent is running, ahead of later providers', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const agent = await liveAgent(ctx, 'busy', 'running')
    await liveAgent(ctx, 'quiet', 'idle')
    ctx.on('workspace/session-activity', async (_request, next) => [...(await next()), { kind: 'probe' }])

    expect(await ask(ctx, agent.id)).toEqual([{ kind: 'turn' }, { kind: 'probe' }])
    expect(await ask(ctx, SessionId('quiet'))).toEqual([{ kind: 'probe' }])
    // A Session without a live Agent has no turn that could run.
    expect(await ask(ctx, SessionId('cold-or-unknown'))).toEqual([{ kind: 'probe' }])
    agent.setStatus('idle')
    expect(await ask(ctx, agent.id)).toEqual([{ kind: 'probe' }])
  })

  it('cancels a running turn with the user cause and without keeping the inbox, and leaves the rest alone', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const running = await liveAgent(ctx, 'stop-me', 'running')
    const idle = await liveAgent(ctx, 'already-idle', 'idle')

    await stop(ctx, running.id)
    await stop(ctx, idle.id)
    await stop(ctx, SessionId('nobody'))
    expect(running.cancels).toEqual([[{ kind: 'user' }, undefined]])
    expect(idle.cancels).toEqual([])
  })

  it('stops answering once the registry fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(AgentRegistry)
    const agent = await liveAgent(ctx, 'watched', 'running')
    expect(await ask(ctx, agent.id)).toEqual([{ kind: 'turn' }])
    await fiber.dispose()
    expect(await ask(ctx, agent.id)).toEqual([])
    await stop(ctx, agent.id)
    expect(agent.cancels).toEqual([])
  })
})

// The registry knows only its own family; this suite merges a second one to observe ordering.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
  }
}
