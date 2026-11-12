import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, AgentStatus, CancelOptions } from '@deepseek-ai/dsh-agent'
import { unsupportedModel, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { type SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

type CancelCall = [AgentCancelCause, CancelOptions | undefined]

/** A registered Agent double whose status the test flips and whose cancels it records. */
type LiveAgent = Agent & { cancels: CancelCall[]; setStatus(status: AgentStatus): void }

async function harness(options: { sessionQuery?: boolean; runtime?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (options.sessionQuery !== false) await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  if (options.runtime !== false) await ctx.plugin(SubagentRuntime)
  return ctx
}

async function liveAgent(ctx: Context, session: Session, initial: AgentStatus): Promise<LiveAgent> {
  const cancels: CancelCall[] = []
  let status = initial
  const agent: LiveAgent = {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
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
  const child = ctx.sessions.create(brandString<SessionId>(id), { meta: { parentSession: parent, origin: 'subagent' } })
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

function proposed(ctx: Context, agent: Agent) {
  return ctx.waterfall('agent/pre-step', {
    agent, modelSelection: { provider: 'mock', model: 'mock' }, messages: [], turn: 1, step: 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
}

describe('Subagent archive admission: reporting', () => {
  it('reports running descendants by durable lineage at any depth, with their labels, but never forks', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(brandString<SessionId>('parent'))
    await liveAgent(ctx, parent, 'idle')
    const child = childOf(ctx, 'child', parent.id, 'reviewer')
    const childAgent = await liveAgent(ctx, child, 'idle')
    const grandchild = childOf(ctx, 'grandchild', child.id)
    await liveAgent(ctx, grandchild, 'running')
    const fork = ctx.sessions.create(brandString<SessionId>('fork'), { meta: { parentSession: parent.id } })
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
    expect(await ask(ctx, brandString<SessionId>('cold-or-unknown'))).toEqual([{ kind: 'probe' }])
  })

  it('reports a child label without the Session query service', async () => {
    const queryless = await harness({ sessionQuery: false })
    const parent = queryless.sessions.create(brandString<SessionId>('parent'))
    await liveAgent(queryless, parent, 'idle')
    await liveAgent(queryless, childOf(queryless, 'child', parent.id, 'reviewer'), 'running')
    expect(await ask(queryless, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'child', label: 'reviewer' }] }])
  })

  it('names a child by id alone with a damaged descriptor', async () => {
    const ctx = await harness()
    const damagedParent = ctx.sessions.create(brandString<SessionId>('damaged-parent'))
    await liveAgent(ctx, damagedParent, 'idle')
    const damaged = ctx.sessions.create(brandString<SessionId>('damaged-child'), { meta: { parentSession: damagedParent.id, origin: 'subagent' } })
    // A current-version payload whose label is not a string fails the descriptor parse.
    damaged.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'spawn', label: 7 } as never)
    await liveAgent(ctx, damaged, 'running')
    expect(await ask(ctx, damagedParent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'damaged-child' }] }])
  })

  it('uses only the latest own descriptor identity without observing history', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(brandString<SessionId>('seed-parent'))
    await liveAgent(ctx, parent, 'idle')
    const child = ctx.sessions.create(brandString<SessionId>('seed-child'), {
      meta: { parentSession: parent.id, origin: 'subagent', isSeeded: true },
      seed: [{
        type: 'subagent/descriptor', seq: SessionSeq(0), time: 1,
        data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'fork', label: 'ancestor' },
      }],
      inheritedEventCount: SessionLogOffset(1),
    })
    await liveAgent(ctx, child, 'running')
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    onTestFinished(() => { observe.mockRestore() })

    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: child.id }] }])
    for (const label of ['reviewer', 'latest reviewer']) {
      child.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'fork', label })
      expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: child.id, label }] }])
    }
    child.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'fork', label: 7 } as never)
    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: child.id }] }])
    child.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION + 1, mode: 'continuable', provider: 'fork', label: 'unknown' })
    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: child.id }] }])
    child.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'fork' })
    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: child.id }] }])
    expect(observe).not.toHaveBeenCalled()
  })

  it('visits a damaged lineage that loops only once', async () => {
    const ctx = await harness()
    // Two headers naming each other as subagent parents cannot be created by
    // delegation; a report over such data terminates instead of hanging.
    const first = ctx.sessions.create(brandString<SessionId>('loop-a'), { meta: { parentSession: brandString<SessionId>('loop-b'), origin: 'subagent' } })
    const second = ctx.sessions.create(brandString<SessionId>('loop-b'), { meta: { parentSession: first.id, origin: 'subagent' } })
    await liveAgent(ctx, first, 'idle')
    await liveAgent(ctx, second, 'running')
    expect(await ask(ctx, first.id)).toEqual([{ kind: 'subagent', items: [{ id: 'loop-b' }] }])
  })
})

