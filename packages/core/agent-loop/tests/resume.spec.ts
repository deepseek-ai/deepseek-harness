import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-resume-'))
  dirs.push(root)
  return { ctx: await mountPersistentHarness(root, adapter), root }
}

async function mountPersistentHarness(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function persistSession(sessionId: SessionId): Promise<string> {
  const { ctx, root } = await persistentHarness(new MockAdapter([textResponse('seed')]))
  // Persistence deliberately has no artifact for a truly empty session. A
  // balanced completed turn is the smallest resumable log and avoids running
  // the model merely to construct this lifecycle fixture.
  const seed: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = ctx.sessions.create(sessionId, { seed })
  await ctx.sessions.flush(session)
  await ctx.fiber.dispose()
  return root
}

/** Build a detached preparation for lifecycle-race test doubles. */
function preparationFromSnapshot(
  ctx: Context,
  snapshot: { meta: SessionHeader; events: readonly SessionEvent[] },
): SessionPreparation {
  return SessionPreparation.create(ctx.sessions.prepare(snapshot.meta.id, {
    seed: structuredClone(snapshot.events) as SessionEvent[],
    meta: structuredClone(snapshot.meta),
    seedSource: 'persistence',
  }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Fail a lifecycle regression promptly instead of waiting for Vitest's suite timeout. */
async function promptly<T>(job: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => { timeout.reject(new Error('lifecycle task did not settle promptly')) }, 1000)
  try {
    return await Promise.race([job, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Throw an arbitrary callback value to exercise the public unknown-error boundary. */
function throwUnknown(value: unknown): never {
  throw value
}

describe('the session-persistence Agent Note: AgentLoop factory create/resume', () => {
  it('resumes a pre-react-loop session including pre-identity message events', async () => {
    const sessionId = SessionId('pre-identity-resume')
    const first = await persistentHarness(new MockAdapter([]))
    await first.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
    })
    await first.ctx.sessionPersistence.append(sessionId, [
      {
        type: 'turn/start', seq: 0, time: 1,
        data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      },
      {
        type: 'user/message',
        seq: 1,
        time: 2,
        data: { content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' } },
        surfaceOp: 'append',
      },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          content: [{ type: 'text', text: 'old answer' }],
          provenance: { provider: 'mock', model: 'mock' },
        },
        surfaceOp: 'append',
      },
      {
        type: 'steering/message',
        seq: 4,
        time: 5,
        data: {
          turn: 1,
          content: [{ type: 'text', text: 'old steering' }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[])
    await first.ctx.fiber.dispose()

    const ctx = await mountPersistentHarness(first.root, new MockAdapter([textResponse('new answer')]))
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(handle.agent.session.deriveMessages()).toMatchObject([
      { id: `legacy-message:${sessionId}:1`, role: 'user' },
      { id: `legacy-message:${sessionId}:3`, role: 'assistant' },
      { id: `legacy-message:${sessionId}:4`, role: 'user' },
    ])
    expect(handle.agent.inbox.nextTurn).toEqual([])
    expect(handle.agent.inbox.nextStep).toEqual([])

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'new question' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, handle.agent)
    expect(handle.agent.session.deriveMessages()).toHaveLength(5)
    expect(handle.agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('normalizes a non-Error resume publication failure for rollback and rethrows it', async () => {
    const sessionId = SessionId('unknown-resume-failure-s')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const failure = { source: 'resume' }
    ctx.on('session/created', () => throwUnknown(failure))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
    })).rejects.toBe(failure)

    expect(ctx.agents.get(SessionId('unknown-resume-failure'))).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('createAgent uses the caller-supplied sessionId (not ${id}-session)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('custom-session'), meta: { cwd: '/w' } })
    expect(agent.session.id).toBe('custom-session')
    expect(agent.session.header.cwd).toBe('/w')
    await ctx.fiber.dispose()
  })

  it('createAgent rejects a duplicate identity without orphaning a session', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const sessionId = SessionId('sess-a')
    await ctx.agents.create({ sessionId })
    await expect(ctx.agents.create({ sessionId })).rejects.toThrow(/already exists/)
    expect(ctx.sessions.list()).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('resume cannot crash-repair a turn owned by a live agent', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('unused')]))
    const sessionId = SessionId('live-resume-race')
    const first = (await ctx.agents.create({ sessionId })).agent
    first.session.append('turn/start', { turn: 1 })
    await ctx.sessions.flush(first.session)

    await expect(ctx.agents.resume({ resumeSessionId: sessionId }))
      .rejects.toThrow(/while it is live/)

    first.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(first.session)
    const loaded = await ctx.sessionPersistence.load(sessionId)
    expect(loaded.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(loaded.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await ctx.fiber.dispose()
  })

  it('createAgent works without meta (no cwd)', async () => {
    const adapter = new MockAdapter([textResponse('hi')])
    const { ctx } = await persistentHarness(adapter)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('nometa-session') })
    expect(agent.session.id).toBe('nometa-session')
    expect(agent.session.header.cwd).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('resume of a session with no cwd carries an undefined cwd header', async () => {
    // Lifecycle 1: create a no-cwd session and run a turn.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('nocwd-sess') })).agent
    a1.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume it; the header cwd stays undefined (no-cwd branch).
    const adapter2 = new MockAdapter([textResponse('b')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(JsonlSessionPersistence, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('nocwd-sess') })).agent
    expect(a2.session.header.cwd).toBeUndefined()
    await ctx2.fiber.dispose()
  })

  it('agent/session-start fires "startup" for createAgent and "resume" for resume()', async () => {
    // Lifecycle 1: a fresh createAgent emits session-start with source 'startup'.
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const sources1: string[] = []
    ctx1.on('agent/session-start', ({ source }) => void sources1.push(source))
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('start-sess') })).agent
    expect(sources1).toEqual(['startup'])
    a1.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Lifecycle 2: resuming the persisted session emits session-start 'resume'.
    const adapter2 = new MockAdapter([textResponse('b')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(JsonlSessionPersistence, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const sources2: string[] = []
    ctx2.on('agent/session-start', ({ source }) => void sources2.push(source))
    await ctx2.agents.resume({ resumeSessionId: SessionId('start-sess') })
    expect(sources2).toEqual(['resume'])
    await ctx2.fiber.dispose()
  })

  it('resume awaits setup while unpublished, then publishes a fully composed world in order', async () => {
    const sessionId = SessionId('resume-setup-success')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const order: string[] = []

    ctx.on('session/created', (session) => {
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(ctx.agents.get(sessionId)?.session).toBe(session)
      order.push('session/created')
    })
    ctx.on('agent/created', ({ agent }) => {
      expect(agent.status).toBe('idle')
      order.push('agent/created')
    })
    ctx.on('agent/session-start', ({ agent }) => {
      expect(() => { agent.cancel({ kind: 'user' }) }).not.toThrow()
      order.push('agent/session-start')
    })

    const resuming = ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx) => {
        expect(agentCtx.agent?.id).toBe(sessionId)
        // The two persisted events plus the end-seed marker.
        expect(agentCtx.agent?.session.snapshotEvents()).toHaveLength(3)
        agentCtx.on('session/created', () => void order.push('setup-listener:session/created'))
        agentCtx.on('agent/created', () => void order.push('setup-listener:agent/created'))
        order.push('setup:start')
        setupStarted.resolve(undefined)
        await gate.promise
        order.push('setup:end')
        return {
          commit: () => {
            expect(ctx.agents.get(sessionId)).toBeUndefined()
            expect(ctx.sessions.get(sessionId)).toBeUndefined()
            order.push('setup:commit')
          },
        }
      },
    })

    await setupStarted.promise
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(order).toEqual(['setup:start'])

    gate.resolve(undefined)
    const handle = await resuming
    expect(order).toEqual([
      'setup:start',
      'setup:end',
      'setup:commit',
      'session/created',
      'setup-listener:session/created',
      'agent/created',
      'setup-listener:agent/created',
      'agent/session-start',
    ])
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('successful resume disposal retires its caller-owned transaction effects', async () => {
    const sessionId = SessionId('resume-retired-effects-s')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const transactionLabels = [`agentLoop.lifecycle(${sessionId})`]

    expect(ctx.fiber.getEffects().map(effect => effect.label)).toEqual(expect.arrayContaining(transactionLabels))
    await handle.dispose()
    expect(ctx.fiber.getEffects().filter(effect => transactionLabels.includes(effect.label))).toEqual([])
    await ctx.fiber.dispose()
  })

  it('resume setup rejection publishes nothing, unwinds, and releases the identity', async () => {
    const sessionId = SessionId('resume-setup-reject')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {
        await Promise.resolve()
        throw new Error('resume setup failed')
      },
    })).rejects.toThrow('resume setup failed')

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const retry = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('resume setup commit rejection publishes nothing and releases the identity', async () => {
    const sessionId = SessionId('resume-setup-commit-reject')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: () => ({
        commit: () => { throw new Error('resume setup commit failed') },
      }),
    })).rejects.toThrow('resume setup commit failed')

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const retry = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('owner unload aborts resume setup and cannot publish after the callback settles', async () => {
    const sessionId = SessionId('resume-setup-owner-unload')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    let resuming!: ReturnType<typeof ctx.agents.resume>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      resuming = inner.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async () => {
          setupStarted.resolve(undefined)
          await gate.promise
        },
      })
    }, { inject: ['agents'] }))
    await setupStarted.promise

    await owner.dispose()
    await expect(resuming).rejects.toThrow(/owner disposed during setup/)
    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    gate.resolve(undefined)
    await Promise.resolve()
    expect(published).toEqual([])
    await ctx.fiber.dispose()
  })

  it('owner unload aborts a never-settling persistence preparation, releases the identity, and blocks late publication', async () => {
    const sessionId = SessionId('resume-load-owner-unload')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([textResponse('next')]))
    const snapshot = await ctx.sessionPersistence.load(sessionId)
    const abandoned = preparationFromSnapshot(ctx, snapshot)
    const latePreparation = Promise.withResolvers<SessionPreparation>()
    const preparationStarted = Promise.withResolvers<undefined>()
    const originalPrepare = ctx.sessionPersistence.prepare.bind(ctx.sessionPersistence)
    let preparations = 0
    ctx.sessionPersistence.prepare = (id, signal) => {
      expect(id).toBe(sessionId)
      preparations += 1
      if (preparations === 1) {
        preparationStarted.resolve(undefined)
        return latePreparation.promise
      }
      return originalPrepare(id, signal)
    }

    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))

    let resuming!: ReturnType<typeof ctx.agents.resume>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      resuming = inner.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    }, { inject: ['agents'] }))
    await preparationStarted.promise

    const rejection = expect(promptly(resuming)).rejects.toThrow(/owner disposed during setup/)
    await promptly(owner.dispose())
    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    // owner.dispose() awaited transaction settlement, so the same identities
    // can be reused before awaiting the public rejection.
    const retry = await promptly(ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } }))
    await rejection
    expect(preparations).toBe(2)
    expect(published).toEqual(['session/created', 'agent/created', 'agent/session-start'])

    // Settlement of the abandoned backend promise cannot resume the old
    // transaction or emit a second publication after the retry owns the ids.
    latePreparation.resolve(abandoned)
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.agents.get(sessionId)).toBe(retry.agent)
    expect(ctx.sessions.get(sessionId)).toBe(retry.agent.session)
    expect(published).toEqual(['session/created', 'agent/created', 'agent/session-start'])

    abandoned[Symbol.dispose]()
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('AgentLoop unload aborts persistence preparation and awaits wrapper settlement', async () => {
    const sessionId = SessionId('resume-load-factory-unload')
    const root = await persistSession(sessionId)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('next')]))

    const snapshot = await ctx.sessionPersistence.load(sessionId)
    const abandoned = preparationFromSnapshot(ctx, snapshot)
    const latePreparation = Promise.withResolvers<SessionPreparation>()
    const preparationStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.prepare = (id) => {
      expect(id).toBe(sessionId)
      preparationStarted.resolve(undefined)
      return latePreparation.promise
    }
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    const resuming = ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    await preparationStarted.promise
    const rejection = expect(promptly(resuming)).rejects.toThrow(/agent loop is not active/)
    await promptly(loopFiber.dispose())
    await rejection

    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    latePreparation.resolve(abandoned)
    await Promise.resolve()
    await Promise.resolve()
    expect(published).toEqual([])
    abandoned[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('resume of a forked session preserves the lineage, seed boundary, and delegation depth in the header', async () => {
    // Lifecycle 1: persist a FORKED session (carries parentSession + seedLength
    // in its header) by creating it with a complete-turn seed — the write path
    // materializes the fork (header + seed) on disk.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const adapter1 = new MockAdapter([textResponse('a')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const forked = ctx1.sessions.create(SessionId('forked-sess'), {
      seed,
      meta: { cwd: '/w', parentSession: SessionId('parent-sess'), seedLength: seed.length, delegationDepth: 1 },
    })
    await ctx1.sessions.flush(forked)
    await ctx1.fiber.dispose()

    // Lifecycle 2: resume it; the parentSession + seedLength header survives the
    // round-trip (exercises resume's parentSession- and seedLength-present
    // branches). seedLength must come from the PERSISTED header, not from the
    // resume seed length (which is the whole stored log, not the original
    // boundary).
    const adapter2 = new MockAdapter([textResponse('b')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(JsonlSessionPersistence, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('forked-sess') })).agent
    expect(a2.session.header.parentSession).toBe('parent-sess')
    expect(a2.session.header.cwd).toBe('/w')
    expect(a2.session.header.seedLength).toBe(seed.length)
    // The recursion budget survives resume — a dropped depth would let a
    // resumed child delegate as if it were top-level.
    expect(a2.session.header.delegationDepth).toBe(1)
    await ctx2.fiber.dispose()
  })

  it('a pending idle inject() survives persist + resume without a synthetic turn', async () => {
    const adapter1 = new MockAdapter([textResponse('answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('inject-sess'), meta: { cwd: '/w' } })).agent
    a1.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, a1)
    a1.inject(createUserMessage({ content: [{ type: 'text', text: 'background job 42 finished' }], source: { kind: 'plugin', plugin: 'tool-bash' } }))
    await a1.whenIdle()
    await ctx1.sessions.flush(a1.session)

    // Lifecycle 2: resume; the injected context is still pending and becomes
    // model-visible when the next turn admits it.
    const adapter2 = new MockAdapter([textResponse('next')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(JsonlSessionPersistence, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const loaded = await ctx2.sessionPersistence.load(SessionId('inject-sess'))
    expect(loaded.events.some(event => event.type === 'agent/inbox/spliced')).toBe(true)
    expect(JSON.stringify(loaded.events)).toContain('background job 42 finished')
    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('inject-sess') })).agent
    expect(JSON.stringify(a2.inbox.nextStep)).toContain('background job 42 finished')
    a2.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await waitForIdle(ctx2, a2)
    const flat = JSON.stringify(a2.session.deriveMessages())
    expect(flat).toContain('background job 42 finished')
    await ctx2.fiber.dispose()
    await ctx1.fiber.dispose()
  })

  it('resume reloads a persisted session: history + turn numbering continue, no duplicate seqs', async () => {
    // Lifecycle 1: run one full turn, persisting it.
    const adapter1 = new MockAdapter([textResponse('first answer')])
    const { ctx: ctx1, root } = await persistentHarness(adapter1)
    const a1 = (await ctx1.agents.create({ sessionId: SessionId('sess-resume'), meta: { cwd: '/w' } })).agent
    a1.followup(createUserMessage({ content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, a1)
    const events1 = a1.session.snapshotEvents()
    const seqs1 = events1.map(e => e.seq)
    expect(seqs1).toEqual([...seqs1].sort((x, y) => x - y)) // contiguous
    await ctx1.fiber.dispose()

    // Lifecycle 2: a brand-new context over the SAME root; resume the session.
    const adapter2 = new MockAdapter([textResponse('second answer')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(JsonlSessionPersistence, { root })
    ctx2.llm.registerAdapter(['mock'], adapter2)

    const a2 = (await ctx2.agents.resume({ resumeSessionId: SessionId('sess-resume') })).agent
    // The resumed session carries the prior history…
    expect(a2.session.id).toBe('sess-resume')
    // …followed by one end-seed event marking the constructor seed.
    expect(a2.session.snapshotEvents().length).toBe(events1.length + 1)
    expect(a2.session.firstLiveSeq).toBe(events1.length)
    expect(a2.session.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
    const replay = Session.create(SessionId('replay'), events1)
    expect(a2.session.deriveMessages()).toEqual(replay.deriveMessages())

    // …and a new turn continues numbering (turn 2) with contiguous seqs.
    a2.followup(createUserMessage({ content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } }))
    await waitForIdle(ctx2, a2)
    const allSeqs = a2.session.snapshotEvents().map(e => e.seq)
    expect(allSeqs).toEqual(allSeqs.map((_, i) => i)) // 0..N contiguous, no duplicates
    const turnStarts = a2.session.snapshotEvents().filter(e => e.type === 'turn/start')
    expect(turnStarts.map(e => e.type === 'turn/start' && e.data.turn)).toEqual([1, 2])
    await ctx2.fiber.dispose()
  })

  it('resume rejects when session persistence is not configured', async () => {
    // A harness WITHOUT the persistence plugin.
    const adapter = new MockAdapter([textResponse('x')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('nope') }))
      .rejects.toThrow(/session persistence is not configured/)
    await ctx.fiber.dispose()
  })
})

describe('creation and resume cancellation edges', () => {
  it('rejects create() with a pre-aborted signal, including a non-Error reason', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))

    const errorReason = new AbortController()
    errorReason.abort(new Error('caller gave up'))
    await expect(promptly(ctx.agents.create({
      sessionId: SessionId('pre-aborted-error'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: errorReason.signal,
    }))).rejects.toThrow('caller gave up')

    // A non-Error reason is wrapped into the creation-aborted error.
    const stringReason = new AbortController()
    stringReason.abort('operator string reason')
    await expect(promptly(ctx.agents.create({
      sessionId: SessionId('pre-aborted-string'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: stringReason.signal,
    }))).rejects.toThrow(/creation aborted/)

    expect(ctx.agents.get(SessionId('pre-aborted-error'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('pre-aborted-string'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('a non-Error abort reason arriving during setup is wrapped for the caller', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const controller = new AbortController()
    const setupEntered = Promise.withResolvers<undefined>()
    const setupGate = Promise.withResolvers<undefined>()

    const creating = ctx.agents.create({
      sessionId: SessionId('setup-string-abort'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
      async setup() {
        setupEntered.resolve(undefined)
        await setupGate.promise
      },
    })
    await setupEntered.promise
    controller.abort('mid-setup string reason')
    setupGate.resolve(undefined)

    await expect(promptly(creating)).rejects.toThrow(/creation aborted/)
    expect(ctx.agents.get(SessionId('setup-string-abort'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects when setup synchronously aborts its caller signal', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const controller = new AbortController()

    const creating = ctx.agents.create({
      sessionId: SessionId('setup-synchronous-abort'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
      setup() {
        controller.abort(new Error('setup synchronously cancelled'))
      },
    })

    await expect(promptly(creating)).rejects.toThrow('setup synchronously cancelled')
    expect(ctx.agents.get(SessionId('setup-synchronous-abort'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('resume with a pre-aborted caller signal rejects out of the load race', async () => {
    const sessionId = SessionId('resume-pre-aborted')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const controller = new AbortController()
    controller.abort(new Error('resume abandoned'))

    await expect(promptly(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
    }))).rejects.toThrow('resume abandoned')

    const stringReason = new AbortController()
    stringReason.abort('resume string reason')
    await expect(promptly(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: stringReason.signal,
    }))).rejects.toThrow(/creation aborted/)

    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('releases a restored preparation if the loop becomes inactive before setup', async () => {
    const sessionId = SessionId('resume-loop-inactive-after-prepare')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const loop = ctx.agentLoop as unknown as {
      ownership: { isActive: () => boolean }
    }
    vi.spyOn(loop.ownership, 'isActive').mockReturnValueOnce(false)

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toThrow('agent loop is not active')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('factory teardown during a hung resume preparation rejects with loop-inactive', async () => {
    const sessionId = SessionId('resume-loop-teardown')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const snapshot = await ctx.sessionPersistence.load(sessionId)
    const abandoned = preparationFromSnapshot(ctx, snapshot)
    const gate = Promise.withResolvers<SessionPreparation>()
    const preparationStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.prepare = () => {
      preparationStarted.resolve(undefined)
      return gate.promise
    }

    const resuming = ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await preparationStarted.promise
    // Resolve the preparation only after teardown began: the post-prepare ownership
    // check, not the abort race, must reject the wrapper.
    const rejection = expect(promptly(resuming)).rejects.toThrow()
    const disposal = ctx.fiber.dispose()
    gate.resolve(abandoned)
    await rejection
    await disposal
    abandoned[Symbol.dispose]()
  })
})

describe('configured-start failure edges', () => {
  it('a non-Error mid-prepare abort reason is wrapped for the resume caller', async () => {
    const sessionId = SessionId('resume-string-mid-abort')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const gate = Promise.withResolvers<never>()
    gate.promise.catch(() => undefined)
    const preparationStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.prepare = () => {
      preparationStarted.resolve(undefined)
      return gate.promise
    }
    const controller = new AbortController()

    const resuming = ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: controller.signal,
    })
    await preparationStarted.promise
    controller.abort('operator string reason')

    await expect(promptly(resuming)).rejects.toThrow(/creation aborted/)
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('a failing exact-id restore over an existing artifact stays loud', async () => {
    const sessionId = SessionId('config-existing-corrupt')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    // The artifact exists (list reports it) but its load fails: this is
    // corruption, not first creation — the failure must be reported, and no
    // fresh same-id session may shadow the broken one.
    ctx.sessionPersistence.prepare = () => Promise.reject(new Error('artifact corrupt'))

    const configured = new Context()
    await configured.plugin(LlmRuntime)
    await configured.plugin(SessionStore)
    await configured.plugin(SessionProjectionRegistry)
    await configured.plugin(SystemPrompt)
    await configured.plugin(ToolRuntime)
    await configured.plugin(AgentRegistry)
    await configured.plugin(JsonlSessionPersistence, { root })
    configured.llm.registerAdapter(['mock'], new MockAdapter([]))
    configured.sessionPersistence.prepare = (id, signal) => ctx.sessionPersistence.prepare(id, signal)
    const configFailures: unknown[] = []
    configured.on('agent-loop/config-start-failed', ({ error }) => { configFailures.push(error) })
    const configWarnings: string[] = []
    const configWarn = configured.logger.warn.bind(configured.logger)
    configured.logger.warn = ((...args: unknown[]) => {
      if (typeof args[0] === 'string') configWarnings.push(args[0])
      return (configWarn as (...a: unknown[]) => unknown)(...args)
    }) as typeof configured.logger.warn
    const loop = await configured.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId, provider: 'mock', model: 'mock' }],
    })
    await expect.poll(() => configFailures.length).toBe(1)
    expect(configFailures[0]).toBeInstanceOf(Error)
    expect((configFailures[0] as Error).message).toBe('artifact corrupt')
    expect(configWarnings.some(w => w.includes('config-driven restore'))).toBe(true)
    expect(configured.agents.get(sessionId)).toBeUndefined()

    await loop.dispose()
    await configured.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('suppresses a configured-resume failure that lands after teardown', async () => {
    const sessionId = SessionId('config-late-resume-failure')
    const root = await persistSession(sessionId)
    const ctx = await mountPersistentHarness(root, new MockAdapter([]))
    const gate = Promise.withResolvers<never>()
    gate.promise.catch(() => undefined)
    const preparationStarted = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.prepare = () => {
      preparationStarted.resolve(undefined)
      return gate.promise
    }
    const failures: unknown[] = []
    ctx.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })

    const configured = new Context()
    await configured.plugin(LlmRuntime)
    await configured.plugin(SessionStore)
    await configured.plugin(SessionProjectionRegistry)
    await configured.plugin(SystemPrompt)
    await configured.plugin(ToolRuntime)
    await configured.plugin(AgentRegistry)
    await configured.plugin(JsonlSessionPersistence, { root })
    configured.llm.registerAdapter(['mock'], new MockAdapter([]))
    configured.sessionPersistence.prepare = (id, signal) => ctx.sessionPersistence.prepare(id, signal)
    configured.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })
    const loop = await configured.plugin(AgentLoop, {
      agents: [{ id: 'main', resumeSessionId: sessionId, provider: 'mock', model: 'mock' }],
    })
    await preparationStarted.promise
    const disposal = loop.dispose()
    gate.reject(new Error('late backend failure'))
    await disposal
    await new Promise(r => setTimeout(r, 20))

    // Ownership deactivated before the failure landed: the report is dropped.
    expect(failures).toEqual([])
    await configured.fiber.dispose()
    await ctx.fiber.dispose()
  })
})
