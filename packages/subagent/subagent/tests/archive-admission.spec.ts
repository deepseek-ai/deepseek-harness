import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, AgentStatus, CancelOptions } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

type CancelCall = [AgentCancelCause, CancelOptions | undefined]

/** A registered Agent double whose status the test flips and whose cancels it records. */
type LiveAgent = Agent & { cancels: CancelCall[]; setStatus(status: AgentStatus): void }

async function harness(options: { sessionQuery?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (options.sessionQuery !== false) await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  return ctx
}

async function liveAgent(ctx: Context, session: Session, initial: AgentStatus): Promise<LiveAgent> {
  const cancels: CancelCall[] = []
  let status = initial
  const agent: LiveAgent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    get status() { return status },
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
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

/** A child session in the durable lineage this package records at delegation. */
function childOf(ctx: Context, id: string, parent: SessionId, label?: string): Session {
  const child = ctx.sessions.create(SessionId(id), { meta: { parentSession: parent, origin: 'subagent' } })
  if (label !== undefined) {
    child.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'spawn', label })
  }
  return child
}

function ask(ctx: Context, sessionId: SessionId): Promise<readonly SessionActivity[]> {
  return ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
}

function stop(ctx: Context, sessionId: SessionId): Promise<void> {
  return ctx.parallel('workspace/session-stop', { sessionId })
}

describe('Subagent archive admission: reporting', () => {
  it('reports running descendants by durable lineage at any depth, with their labels, but never forks', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('parent'))
    await liveAgent(ctx, parent, 'idle')
    const child = childOf(ctx, 'child', parent.id, 'reviewer')
    const childAgent = await liveAgent(ctx, child, 'idle')
    const grandchild = childOf(ctx, 'grandchild', child.id)
    await liveAgent(ctx, grandchild, 'running')
    const fork = ctx.sessions.create(SessionId('fork'), { meta: { parentSession: parent.id } })
    await liveAgent(ctx, fork, 'running')
    ctx.on('workspace/session-activity', async (_request, next) => [...(await next()), { kind: 'probe' }])

    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'grandchild' }] }, { kind: 'probe' }])
    childAgent.setStatus('running')
    expect(await ask(ctx, parent.id)).toEqual([
      { kind: 'subagent', items: [{ id: 'child', label: 'reviewer' }, { id: 'grandchild' }] },
      { kind: 'probe' },
    ])
    // A fork is an independent conversation: its own turn (reported by the
    // composed Agent registry) does not hold its source.
    expect(await ask(ctx, fork.id)).toEqual([{ kind: 'turn' }, { kind: 'probe' }])
    expect(await ask(ctx, SessionId('cold-or-unknown'))).toEqual([{ kind: 'probe' }])
  })

  it('names a child by id alone without the Session query service or with a damaged descriptor', async () => {
    const queryless = await harness({ sessionQuery: false })
    const parent = queryless.sessions.create(SessionId('parent'))
    await liveAgent(queryless, parent, 'idle')
    await liveAgent(queryless, childOf(queryless, 'child', parent.id, 'reviewer'), 'running')
    expect(await ask(queryless, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'child' }] }])

    const ctx = await harness()
    const damagedParent = ctx.sessions.create(SessionId('damaged-parent'))
    await liveAgent(ctx, damagedParent, 'idle')
    const damaged = ctx.sessions.create(SessionId('damaged-child'), { meta: { parentSession: damagedParent.id, origin: 'subagent' } })
    // A current-version payload whose label is not a string fails the descriptor parse.
    damaged.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'spawn', label: 7 } as never)
    await liveAgent(ctx, damaged, 'running')
    expect(await ask(ctx, damagedParent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'damaged-child' }] }])
  })

  it('visits a damaged lineage that loops only once', async () => {
    const ctx = await harness()
    // Two headers naming each other as subagent parents cannot be created by
    // delegation; a report over such data terminates instead of hanging.
    const first = ctx.sessions.create(SessionId('loop-a'), { meta: { parentSession: SessionId('loop-b'), origin: 'subagent' } })
    const second = ctx.sessions.create(SessionId('loop-b'), { meta: { parentSession: first.id, origin: 'subagent' } })
    await liveAgent(ctx, first, 'idle')
    await liveAgent(ctx, second, 'running')
    expect(await ask(ctx, first.id)).toEqual([{ kind: 'subagent', items: [{ id: 'loop-b' }] }])
  })
})

describe('Subagent archive admission: stopping', () => {
  it('cancels running descendants as their parent and leaves idle children and forks alone', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('stop-me'))
    const parentAgent = await liveAgent(ctx, parent, 'running')
    const childAgent = await liveAgent(ctx, childOf(ctx, 'stop-child', parent.id), 'running')
    const idleChildAgent = await liveAgent(ctx, childOf(ctx, 'idle-child', parent.id), 'idle')
    const fork = ctx.sessions.create(SessionId('stop-fork'), { meta: { parentSession: parent.id } })
    const forkAgent = await liveAgent(ctx, fork, 'running')

    await stop(ctx, parent.id)
    await stop(ctx, SessionId('nobody'))
    expect(childAgent.cancels).toEqual([[{ kind: 'parent' }, undefined]])
    expect(idleChildAgent.cancels).toEqual([])
    expect(forkAgent.cancels).toEqual([])
    // The parent's own turn is the composed Agent registry's family, cancelled with the user cause.
    expect(parentAgent.cancels).toEqual([[{ kind: 'user' }, undefined]])
  })

  it('keeps asking the remaining descendants to stop when one cancel throws', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('stubborn'))
    await liveAgent(ctx, parent, 'running')
    const stubborn = await liveAgent(ctx, childOf(ctx, 'stubborn-child', parent.id), 'running')
    stubborn.cancel = () => { throw new Error('child refuses cancel') }
    const quiet = await liveAgent(ctx, childOf(ctx, 'quiet-child', parent.id), 'running')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await stop(ctx, parent.id)
    expect(quiet.cancels).toEqual([[{ kind: 'parent' }, undefined]])
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('cancelling "stubborn-child"'),
    ])
  })
})

describe('Subagent archive admission: lifetime', () => {
  it('stops answering once the runtime fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(SubagentRuntime)
    const parent = ctx.sessions.create(SessionId('watched'))
    await liveAgent(ctx, parent, 'idle')
    const child = await liveAgent(ctx, childOf(ctx, 'watched-child', parent.id), 'running')
    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'watched-child' }] }])
    await fiber.dispose()
    expect(await ask(ctx, parent.id)).toEqual([])
    await stop(ctx, parent.id)
    expect(child.cancels).toEqual([])
  })
})

// The runtime knows only its own family; this suite merges a trailing one to observe ordering.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
  }
}
