import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'

import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop, { CONFIGURED_AGENT_IDENTITIES_KEY } from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function makeCoreContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** Read one stored session's physical validated log through a read handle. */
async function readStoredEvents(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

describe('config-driven session id', () => {
  it('applies launcher identities by configured id without changing unmatched entries', async () => {
    const ctx = await makeCoreContext()
    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, {
      fresh: { id: SessionId('launcher-fresh'), resume: false },
      resumed: { id: SessionId('launcher-resumed'), resume: true },
    })
    await ctx.plugin(AgentLoop, {
      agents: [
        { id: 'fresh', sessionId: SessionId('config-fresh'), model: 'mock' },
        { id: 'resumed', sessionId: SessionId('config-resumed'), model: 'mock' },
        { id: 'unchanged', sessionId: SessionId('config-unchanged'), model: 'mock' },
      ],
    })
    await expect.poll(() => ctx.agents.get(SessionId('launcher-fresh'))).toBeDefined()
    expect(ctx.agents.get(SessionId('launcher-fresh'))?.session.id).toBe('launcher-fresh')
    expect(ctx.agents.get(SessionId('launcher-resumed'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('config-resumed'))).toBeUndefined()
    await expect.poll(() => ctx.agents.get(SessionId('config-unchanged'))).toBeDefined()
    expect(ctx.agents.get(SessionId('config-unchanged'))?.session.id).toBe('config-unchanged')
    await ctx.fiber.dispose()
  })

  it('rejects an empty exact id before publishing an agent', async () => {
    const ctx = await makeCoreContext()
    await expect(ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId(''), model: 'mock' }],
    })).rejects.toThrow('expected string length >= 1')
    expect(ctx.agents.get(SessionId(''))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('accepts one exact fresh id and rejects it alongside a resume id', async () => {
    const exact = await makeCoreContext()
    await exact.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('config-exact'), model: 'mock' }],
    })
    await expect.poll(() => exact.agents.get(SessionId('config-exact'))).toBeDefined()
    expect(exact.agents.get(SessionId('config-exact'))?.session.id).toBe('config-exact')
    await exact.fiber.dispose()

    const conflicting = await makeCoreContext()
    await expect(conflicting.plugin(AgentLoop, {
      agents: [{
        id: 'main',
        sessionId: SessionId('fresh'),
        resumeSessionId: SessionId('persisted'),
        model: 'mock',
      }],
    })).rejects.toThrow('sessionId and resumeSessionId are mutually exclusive')
    await conflicting.fiber.dispose()
  })

  it('rejects duplicate exact ids before asynchronous configured startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-duplicate-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(JsonlSessionPersistence, { root })

    const outcome = await ctx.plugin(AgentLoop, {
      agents: [
        { id: 'first', sessionId: SessionId('shared'), model: 'mock' },
        { id: 'second', sessionId: SessionId('shared'), model: 'mock' },
      ],
    }).then(() => undefined, (error: unknown) => error)
    const published = ctx.agents.get(SessionId('shared'))
    await ctx.fiber.dispose()

    expect(outcome).toEqual(new Error('agents "first" and "second" use duplicate exact session identity "shared"'))
    expect(published).toBeUndefined()
  })

  it('restores a materialized exact id across an AgentLoop-only reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-reload-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(JsonlSessionPersistence, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first'), textResponse('second')]))
    const config = { agents: [{ id: 'main', sessionId: SessionId('config-exact-reload'), provider: 'mock', model: 'mock' }] }

    const firstLoop = await ctx.plugin(AgentLoop, config)
    await expect.poll(() => ctx.agents.get(SessionId('config-exact-reload')), { timeout: 5_000 }).toBeDefined()
    const first = ctx.agents.get(SessionId('config-exact-reload'))!
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'remember me' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first)
    await firstLoop.dispose()

    const secondLoop = await ctx.plugin(AgentLoop, config)
    await expect.poll(() => ctx.agents.get(SessionId('config-exact-reload')), { timeout: 5_000 }).toBeDefined()
    const second = ctx.agents.get(SessionId('config-exact-reload'))!
    expect(JSON.stringify(second.session.deriveMessages())).toContain('remember me')
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, second)
    await ctx.sessions.flush(second.session)
    const stored = await readStoredEvents(ctx, SessionId('config-exact-reload'))
    expect(stored.filter(event => event.type === 'turn/start')).toHaveLength(2)

    await secondLoop.dispose()
    await ctx.fiber.dispose()
  })

  it('waits for a draining exact-id lifecycle during an overlapping reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-overlap-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(JsonlSessionPersistence, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('saved')]))
    const sessionId = SessionId('config-exact-overlap')
    const config = { agents: [{ id: 'main', sessionId, provider: 'mock', model: 'mock' }] }
    const firstLoop = await ctx.plugin(AgentLoop, config)
    await expect.poll(() => ctx.agents.get(sessionId)).toBeDefined()
    const first = ctx.agents.get(sessionId) as Agent

    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    first.ctx.effect(() => async () => {
      cleanupStarted.resolve(undefined)
      await cleanupGate.promise
    })
    const idle = waitForIdle(ctx, first)
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'persist before replacement' }], source: { kind: 'user' } }))
    await idle
    await ctx.sessions.flush(first.session)
    expect(JSON.stringify(await readStoredEvents(ctx, sessionId)))
      .toContain('persist before replacement')

    const firstDisposal = firstLoop.dispose()
    await cleanupStarted.promise
    expect(first.status).toBe('idle')
    const failures: unknown[] = []
    ctx.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })
    const secondLoop = await ctx.plugin(AgentLoop, config)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.agents.get(sessionId)).toBe(first)
    expect(failures).toEqual([])

    cleanupGate.resolve(undefined)
    await firstDisposal
    await expect.poll(() => ctx.agents.get(sessionId)).toBeDefined()
    const second = ctx.agents.get(sessionId) as Agent
    expect(second).not.toBe(first)
    expect(JSON.stringify(second.session.deriveMessages())).toContain('persist before replacement')
    expect(failures).toEqual([])

    await secondLoop.dispose()
    await ctx.fiber.dispose()
  })

  it('cancels an exact-id reload while the prior lifecycle is still draining', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-cancel-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(JsonlSessionPersistence, { root })
    const sessionId = SessionId('config-exact-cancel')
    const config = { agents: [{ id: 'main', sessionId, model: 'mock' }] }
    const firstLoop = await ctx.plugin(AgentLoop, config)
    await expect.poll(() => ctx.agents.get(sessionId)).toBeDefined()
    const first = ctx.agents.get(sessionId) as Agent

    const cleanupGate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    first.ctx.effect(() => async () => {
      cleanupStarted.resolve(undefined)
      await cleanupGate.promise
    })
    first.inject(createUserMessage({ content: [{ type: 'text', text: 'persist before cancellation' }], source: { kind: 'plugin', plugin: 'test' } }))
    await ctx.sessions.flush(first.session)
    expect(JSON.stringify(await readStoredEvents(ctx, sessionId)))
      .toContain('persist before cancellation')

    const firstDisposal = firstLoop.dispose()
    await cleanupStarted.promise
    expect(first.status).toBe('idle')
    const secondLoop = await ctx.plugin(AgentLoop, config)
    await secondLoop.dispose()
    expect(ctx.agents.get(sessionId)).toBe(first)

    cleanupGate.resolve(undefined)
    await firstDisposal
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('contains a configured fresh-create failure without persistence', async () => {
    const ctx = await makeCoreContext()
    const failures: unknown[] = []
    ctx.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    // A relative cwd fails session preparation inside the plain create path
    // (no backend mounted): the failure is reported, not crashed on.
    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', model: 'mock', cwd: 'relative' }],
    })

    await expect.poll(() => failures.length).toBe(1)
    expect(failures[0]).toBeInstanceOf(Error)
    expect((failures[0] as Error).message).toMatch(/absolute path/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config-driven restore'))
    expect(ctx.agents.list()).toEqual([])
    warn.mockRestore()
    await ctx.fiber.dispose()
  })

  it('contains an exact-id persistence open failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-failure-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(JsonlSessionPersistence, { root })
    const failure = new Error('persistence index failed')
    const listenerFailure = new Error('failure observer failed')
    const asyncListenerFailure = new Error('async failure observer failed')
    const failures: { sessionId: SessionId; error: unknown }[] = []
    ctx.on('agent-loop/config-start-failed', () => { throw listenerFailure })
    ctx.on('agent-loop/config-start-failed', () => Promise.reject(asyncListenerFailure) as never)
    ctx.on('agent-loop/config-start-failed', ({ sessionId, error }) => {
      failures.push({ sessionId, error })
    })
    vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValue(failure)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('config-exact-failure'), model: 'mock' }],
    })

    await expect.poll(() => warn).toHaveBeenCalledWith(expect.stringContaining(
      'config-driven restore of "config-exact-failure" failed: persistence index failed',
    ))
    expect(failures).toEqual([{ sessionId: SessionId('config-exact-failure'), error: failure }])
    expect(warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener threw: failure observer failed',
    )
    await expect.poll(() => warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener rejected: async failure observer failed',
    )
    expect(ctx.agents.get(SessionId('config-exact-failure'))).toBeUndefined()
    warn.mockRestore()
    await ctx.fiber.dispose()
  })

  it('contains startup and observer failures whose string coercion throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-unrenderable-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(JsonlSessionPersistence, { root })
    const unrenderable = {
      [Symbol.toPrimitive](): never {
        throw new Error('coercion escaped')
      },
    }
    const failures: unknown[] = []
    ctx.on('agent-loop/config-start-failed', () => { throw unrenderable })
    // Deliberately violate the normal Error-only rejection rule to exercise the unknown boundary.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    ctx.on('agent-loop/config-start-failed', () => Promise.reject(unrenderable) as never)
    ctx.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })
    vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValue(unrenderable)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('config-exact-unrenderable'), model: 'mock' }],
    })

    await expect.poll(() => failures).toEqual([unrenderable])
    expect(warn).toHaveBeenCalledWith(
      'agent "main": config-driven restore of "config-exact-unrenderable" failed: <unrenderable value>',
    )
    expect(warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener threw: <unrenderable value>',
    )
    await expect.poll(() => warn).toHaveBeenCalledWith(
      'agent "main": config-start-failed listener rejected: <unrenderable value>',
    )
    await ctx.fiber.dispose()
  })

  it.each(['resolve', 'reject'] as const)(
    'abandons an exact-id open that later %ss when AgentLoop disposal starts',
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-exact-dispose-'))
      dirs.push(root)
      const ctx = await makeCoreContext()
      await ctx.plugin(JsonlSessionPersistence, { root })
      const opening = Promise.withResolvers<SessionHandle>()
      vi.spyOn(ctx.sessionPersistence, 'open').mockReturnValue(opening.promise)
      const closed = vi.fn(async () => {})
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      const failures: unknown[] = []
      ctx.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })

      const loop = await ctx.plugin(AgentLoop, {
        agents: [{ id: 'main', sessionId: SessionId('config-exact-dispose'), model: 'mock' }],
      })
      await loop.dispose()
      if (outcome === 'resolve') {
        opening.resolve({ close: closed } as unknown as SessionHandle)
      } else {
        opening.reject(new Error('startup cancelled by teardown'))
      }
      await Promise.resolve()
      // The abandoned handle is closed; the rejected open is silently released.
      if (outcome === 'resolve') await expect.poll(() => closed).toHaveBeenCalledOnce()
      expect(ctx.agents.get(SessionId('config-exact-dispose'))).toBeUndefined()
      expect(failures).toEqual([])
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
      await ctx.fiber.dispose()
    },
  )

  it('identity-nests the deferred resume fiber under its labeled owner effect', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(AgentLoop, {
      agents: [{ id: SessionId('main'), provider: 'mock', model: 'mock', resumeSessionId: SessionId('deferred') }],
    })

    const resumeEffect = loopFiber.getEffects().find(effect => effect.label === 'agentLoop.resume(main)')
    expect(resumeEffect?.children.map(child => child.label)).toEqual(['ctx.plugin()'])
    // Exactly one plugin effect sits at the fiber's own level — the optional
    // settings wiring, whose `ctx.inject` cordis labels like any other plugin.
    // A resumed agent joining it there is the regression this pins.
    expect(loopFiber.getEffects().filter(effect => effect.label === 'ctx.plugin()')).toHaveLength(1)

    await loopFiber.dispose()
  })

  it('config-driven create uses a fresh ${id}-session-<uuid> per run (restart-safe)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-session-'))
    dirs.push(root)
    const idPattern = /^cfg-session-[0-9a-f-]{36}$/
    // Run 1: a config agent persists a turn under a generated session id.
    const ctx1 = new Context()
    await ctx1.plugin(LlmRuntime)
    await ctx1.plugin(SessionStore)
    await ctx1.plugin(SessionProjectionRegistry)
    await ctx1.plugin(SystemPrompt)
    await ctx1.plugin(ToolRuntime)
    await ctx1.plugin(AgentRegistry)
    await ctx1.plugin(JsonlSessionPersistence, { root })
    await ctx1.plugin(AgentLoop, { agents: [{ id: SessionId('cfg'), provider: 'mock', model: 'mock' }] })
    ctx1.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg')]))
    await expect.poll(() => ctx1.agents.list().length).toBe(1)
    const a1 = ctx1.agents.list()[0] as Agent
    expect(a1.id).toBe(a1.session.id)
    expect(a1.session.id).toMatch(idPattern)
    expect(ctx1.agents.get(SessionId('cfg'))).toBeUndefined()
    a1.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, a1)
    await ctx1.sessions.flush(a1.session)
    expect(JSON.stringify(await readStoredEvents(ctx1, a1.session.id))).toContain('cfg')
    await ctx1.fiber.dispose()

    // Run 2 over the SAME root: a fresh id means no on-disk collision (a fixed
    // ${id}-session would crash here with "already exists").
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(JsonlSessionPersistence, { root })
    await ctx2.plugin(AgentLoop, { agents: [{ id: SessionId('cfg'), provider: 'mock', model: 'mock' }] })
    ctx2.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg2')]))
    await expect.poll(() => ctx2.agents.list().length).toBe(1)
    const a2 = ctx2.agents.list()[0] as Agent
    expect(a2.id).toBe(a2.session.id)
    expect(a2.session.id).toMatch(idPattern)
    expect(a2.session.id).not.toBe(a1.session.id)
    a2.followup(createUserMessage({ content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } }))
    await waitForIdle(ctx2, a2)
    await ctx2.fiber.dispose()
  })

  it('config-driven resumeSessionId continues a persisted session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-resume-'))
    dirs.push(root)

    // Run 1: a programmatically-created agent on a KNOWN session id persists a
    // completed turn, so run 2 has a concrete id to resume.
    const ctx1 = new Context()
    await ctx1.plugin(LlmRuntime)
    await ctx1.plugin(SessionStore)
    await ctx1.plugin(SessionProjectionRegistry)
    await ctx1.plugin(SystemPrompt)
    await ctx1.plugin(ToolRuntime)
    await ctx1.plugin(AgentRegistry)
    await ctx1.plugin(JsonlSessionPersistence, { root })
    await ctx1.plugin(AgentLoop, { agents: [] })
    ctx1.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first')]))
    const h1 = await ctx1.agents.create({ sessionId: SessionId('sticky-1') })
    h1.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'remember me' }], source: { kind: 'user' } }))
    await waitForIdle(ctx1, h1.agent)
    await h1.dispose()
    await ctx1.fiber.dispose()

    // Resume waits for the injected persistence service, so poll until the
    // config-created agent appears with its stored history.
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [{ id: SessionId('main'), provider: 'mock', model: 'mock', resumeSessionId: SessionId('sticky-1') }] })
    await ctx2.plugin(JsonlSessionPersistence, { root })
    ctx2.llm.registerAdapter(['mock'], new MockAdapter([textResponse('second')]))

    // The deferred resume runs after the backend is available.
    await expect.poll(() => ctx2.agents.get(SessionId('sticky-1')), { timeout: 5_000 }).toBeDefined()
    const resumed = ctx2.agents.get(SessionId('sticky-1'))!
    // The live session id IS the resumed id (NOT a fresh ${id}-session-<uuid>),
    // and the prior turn's user message is in the derived history.
    expect(resumed.id).toBe(SessionId('sticky-1'))
    expect(resumed.session.id).toBe('sticky-1')
    const derived = resumed.session.deriveMessages()
    expect(JSON.stringify(derived)).toContain('remember me')
    await ctx2.fiber.dispose()
  })

  it('config-driven resume of a missing session is contained: logs a warning, no agent, no crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-resume-miss-'))
    dirs.push(root)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [{ id: SessionId('main'), provider: 'mock', model: 'mock', resumeSessionId: SessionId('does-not-exist') }] })
    const warn = vi.spyOn((ctx.agentLoop as unknown as { ctx: { logger: { warn: (...a: unknown[]) => void } } }).ctx.logger, 'warn')
      .mockImplementation(() => undefined)
    await ctx.plugin(JsonlSessionPersistence, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('x')]))

    // The deferred resume fails (no such session on disk). It must be contained:
    // a warning is logged, no agent is registered, and the app stays up.
    await expect.poll(() => warn.mock.calls.some(call =>
      typeof call[0] === 'string' && call[0].includes('config-driven resume of "does-not-exist" failed'),
    )).toBe(true)
    expect(ctx.agents.list()).toEqual([])
    warn.mockRestore()
    await ctx.fiber.dispose()
  })
})

describe('startup reporting after factory teardown', () => {
  it('suppresses the configured-restore failure report once the loop is disposed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-disposed-report-'))
    dirs.push(root)
    const ctx = await makeCoreContext()
    await ctx.plugin(JsonlSessionPersistence, { root })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('x')]))

    // A restore open that hangs until after the loop is gone: the eventual
    // failure lands with ownership inactive and must be silently dropped.
    const gate = Promise.withResolvers<SessionHandle>()
    // The teardown path may drop the pending open without awaiting it.
    gate.promise.catch(() => undefined)
    vi.spyOn(ctx.sessionPersistence, 'open').mockReturnValue(gate.promise)
    const failures: unknown[] = []
    ctx.on('agent-loop/config-start-failed', ({ error }) => { failures.push(error) })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    const loop = await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('config-disposed-report'), model: 'mock' }],
    })
    const disposal = loop.dispose()
    gate.reject(new Error('backend failed after teardown began'))
    await disposal

    await new Promise(r => setTimeout(r, 20))
    expect(failures).toEqual([])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('config-driven restore'))
    warn.mockRestore()
    await ctx.fiber.dispose()
  })
})
