import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context, symbols, type EffectMeta, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'

import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harnessWithLoop(adapter: MockAdapter = new MockAdapter([textResponse('ok')])): Promise<{ ctx: Context; loopFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, loopFiber }
}

async function harness(adapter: MockAdapter = new MockAdapter([textResponse('ok')])): Promise<Context> {
  return (await harnessWithLoop(adapter)).ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }]

/** Throw an arbitrary callback value to exercise the public unknown-error boundary. */
function throwUnknown(value: unknown): never {
  throw value
}

/** Invoke the exact lifecycle effect to exercise same-stack reentrant teardown. */
function disposeCurrentLifecycle(ownerCtx: Context): void {
  const lifecycle = [...ownerCtx.fiber._disposables]
    .find((dispose) => {
      const effect = (dispose as typeof dispose & { [symbols.effect]?: EffectMeta })[symbols.effect]
      return effect?.label.startsWith('agentLoop.lifecycle(') === true
    })
  if (lifecycle === undefined) throw new Error('agent lifecycle effect not found')
  void lifecycle()
}

describe('agent scope lifecycle', () => {
  it('rejects an already-aborted creation signal before publishing either object', async () => {
    const ctx = await harness()
    const reason = new Error('cancelled before creation')
    const controller = new AbortController()
    controller.abort(reason)

    await expect(ctx.agents.create({
      sessionId: SessionId('pre-aborted-s'),
      signal: controller.signal,
    })).rejects.toBe(reason)

    expect(ctx.agents.get(SessionId('pre-aborted-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('pre-aborted-s'))).toBeUndefined()

    const valueController = new AbortController()
    valueController.abort('plain cancellation reason')
    await expect(ctx.agents.create({
      sessionId: SessionId('pre-aborted-value-s'),
      signal: valueController.signal,
    })).rejects.toMatchObject({
      message: 'agent "pre-aborted-value-s" creation aborted',
      cause: 'plain cancellation reason',
    })

    expect(ctx.agents.get(SessionId('pre-aborted-value-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('pre-aborted-value-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('joins cleanup when an abort lands reentrantly during scope preparation', async () => {
    const ctx = await harness()
    const reason = new Error('cancelled while preparing')
    const controller = new AbortController()
    let aborted = false
    ctx.on('internal/plugin', (fiber) => {
      if (aborted || fiber.name !== 'scope') return
      aborted = true
      controller.abort(reason)
    })

    await expect(ctx.agents.create({
      sessionId: SessionId('prepare-abort-s'),
      signal: controller.signal,
    })).rejects.toBe(reason)

    expect(ctx.agents.get(SessionId('prepare-abort-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('prepare-abort-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('normalizes non-Error create failures for rollback while rethrowing the original value', async () => {
    const ctx = await harness()
    let thrown: unknown
    ctx.on('session/created', () => {
      if (thrown === undefined) return
      const value = thrown
      thrown = undefined
      throwUnknown(value)
    })

    const createFailure = { source: 'create' }
    thrown = createFailure
    let createCaught: unknown
    try {
      await ctx.agentLoop.create(SessionId('unknown-create'))
    } catch (error: unknown) {
      createCaught = error
    }
    expect(createCaught).toBe(createFailure)

    const ownedFailure = { source: 'createAgent' }
    thrown = ownedFailure
    await expect(ctx.agents.create({
      sessionId: SessionId('unknown-owned-create-s'),
    })).rejects.toBe(ownedFailure)

    expect(ctx.agents.get(SessionId('unknown-create'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('unknown-owned-create-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('wires agent.ctx: tagged with the agent, DX field set, ctx.agent safe elsewhere', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    expect(scopeOf(agent.ctx)).toBe(agent)
    expect(agent.ctx.agent).toBe(agent)
    // The root accessor default: a plain context answers undefined, not a throw.
    expect(ctx.agent).toBeUndefined()
    await agent.whenIdle()
  })

  it('records agents created through an agent context as non-root runtime children', async () => {
    const ctx = await harness()
    const root = await ctx.agents.create({
      sessionId: SessionId('runtime-root'),
      agentOptions: { model: 'mock' },
    })
    const child = await root.agent.ctx.agents.create({
      sessionId: SessionId('runtime-child'),
      agentOptions: { model: 'mock' },
    })

    expect(ctx.agents.list()).toEqual([root.agent, child.agent])
    expect(ctx.agents.roots()).toEqual([root.agent])

    await child.dispose()
    await root.dispose()
  })

  it('scoped registrations live in the agent world and die with the agent', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({ sessionId: SessionId('s1'), agentOptions: { provider: 'mock', model: 'mock' } })
    const { agent } = handle
    agent.ctx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: 'You run tests.' })
    agent.ctx.tools.register(defineContentToolFixture({
      name: 'mine', description: 'scoped', parameters: {},
      execute: () => Promise.resolve(text('ran')),
    }))

    const scopedAssembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(scopedAssembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You run tests.')
    expect(scopedAssembly.tools.map(t => t.name)).toContain('mine')
    // Other assemblies are untouched.
    const globalAssembly = await ctx.systemPrompt.assemble()
    expect(globalAssembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You are the deployment.')
    expect(globalAssembly.tools.map(t => t.name)).not.toContain('mine')

    await handle.dispose()
    // The scoped world unwound with the agent: nothing leaked into the registries.
    expect(ctx.tools.get('mine', agent)).toBeUndefined()
    const after = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(after.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You are the deployment.')
  })

  it('agent.ctx listeners hear only their own agent (scoped dispatch end to end)', async () => {
    const ctx = await harness(new MockAdapter([textResponse('one'), textResponse('two')]))
    const a = await ctx.agentLoop.create(SessionId('a'), { provider: 'mock', model: 'mock' })
    const b = await ctx.agentLoop.create(SessionId('b'), { provider: 'mock', model: 'mock' })

    const heard: string[] = []
    a.ctx.on('agent/status', ({ agent: subject, status }) => void heard.push(`a-sees:${subject.id}:${status}`))
    a.ctx.on('session/event', (_s, event) => {
      if (event.type === 'user/message') heard.push('a-sees:user-message')
    })

    b.followup(createUserMessage({ content: text('for b'), source: { kind: 'user' } }))
    await waitForIdle(ctx, b)
    expect(heard).toEqual([]) // nothing of b's leaked into a's scope

    a.followup(createUserMessage({ content: text('for a'), source: { kind: 'user' } }))
    await waitForIdle(ctx, a)
    expect(heard).toContain('a-sees:a:running')
    expect(heard).toContain('a-sees:user-message')
  })

  it('runs setup in the guaranteed slot: scoped world complete before session-start and the first assembly', async () => {
    const ctx = await harness()
    const order: string[] = []
    ctx.on('agent/session-start', ({ agent }) => {
      order.push('session-start')
      // The scoped section is already registered by the time session-start fires.
      void ctx.systemPrompt.assemble(assembleContextFor(agent)).then((assembly) => {
        order.push(`persona:${assembly.sections.find(s => s.name === 'deployment:persona')?.text}`)
      })
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('child-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx) => {
        order.push('setup')
        await Promise.resolve()
        agentCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: 'You are the child.' })
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['setup', 'session-start', 'persona:You are the child.'])
    await handle.dispose()
  })

  it('keeps both objects unpublished until async setup completes, then announces in order', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/created', (session) => {
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(ctx.agents.get(session.id)?.session).toBe(session)
      order.push('session/created')
    })
    ctx.on('agent/created', () => void order.push('agent/created'))
    ctx.on('agent/session-start', () => void order.push('agent/session-start'))
    const acceptedOptions = { provider: 'mock', model: 'mock' }

    const creating = ctx.agents.create({
      sessionId: SessionId('atomic'),
      agentOptions: acceptedOptions,
      setup: async (agentCtx) => {
        expect(agentCtx.agent?.id).toBe(SessionId('atomic'))
        agentCtx.on('session/created', () => void order.push('setup-listener:session/created'))
        agentCtx.on('agent/created', () => void order.push('setup-listener:agent/created'))
        order.push('setup:start')
        setupStarted.resolve(undefined)
        await gate.promise
        order.push('setup:end')
        return {
          commit: () => {
            expect(ctx.agents.get(SessionId('atomic'))).toBeUndefined()
            expect(ctx.sessions.get(SessionId('atomic'))).toBeUndefined()
            order.push('setup:commit')
          },
        }
      },
    })
    await setupStarted.promise
    expect(ctx.agents.get(SessionId('atomic'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('atomic'))).toBeUndefined()
    expect(order).toEqual(['setup:start'])
    gate.resolve(undefined)
    const handle = await creating
    expect(handle.agent.options).toBe(acceptedOptions)
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
  })

  it('lets the final enter arbitrate unsupported concurrent same-id creation and rolls the loser back', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const bothStarted = Promise.withResolvers<undefined>()
    let started = 0
    const setup = async (): Promise<void> => {
      started += 1
      if (started === 2) bothStarted.resolve(undefined)
      await gate.promise
    }
    const sessionId = SessionId('concurrent-final-enter')
    const first = ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup,
    })
    const second = ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup,
    })
    await bothStarted.promise
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])

    gate.resolve(undefined)
    const outcomes = await Promise.allSettled([first, second])
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<typeof first>> => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.reason)).toMatch(/already exists/)
    expect(ctx.agents.list()).toEqual([fulfilled[0]!.value.agent])
    expect(ctx.sessions.list()).toEqual([fulfilled[0]!.value.agent.session])

    await fulfilled[0]!.value.dispose()
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])
  })

  it('uses signal only for creation: aborts pending setup but not a returned live handle', async () => {
    const ctx = await harness()
    const pendingController = new AbortController()
    const setupStarted = Promise.withResolvers<undefined>()
    const pending = ctx.agents.create({
      sessionId: SessionId('signal-pending-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: pendingController.signal,
      setup: async () => {
        setupStarted.resolve(undefined)
        await new Promise<never>(() => {})
      },
    })
    await setupStarted.promise
    pendingController.abort(new Error('cancel pending creation'))
    await expect(pending).rejects.toThrow('cancel pending creation')
    expect(ctx.agents.get(SessionId('signal-pending-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('signal-pending-s'))).toBeUndefined()

    const liveController = new AbortController()
    const live = await ctx.agents.create({
      sessionId: SessionId('signal-live-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: liveController.signal,
    })
    liveController.abort(new Error('too late'))
    await Promise.resolve()
    expect(ctx.agents.get(live.agent.id)).toBe(live.agent)
    expect(live.agent.status).toBe('idle')
    await live.dispose()
  })

  it('owner unload aborts a pending setup and publishes nothing', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    let creating!: ReturnType<typeof ctx.agents.create>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      creating = inner.agents.create({
        sessionId: SessionId('owner-race-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async () => {
          setupStarted.resolve(undefined)
          await gate.promise
        },
      })
    }, { inject: ['agents'] }))
    await setupStarted.promise

    await owner.dispose()
    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    expect(published).toEqual([])
    expect(ctx.agents.get(SessionId('owner-race-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('owner-race-s'))).toBeUndefined()
    // Let the losing callback settle; Promise.race already observes it.
    gate.resolve(undefined)
    await Promise.resolve()

    // The other ordering in the same race: setup resolves first (its reaction
    // is queued), then owner disposal flips active before that continuation can
    // publish. The post-race active check must still reject.
    const gate2 = Promise.withResolvers<undefined>()
    const setupStarted2 = Promise.withResolvers<undefined>()
    let creating2!: ReturnType<typeof ctx.agents.create>
    const owner2 = await ctx.plugin(Object.assign((inner: Context) => {
      creating2 = inner.agents.create({
        sessionId: SessionId('owner-race-s-2'),
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async () => {
          setupStarted2.resolve(undefined)
          await gate2.promise
        },
      })
    }, { inject: ['agents'] }))
    await setupStarted2.promise
    gate2.resolve(undefined)
    const unload2 = owner2.dispose()
    await expect(creating2).rejects.toThrow(/owner disposed during setup/)
    await unload2
    expect(ctx.agents.get(SessionId('owner-race-s-2'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('owner-race-s-2'))).toBeUndefined()
  })

  it('an AgentLoop unload aborts pending setup, awaits cleanup, and releases both ids', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    const creating = ctx.agents.create({
      sessionId: SessionId('factory-setup-race-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {
        setupStarted.resolve(undefined)
        await gate.promise
      },
    })
    await setupStarted.promise

    await loopFiber.dispose()
    await expect(creating).rejects.toThrow(/agent loop is not active/)
    expect(published).toEqual([])
    expect(ctx.agents.get(SessionId('factory-setup-race-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-setup-race-s'))).toBeUndefined()

    gate.resolve(undefined)
    await ctx.fiber.dispose()
  })

  it('factory unload during scope minting skips setup and awaits provisional cleanup', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    let unloaded = false
    let setupCalls = 0
    ctx.on('internal/plugin', (fiber) => {
      if (unloaded || fiber.name !== 'scope') return
      unloaded = true
      void loopFiber.dispose()
    })

    const creating = ctx.agents.create({
      sessionId: SessionId('factory-scope-race-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: () => { setupCalls += 1 },
    })
    await expect(creating).rejects.toThrow(/agent loop is not active/)
    await loopFiber.dispose()
    expect(setupCalls).toBe(1)
    expect(ctx.agents.get(SessionId('factory-scope-race-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-scope-race-s'))).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('caller unload during scope minting owns and drains the half-built child', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let ownerFiber!: Fiber
    let ownerDisposal!: Promise<void>
    let scopeFiber: Fiber | undefined
    let creating!: ReturnType<typeof ctx.agents.create>
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'scope' || scopeFiber !== undefined) return
      scopeFiber = fiber
      fiber.ctx.effect(() => async () => {
        cleanupStarted.resolve(undefined)
        await gate.promise
      })
      ownerDisposal = ownerFiber.dispose()
    })

    const owner = ctx.plugin(Object.assign((inner: Context) => {
      ownerFiber = inner.fiber
      creating = inner.agents.create({
        sessionId: SessionId('caller-scope-race-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await cleanupStarted.promise
    let ownerSettled = false
    void ownerDisposal.then(() => { ownerSettled = true })
    await Promise.resolve()
    expect(ownerSettled).toBe(false)
    gate.resolve(undefined)
    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    await ownerDisposal
    await owner
    expect(scopeFiber?.uid).toBeNull()
    expect(ctx.agents.get(SessionId('caller-scope-race-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('caller-scope-race-s'))).toBeUndefined()
    await owner.dispose()
    await ctx.fiber.dispose()
  })

  it('create rechecks provider liveness before its first publication edge', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    const sessionsBefore = ctx.sessions.list().length
    let unloaded = false
    let unloading!: Promise<void>
    ctx.on('internal/plugin', (fiber) => {
      if (unloaded || fiber.name !== 'scope') return
      unloaded = true
      unloading = loopFiber.dispose()
    })

    // The mid-setup unload races publication: create either rejects or its
    // published agent is torn straight back down — both leave no state.
    await ctx.agentLoop.create(SessionId('config-scope-race'), { provider: 'mock', model: 'mock' })
      .then(() => undefined, () => undefined)
    await unloading
    expect(ctx.agents.get(SessionId('config-scope-race')) === undefined).toBe(true)
    expect(ctx.sessions.list().length).toBe(sessionsBefore)
    await ctx.fiber.dispose()
  })

  it('create leaves no lifecycle state when session preparation fails', async () => {
    const ctx = await harness()
    const id = SessionId('config-prepare-failure')

    await expect(ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' }, { cwd: 'relative' }))
      .rejects.toThrow(/absolute path/)
    const replacement = await ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' }, { cwd: '/recovered' })
    expect(ctx.agents.get(id)).toBe(replacement)
    await replacement.whenIdle()
    await ctx.fiber.dispose()
  })

  it('factory unload awaits provisional cleanup when scope preparation throws', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    let triggered = false
    ctx.on('internal/plugin', (fiber) => {
      if (triggered || fiber.name !== 'scope') return
      triggered = true
      void loopFiber.dispose()
      throw new Error('scope preparation failed')
    })

    await expect(ctx.agents.create({
      sessionId: SessionId('factory-scope-throw-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toThrow('scope preparation failed')
    await loopFiber.dispose()
    expect(ctx.agents.get(SessionId('factory-scope-throw-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-scope-throw-s'))).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('AgentLoop unload is a structural co-owner of every live programmatic agent', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    const loop = ctx.agentLoop
    const sessionId = SessionId('factory-live')
    const handle = await ctx.agents.create({
      sessionId: SessionId('factory-live-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    await loopFiber.dispose()
    expect(handle.agent.status).toBe('idle')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(ctx.fiber.getEffects().filter(effect => effect.label === `agentLoop.lifecycle(${sessionId})`)).toEqual([])
    // The consumer handle shares the provider's completed quiescence boundary.
    await handle.dispose()

    await expect(loop.createAgent(ctx, {
      sessionId: SessionId('factory-inactive-s'),
    })).rejects.toThrow(/agent loop is not active|inactive context/)
    await ctx.fiber.dispose()
  })

  it('keeps AgentLoop dependencies available when the caller injects only agents', async () => {
    const ctx = await harness()
    let creating!: ReturnType<typeof ctx.agents.create>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      creating = inner.agents.create({
        sessionId: SessionId('dependency-origin-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: (agentCtx) => {
          agentCtx.tools.register(defineContentToolFixture({
            name: 'dependency-origin-tool',
            description: 'proves AgentLoop dependency origin',
            parameters: {},
            execute: () => Promise.resolve(text('ok')),
          }))
          agentCtx.systemPrompt.section({
            name: 'dependency-origin-section',
            order: 1,
            text: 'factory dependency API',
          })
        },
      })
    }, { inject: ['agents'] }))

    const handle = await creating
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(assembly.tools.map(tool => tool.name)).toContain('dependency-origin-tool')
    expect(assembly.sections.map(section => section.name)).toContain('dependency-origin-section')
    await handle.dispose()
    await owner.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps both entries and the scope live through a reentrant session/created teardown', async () => {
    const ctx = await harness()
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    const lifecycle: string[] = []
    ctx.on('session/created', (session) => {
      if (session.id !== SessionId('session-created-barrier-s')) return
      lifecycle.push('session-created:dispose')
      disposeCurrentLifecycle(ownerCtx)
    })
    ctx.on('session/created', (session) => {
      if (session.id !== SessionId('session-created-barrier-s')) return
      const agent = ctx.agents.get(SessionId('session-created-barrier-s'))!
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(agent.session).toBe(session)
      agent.ctx.effect(() => () => { lifecycle.push('scope-disposed') })
      lifecycle.push('session-created:observer')
    })
    ctx.on('agent/created', () => void lifecycle.push('agent-created'))
    ctx.on('agent/disposed', () => void lifecycle.push('agent-disposed'))
    ctx.on('session/disposed', (session) => {
      if (session.id === SessionId('session-created-barrier-s')) lifecycle.push('session-disposed')
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        sessionId: SessionId('session-created-barrier-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    await owner.dispose()
    expect(lifecycle).toEqual([
      'session-created:dispose',
      'session-created:observer',
      'scope-disposed',
      'session-disposed',
    ])
    expect(ctx.agents.get(SessionId('session-created-barrier-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('session-created-barrier-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps both entries and the scope live through a reentrant agent/created teardown', async () => {
    const ctx = await harness()
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    const lifecycle: string[] = []
    ctx.on('session/created', (session) => {
      if (session.id === SessionId('agent-created-barrier-s')) lifecycle.push('session-created')
    })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== SessionId('agent-created-barrier-s')) return
      lifecycle.push('agent-created:dispose')
      disposeCurrentLifecycle(ownerCtx)
    })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== SessionId('agent-created-barrier-s')) return
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(ctx.sessions.get(agent.session.id)).toBe(agent.session)
      agent.ctx.effect(() => () => { lifecycle.push('scope-disposed') })
      lifecycle.push('agent-created:observer')
    })
    ctx.on('agent/disposed', ({ agent }) => {
      if (agent.id === SessionId('agent-created-barrier-s')) lifecycle.push('agent-disposed')
    })
    ctx.on('session/disposed', (session) => {
      if (session.id === SessionId('agent-created-barrier-s')) lifecycle.push('session-disposed')
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        sessionId: SessionId('agent-created-barrier-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    await owner.dispose()
    expect(lifecycle).toEqual([
      'session-created',
      'agent-created:dispose',
      'agent-created:observer',
      'scope-disposed',
      'agent-disposed',
      'session-disposed',
    ])
    expect(ctx.agents.get(SessionId('agent-created-barrier-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('agent-created-barrier-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rechecks caller liveness after creation listeners before unlocking the driver', async () => {
    const ctx = await harness()
    const starts: string[] = []
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    ctx.on('agent/session-start', ({ agent }) => void starts.push(agent.id))
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id === SessionId('listener-dispose-s')) disposeCurrentLifecycle(ownerCtx)
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        sessionId: SessionId('listener-dispose-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    await owner.dispose()
    expect(starts).toEqual([])
    expect(ctx.agents.get(SessionId('listener-dispose-s')) === undefined).toBe(true)
    expect(ctx.sessions.get(SessionId('listener-dispose-s')) === undefined).toBe(true)
    await ctx.fiber.dispose()
  })

  it('rechecks caller liveness after session-start before starting the driver', async () => {
    const ctx = await harness()
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    let announced!: Agent
    const statuses: string[] = []
    let scopeDisposed = false
    let observerSawLive = false
    ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id === SessionId('session-start-dispose-s')) statuses.push(status)
    })
    ctx.on('agent/session-start', ({ agent }) => {
      if (agent.id !== SessionId('session-start-dispose-s')) return
      announced = agent
      disposeCurrentLifecycle(ownerCtx)
    })
    ctx.on('agent/session-start', ({ agent }) => {
      if (agent.id !== SessionId('session-start-dispose-s')) return
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(ctx.sessions.get(agent.session.id)).toBe(agent.session)
      agent.ctx.effect(() => () => { scopeDisposed = true })
      observerSawLive = true
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        sessionId: SessionId('session-start-dispose-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    await owner.dispose()
    expect(announced.status).toBe('idle')
    expect(statuses).toEqual([])
    expect(observerSawLive).toBe(true)
    expect(scopeDisposed).toBe(true)
    expect(announced.session.snapshotEvents()).toEqual([])
    expect(ctx.agents.get(SessionId('session-start-dispose-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('session-start-dispose-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('a rejecting setup publishes nothing and unwinds the unpublished scope', async () => {
    const ctx = await harness()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))
    await expect(ctx.agents.create({
      sessionId: SessionId('bad-s'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {
        await Promise.resolve()
        throw new Error('boom setup')
      },
    })).rejects.toThrow('boom setup')

    // Nothing leaked: no agent, no session, and the ids are reusable.
    expect(published).toEqual([])
    expect(ctx.agents.get(SessionId('bad-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('bad-s'))).toBeUndefined()
    const retry = await ctx.agents.create({ sessionId: SessionId('bad-s'), agentOptions: { provider: 'mock', model: 'mock' } })
    await retry.dispose()
  })

  it('rejects an exotic durable seed before publishing either object', async () => {
    const ctx = await harness()
    const published: string[] = []
    ctx.on('session/created', () => { published.push('session') })
    ctx.on('agent/created', () => { published.push('agent') })
    class ExoticData { readonly value = 'not durable JSON' }
    const seed = [{
      seq: 0,
      type: 'test/exotic-seed',
      data: new ExoticData(),
    }] as unknown as SessionEvent[]

    await expect(ctx.agents.create({
      sessionId: SessionId('exotic-seed-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
      seed,
    })).rejects.toThrow(/seed event at index 0 is not losslessly JSON-serializable/)

    expect(published).toEqual([])
    expect(ctx.agents.get(SessionId('exotic-seed-session'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('exotic-seed-session'))).toBeUndefined()
    const retry = await ctx.agents.create({
      sessionId: SessionId('exotic-seed-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await retry.dispose()
  })

  it('a throwing session/created listener disposes the scope (pre-nesting rollback window)', async () => {
    const ctx = await harness()
    let boom = true
    const disposed: string[] = []
    ctx.on('agent/disposed', ({ agent }) => void disposed.push(agent.id))
    ctx.on('session/created', () => {
      if (boom) { boom = false; throw new Error('boom created') }
    })
    await expect(ctx.agents.create({
      sessionId: SessionId('bad-s'), agentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toThrow('boom created')
    expect(ctx.agents.get(SessionId('bad-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('bad-s'))).toBeUndefined()
    expect(disposed).toEqual([]) // inserted but never announced: no impossible disposed edge
    // The rollback also disposed the scope fiber: re-creating works cleanly.
    const retry = await ctx.agents.create({ sessionId: SessionId('bad-s'), agentOptions: { provider: 'mock', model: 'mock' } })
    expect(scopeOf(retry.agent.ctx)).toBe(retry.agent)
    await retry.dispose()
  })

  it('pairs session and agent announcements when agent creation aborts publication', async () => {
    const ctx = await harness()
    const lifecycle: string[] = []
    ctx.on('session/created', (session) => { lifecycle.push(`session-created:${session.id}`) })
    ctx.on('session/disposed', (session) => { lifecycle.push(`session-disposed:${session.id}`) })
    ctx.on('agent/created', ({ agent }) => {
      lifecycle.push(`agent-created:${agent.id}`)
      throw new Error('agent observer failed')
    })
    ctx.on('agent/disposed', ({ agent }) => { lifecycle.push(`agent-disposed:${agent.id}`) })

    await expect(ctx.agents.create({
      sessionId: SessionId('partial-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toThrow('agent observer failed')

    expect(lifecycle).toEqual([
      'session-created:partial-session',
      'agent-created:partial-session',
      'agent-disposed:partial-session',
      'session-disposed:partial-session',
    ])
    expect(ctx.agents.get(SessionId('partial-session'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('partial-session'))).toBeUndefined()
  })

  it('the config create helper rolls back when publication throws', async () => {
    const ctx = await harness()
    const sessionsBefore = ctx.sessions.list().length
    let boom = true
    ctx.on('session/created', () => {
      if (boom) {
        boom = false
        throw new Error('config publish failed')
      }
    })

    await expect(ctx.agentLoop.create(SessionId('config-bad'), { provider: 'mock', model: 'mock' }))
      .rejects.toThrow('config publish failed')
    await expect.poll(() => ctx.agents.get(SessionId('config-bad')) === undefined).toBe(true)
    await expect.poll(() => ctx.sessions.list().length).toBe(sessionsBefore)
  })

  it('registrations through a disposed agent ctx throw INACTIVE_EFFECT', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({ sessionId: SessionId('s1'), agentOptions: { provider: 'mock', model: 'mock' } })
    await handle.dispose()
    expect(() => handle.agent.ctx.on('agent/status', () => {})).toThrow(/inactive context/)
  })

  it('agentEvents fuses carrier and subject for custom drivers', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const other = await ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    const heard: string[] = []
    agent.ctx.on('agent/error', ({ agent: subject, turn }) => void heard.push(`${subject.id}:${turn}`))

    agentEvents(ctx, other).emit('agent/error', { turn: 1, step: 0, error: new Error('not for a1') })
    agentEvents(ctx, agent).emit('agent/error', { turn: 2, step: 0, error: new Error('for a1') })
    expect(heard).toEqual(['a1:2'])
  })

  it('owner unload honors the documented teardown order: unregistration AFTER the drain, before detach', async () => {
    const ctx = await harness()
    let handle!: Awaited<ReturnType<typeof ctx.agents.create>>
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      handle = await inner.agents.create({ sessionId: SessionId('o1-s'), agentOptions: { provider: 'mock', model: 'mock' } })
    }, { inject: ['agents'] }))
    const { agent } = handle

    const order: string[] = []
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/end') order.push('turn-end')
    })
    ctx.on('agent/disposed', () => {
      order.push(`disposed(listed=${ctx.agents.get(SessionId('o1-s')) !== undefined})`)
      order.push(`session-still-stored=${ctx.sessions.get(SessionId('o1-s')) !== undefined}`)
    })

    // Open a turn so disposal must drain real work before registry removal.
    // Waiting for turn/start avoids pre-step disposal dropping the queued prompt
    // before a turn opens.
    const turnOpen = new Promise<void>((resolve) => {
      const off = ctx.on('session/event', (_s, event) => {
        if (event.type === 'turn/start') { off(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: text('work'), source: { kind: 'user' } }))
    await turnOpen
    await owner.dispose()
    expect(order).toEqual([
      'turn-end',
      'disposed(listed=false)',
      'session-still-stored=true',
    ])
    expect(ctx.sessions.get(SessionId('o1-s'))).toBeUndefined()
  })

  it('handle.dispose() during owner unload still awaits true quiescence (shared boundary)', async () => {
    const ctx = await harness()
    let handle!: Awaited<ReturnType<typeof ctx.agents.create>>
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      handle = await inner.agents.create({ sessionId: SessionId('h1-s'), agentOptions: { provider: 'mock', model: 'mock' } })
    }, { inject: ['agents'] }))

    const teardownDone: string[] = []
    ctx.on('agent/disposed', () => void teardownDone.push('unregistered'))

    // Owner unload begins FIRST (invokes the raw cordis wrapper)…
    const unload = owner.dispose()
    // …and a concurrent handle.dispose() must not resolve before the chain
    // actually finished (the raw wrapper returns undefined on a repeat call).
    await handle.dispose()
    expect(teardownDone).toContain('unregistered')
    expect(ctx.agents.get(SessionId('h1-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('h1-s'))).toBeUndefined()
    await unload
  })

  it('successful handle disposal retires its caller ownership effect', async () => {
    const ctx = await harness()
    const sessionId = SessionId('retired-owner-effect')
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(ctx.fiber.getEffects().map(effect => effect.label)).toContain(`agentLoop.lifecycle(${sessionId})`)
    await handle.dispose()
    expect(ctx.fiber.getEffects().filter(effect => effect.label === `agentLoop.lifecycle(${sessionId})`)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('owner unload after handle-first teardown follows the same in-flight boundary', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let handle!: Awaited<ReturnType<typeof ctx.agents.create>>
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      handle = await inner.agents.create({
        sessionId: SessionId('manual-first-s'),
        agentOptions: { provider: 'mock', model: 'mock' },
        setup(agentCtx) {
          agentCtx.effect(() => async () => {
            cleanupStarted.resolve(undefined)
            await gate.promise
          })
        },
      })
    }, { inject: ['agents'] }))

    const disposing = handle.dispose()
    await cleanupStarted.promise
    let ownerSettled = false
    const unloading = owner.dispose().then(() => { ownerSettled = true })
    await Promise.resolve()
    expect(ownerSettled).toBe(false)
    gate.resolve(undefined)
    await Promise.all([disposing, unloading])
    expect(ctx.agents.get(SessionId('manual-first-s'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('manual-first-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reopens ids after the prior private scope finishes quiescing', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    const sessionId = SessionId('quiescent-reuse')
    const first = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup(agentCtx) {
        agentCtx.effect(() => async () => {
          cleanupStarted.resolve(undefined)
          await gate.promise
        })
      },
    })

    const disposing = first.dispose()
    await cleanupStarted.promise
    expect(ctx.agents.get(sessionId)).toBe(first.agent)
    expect(ctx.sessions.get(sessionId)).toBe(first.agent.session)
    gate.resolve(undefined)
    await disposing
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const replacement = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    expect(ctx.agents.get(sessionId)).toBe(replacement.agent)
    expect(ctx.sessions.get(sessionId)).toBe(replacement.agent.session)
    await replacement.dispose()
    await ctx.fiber.dispose()
  })

  it('drains a run re-entered by cancel\'s own idle transition before removing the scope', async () => {
    // Automation shaped like goal-round-driver: the running→idle transition that
    // disposal's cancel produces immediately queues a follow-up prompt. The
    // teardown must drain that replacement run to true quiescence instead of
    // awaiting only the first captured done and unwinding under a live run.
    const adapter = new MockAdapter([textResponse('one'), textResponse('never awaited')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('drain-reentered-run'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent
    let reentered = false
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || reentered) return
      reentered = true
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'reentrant' }], source: { kind: 'user' } }))
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reentered).toBe(true)

    // Idle again: the reentrant batch was already claimed and settled (its
    // prompt was blocked by nothing, so it ran) — arm a SECOND reentry that
    // fires from the disposal cancel's idle transition itself.
    reentered = false
    await handle.dispose()

    // The reentrant run either never started or was drained: the registries
    // are empty and nothing still drives the detached session.
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(ctx.sessions.get(agent.id)).toBeUndefined()
    const eventsAfter = agent.session.snapshotEvents().length
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(agent.session.snapshotEvents().length).toBe(eventsAfter)
    await ctx.fiber.dispose()
  })

})