describe('Subagent archive admission: stopping', () => {
  it('cancels running descendants as their parent and leaves idle children and forks alone', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(brandString<SessionId>('stop-me'))
    const parentAgent = await liveAgent(ctx, parent, 'running')
    const childAgent = await liveAgent(ctx, childOf(ctx, 'stop-child', parent.id), 'running')
    const idleChildAgent = await liveAgent(ctx, childOf(ctx, 'idle-child', parent.id), 'idle')
    const fork = ctx.sessions.create(brandString<SessionId>('stop-fork'), { meta: { parentSession: parent.id } })
    const forkAgent = await liveAgent(ctx, fork, 'running')

    await stop(ctx, parent.id)
    await stop(ctx, brandString<SessionId>('nobody'))
    expect(childAgent.cancels).toEqual([[{ kind: 'parent' }, undefined]])
    expect(idleChildAgent.cancels).toEqual([])
    expect(forkAgent.cancels).toEqual([])
    // The parent's own turn is the composed Agent registry's family, cancelled with the user cause.
    expect(parentAgent.cancels).toEqual([[{ kind: 'user' }, undefined]])
  })

  it('keeps asking the remaining descendants to stop when one cancel throws', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(brandString<SessionId>('stubborn'))
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
  it.each(['ready', 'failed', 'disposed'] as const)('installs reporting only after identity registration is %s', async (outcome) => {
    const ctx = await harness({ runtime: false })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
    const registration = vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
      const handle = await register(definition)
      if (definition.key === 'subagent') {
        entered.resolve(undefined)
        await release.promise
      }
      return handle
    })
    onTestFinished(() => { registration.mockRestore() })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    const parent = ctx.sessions.create(brandString<SessionId>('initializing-parent'))
    await liveAgent(ctx, parent, 'idle')
    await liveAgent(ctx, childOf(ctx, 'initializing-child', parent.id, 'reviewer'), 'running')
    const fiber = ctx.plugin(SubagentRuntime)
    await entered.promise
    expect(await ask(ctx, parent.id)).toEqual([])

    if (outcome === 'failed') {
      const failure = expect(Promise.resolve(fiber)).rejects.toThrow('identity registration failed')
      release.reject(new Error('identity registration failed'))
      await failure
      expect(error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'identity registration failed' }))
    } else {
      const disposal = outcome === 'disposed' ? fiber.dispose() : undefined
      release.resolve(undefined)
      await (disposal ?? fiber)
      expect(error).not.toHaveBeenCalled()
    }
    expect(await ask(ctx, parent.id)).toEqual(outcome === 'ready'
      ? [{ kind: 'subagent', items: [{ id: 'initializing-child', label: 'reviewer' }] }]
      : [])
  })

  it('checks header ancestry for unmanaged Agents and permits independent forks', async () => {
    const ctx = await harness()
    const parentId = brandString<SessionId>('offline-parent')
    const archived: SessionId[] = [parentId]
    ctx.provide('workspaceRegistry', { get archivedSessionIds() { return archived } } as never)
    const child = await liveAgent(ctx, childOf(ctx, 'orphan', parentId), 'idle')
    const fork = await liveAgent(ctx, ctx.sessions.create(brandString<SessionId>('fork'), { meta: { parentSession: parentId } }), 'idle')
    expect(await proposed(ctx, child)).toEqual({ kind: 'reject' })
    expect(await proposed(ctx, fork)).toEqual({ kind: 'enter', messages: [] })
    archived.length = 0
    expect(await proposed(ctx, child)).toEqual({ kind: 'enter', messages: [] })
  })

  it('removes archive listeners on disposal and restores them on replacement', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await mountWorkingDirectoryFixture(ctx)
    const fiber = await ctx.plugin(SubagentRuntime)
    const parent = ctx.sessions.create(brandString<SessionId>('watched'))
    await liveAgent(ctx, parent, 'idle')
    const child = await liveAgent(ctx, childOf(ctx, 'watched-child', parent.id, 'reviewer'), 'running')
    ctx.provide('workspaceRegistry', { archivedSessionIds: [parent.id] } as never)
    expect(await proposed(ctx, child)).toEqual({ kind: 'reject' })
    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'watched-child', label: 'reviewer' }] }])
    await fiber.dispose()
    expect(await ask(ctx, parent.id)).toEqual([])
    await stop(ctx, parent.id)
    expect(child.cancels).toEqual([])
    expect(await proposed(ctx, child)).toEqual({ kind: 'enter', messages: [] })
    await ctx.plugin(SubagentRuntime)
    expect(await ask(ctx, parent.id)).toEqual([{ kind: 'subagent', items: [{ id: 'watched-child', label: 'reviewer' }] }])
    expect(await proposed(ctx, child)).toEqual({ kind: 'reject' })
    await stop(ctx, parent.id)
    expect(child.cancels).toEqual([[{ kind: 'parent' }, undefined]])
  })
})

// The runtime knows only its own family; this suite merges a trailing one to observe ordering.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
  }
}
