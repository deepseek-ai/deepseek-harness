import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import AgentRegistry, {
  agentEvents,
  Inbox,
} from '@deepseek-ai/dsh-agent'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

import type {
  Agent,
  AgentCancelCause,
  AgentFactory,
  AgentStatus,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'

function stubAgent(rawId: string, overrides: Partial<Agent> = {}): Agent {
  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return Object.assign(agent, overrides)
}

describe('Inbox', () => {
  it('rejects an invalid durable splice during reconstruction', () => {
    const session = Session.create(SessionId('invalid-inbox-replay'))
    session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 1,
      inserted: [],
    })

    expect(() => new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }))
      .toThrow('invalid persisted inbox splice at session seq 0')
  })

  it('replaces a pending message by identity across both lists', () => {
    const session = Session.create(SessionId('replace-inbox'))
    const inserted: UserMessage[] = []
    const discarded: UserMessage[] = []
    const inbox = new Inbox(session, {
      claimed: () => {},
      inserted: message => void inserted.push(message),
      discarded: message => void discarded.push(message),
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    })
    const nextStep = createUserMessage({
      content: [{ type: 'text', text: 'step' }],
      source: { kind: 'user' },
    })
    const replacement = createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'user' },
    })
    const editedStep = freezeMessage({
      ...nextStep,
      content: [{ type: 'text', text: 'edited step' }],
    })
    inbox.append('next-turn', original)
    inbox.append('next-step', nextStep)

    expect(inbox.replace(createUserMessage({
      content: [{ type: 'text', text: 'missing' }],
      source: { kind: 'user' },
    }).id, replacement)).toBe(false)
    expect(inbox.replace(original.id, replacement)).toBe(true)
    expect(inbox.replace(nextStep.id, editedStep)).toBe(true)
    expect(inbox.nextTurn).toEqual([replacement])
    expect(inbox.nextStep).toEqual([editedStep])
    expect(discarded).toEqual([original, nextStep])
    expect(inserted).toEqual([original, nextStep, replacement, editedStep])
    expect(() => { inbox.replace(editedStep.id, replacement) })
      .toThrow(`message "${replacement.id}" is already pending`)
  })

  it('normalizes splice coordinates, rejects duplicate identities, and reports missing removals', () => {
    const session = Session.create(SessionId('splice-inbox'))
    const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
    const first = createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })
    const second = createUserMessage({
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    })

    inbox.splice('next-turn', Number.NaN, Number.NaN, [first, second])
    expect(inbox.nextTurn).toEqual([first, second])
    expect(inbox.splice('next-turn', -1, 1, [])).toEqual([second])
    expect(inbox.remove(second.id)).toBe(false)
    expect(() => { inbox.append('next-step', first) }).toThrow(`message "${first.id}" is already pending`)
  })

  it('clears both pending lists as durable cancellations', () => {
    const session = Session.create(SessionId('clear-inbox'))
    const discarded: UserMessage[] = []
    const inbox = new Inbox(session, {
      claimed: () => {},
      inserted: () => {},
      discarded: message => void discarded.push(message),
    })
    const nextTurn = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    const nextStep = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    inbox.append('next-turn', nextTurn)
    inbox.append('next-step', nextStep)
    const beforeClear = session.snapshotEvents().length

    inbox.clear()

    expect(inbox.hasPending).toBe(false)
    expect(discarded).toEqual([nextStep, nextTurn])
    expect(session.snapshotEvents().slice(beforeClear).map(event => event.type === 'agent/inbox/spliced'
      ? event.data
      : event.type)).toEqual([
      { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
      { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    ])

    inbox.clear()
    expect(session.snapshotEvents()).toHaveLength(beforeClear + 2)
  })
})

describe('AgentRegistry', () => {
  it('contributes Agent lookup and scoped Context providers while Typert is live', async () => {
    const ctx = new Context()
    const agentFiber = ctx.plugin(AgentRegistry)
    await agentFiber
    await ctx.plugin(TypertRegistry)
    const agent = stubAgent('remote-agent')
    Object.defineProperty(agent, 'ctx', { value: agent.ctx.extend({ agent }) })
    const disposeAgent = ctx.agents.register(agent)

    const lookup = ctx.typert.lookups.get('agent')
    expect(lookup).toMatchObject({
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
      wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    })
    expect(lookup?.resolve(agent.id)).toBe(agent)
    const context = ctx.typert.contexts.getHost('agent')
    expect(context?.identity(agent.ctx)).toBe(agent.id)
    expect(context?.identity(ctx)).toBeUndefined()
    expect(context?.resolve(agent.id)).toBe(agent.ctx)

    disposeAgent()
    expect(lookup?.resolve(agent.id)).toBeUndefined()
    await agentFiber.dispose()
    expect(ctx.typert.lookups.get('agent')).toBeUndefined()
    expect(ctx.typert.contexts.getHost('agent')).toBeUndefined()
  })

  it('registers exact entries, emits lifecycle events, and unregisters on owner disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const lifecycle: string[] = []
    ctx.on('agent/created', ({ agent }) => void lifecycle.push(`created:${agent.id}`))
    ctx.on('agent/disposed', ({ agent }) => void lifecycle.push(`disposed:${agent.id}`))

    const agent = stubAgent('a1')
    const dispose = ctx.agents.register(agent)
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(ctx.agents.list()).toEqual([agent])
    expect(ctx.agents.roots()).toEqual([agent])
    expect(() => ctx.agents.register(stubAgent('a1'))).toThrow(/already registered/)

    dispose()
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(lifecycle).toEqual(['created:a1', 'disposed:a1'])
  })

  it('rejects an agent whose registry and session identities differ', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const agent = stubAgent('agent-id', { session: Session.create(SessionId('session-id')) })

    expect(() => ctx.agents.enter(agent, undefined))
      .toThrow('agent id "agent-id" does not match session id "session-id"')
    expect(ctx.agents.list()).toEqual([])
  })

  it('tracks runtime creator ownership separately from registry order', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const root = stubAgent('root')
    const child = stubAgent('child')
    const detachRoot = ctx.agents.enter(root, undefined)
    ctx.agents.announce(root)
    const detachChild = ctx.agents.enter(child, root)
    ctx.agents.announce(child)

    expect(ctx.agents.list()).toEqual([root, child])
    expect(ctx.agents.roots()).toEqual([root])
    expect(ctx.agents.isOwnedBy(child.id, root)).toBe(true)
    expect(ctx.agents.isOwnedBy(root.id, root)).toBe(false)
    expect(ctx.agents.isOwnedBy(SessionId('missing'), root)).toBe(false)

    detachChild()
    expect(ctx.agents.isOwnedBy(child.id, root)).toBe(false)
    detachRoot()
  })

  it('rolls an entry back and pairs a partially delivered creation when a listener throws', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const lifecycle: string[] = []
    ctx.on('agent/created', ({ agent }) => void lifecycle.push(`created:${agent.id}`))
    ctx.on('agent/created', () => { throw new Error('creation veto') })
    ctx.on('agent/disposed', ({ agent }) => void lifecycle.push(`disposed:${agent.id}`))

    expect(() => ctx.agents.register(stubAgent('vetoed'))).toThrow('creation veto')
    expect(ctx.agents.get(SessionId('vetoed'))).toBeUndefined()
    expect(lifecycle).toEqual(['created:vetoed', 'disposed:vetoed'])
  })

  it('contains asynchronous creation rejection and every disposal-listener failure', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const warnings: string[] = []
    const heard: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    ctx.on('agent/created', () => Promise.reject(new Error('created async')) as never)
    ctx.on('agent/disposed', () => { throw new Error('disposed sync') })
    ctx.on('agent/disposed', () => Promise.reject(new Error('disposed async')) as never)
    ctx.on('agent/disposed', ({ agent }) => void heard.push(agent.id))

    const dispose = ctx.agents.register(stubAgent('contained'))
    await Promise.resolve()
    dispose()
    await Promise.resolve()

    expect(heard).toEqual(['contained'])
    expect(warnings).toEqual([
      'agent "contained": agent/created listener rejected: Error: created async',
      'agent "contained": agent/disposed listener threw: Error: disposed sync',
      'agent "contained": agent/disposed listener rejected: Error: disposed async',
    ])
  })

  it('separates entry from announcement and stale/idempotent detach cannot remove a replacement', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const lifecycle: string[] = []
    ctx.on('agent/created', ({ agent }) => void lifecycle.push(`created:${agent.id}`))
    ctx.on('agent/disposed', ({ agent }) => void lifecycle.push(`disposed:${agent.id}`))

    const first = stubAgent('split')
    const detachFirst = ctx.agents.enter(first, undefined)
    expect(lifecycle).toEqual([])
    ctx.agents.announce(first)
    expect(() => { ctx.agents.announce(first) }).toThrow(/already announced/)
    detachFirst()
    detachFirst()

    const replacement = stubAgent('split')
    const detachReplacement = ctx.agents.enter(replacement, undefined)
    detachFirst()
    expect(ctx.agents.get(replacement.id)).toBe(replacement)
    expect(() => { ctx.agents.announce(first) }).toThrow(/not live/)
    detachReplacement()
    expect(lifecycle).toEqual(['created:split', 'disposed:split'])
  })

  it('defers detach requested by a creation listener until that dispatch unwinds', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const order: string[] = []
    const agent = stubAgent('reentrant')
    ctx.on('agent/created', () => {
      order.push(`first:${ctx.agents.get(agent.id) === agent}`)
      detach()
      order.push(`after-detach:${ctx.agents.get(agent.id) === agent}`)
    })
    ctx.on('agent/created', () => void order.push(`second:${ctx.agents.get(agent.id) === agent}`))
    ctx.on('agent/disposed', () => void order.push('disposed'))
    const detach = ctx.agents.enter(agent, undefined)
    ctx.agents.announce(agent)
    expect(order).toEqual(['first:true', 'after-detach:true', 'second:true', 'disposed'])
    expect(ctx.agents.get(agent.id)).toBeUndefined()
  })
})

describe('agentEvents()', () => {
  it('contains each synchronous throw and returned-promise rejection', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    const heard: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const agent = stubAgent('event')
    ctx.on('agent/status', () => { throw new Error('sync listener') })
    ctx.on('agent/status', () => Promise.reject(new Error('async listener')) as never)
    ctx.on('agent/status', ({ status }) => void heard.push(status))

    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await Promise.resolve()
    expect(heard).toEqual(['running'])
    expect(warnings).toEqual([
      'agent event "agent/status" listener threw: Error: sync listener',
      'agent event "agent/status" listener rejected: Error: async listener',
    ])
  })

  it('dispatches serial listeners with the fused agent subject', async () => {
    const ctx = new Context()
    const agent = stubAgent('serial-event')
    const signal = new AbortController().signal
    const heard: Array<{ agent: Agent; turn: number; signal: AbortSignal }> = []
    ctx.on('agent/turn-stopping', async ({ agent: subject, turn, signal: receivedSignal }) => {
      await Promise.resolve()
      heard.push({ agent: subject, turn, signal: receivedSignal })
    })

    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 3, signal })

    expect(heard).toEqual([{ agent, turn: 3, signal }])
  })

  it('injects the fused subject even when the payload carries a conflicting agent field', async () => {
    const ctx = new Context()
    const agent = stubAgent('fused-subject')
    const other = stubAgent('payload-agent')
    const heard: Agent[] = []
    ctx.on('agent/status', ({ agent: subject }) => void heard.push(subject))
    // A structurally acceptable payload may carry an extra `agent` field; the
    // dispatcher's injected subject must win over it.
    const payload: { status: AgentStatus; agent: Agent } = { status: 'running', agent: other }

    agentEvents(ctx, agent).emit('agent/status', payload)

    expect(heard).toEqual([agent])
  })
})

describe('explicit cancellation contract', () => {
  it('exposes the closed typed cancellation cause at the Agent seam', () => {
    expectTypeOf<Parameters<Agent['cancel']>[0]>().toEqualTypeOf<AgentCancelCause>()
  })
})

describe('AgentRegistry factory seam', () => {
  function stubFactory() {
    const calls: {
      create: Array<{ ownerCtx: Context; options: CreateAgentOptions }>
      resume: Array<{ ownerCtx: Context; options: ResumeAgentOptions }>
    } = { create: [], resume: [] }
    const factory: AgentFactory = {
      async createAgent(ownerCtx, options) {
        calls.create.push({ ownerCtx, options })
        return { agent: stubAgent(options.sessionId), dispose: () => Promise.resolve() }
      },
      async resume(ownerCtx, options) {
        calls.resume.push({ ownerCtx, options })
        return { agent: stubAgent(options.resumeSessionId), dispose: () => Promise.resolve() }
      },
    }
    return { factory, calls }
  }

  it('requires a factory and delegates through the calling context', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await expect(ctx.agents.create({ sessionId: SessionId('s') })).rejects.toThrow(/no agent factory/)
    const { factory, calls } = stubFactory()
    ctx.agents.setFactory(factory)

    let callerFiber: Context['fiber'] | undefined
    await ctx.plugin(Object.assign(async (inner: Context) => {
      callerFiber = inner.fiber
      await inner.agents.create({ sessionId: SessionId('create-s') })
      await inner.agents.resume({ resumeSessionId: SessionId('resume-s') })
    }, { inject: ['agents'] }))
    expect(calls.create[0]?.ownerCtx.fiber).toBe(callerFiber)
    expect(calls.resume[0]?.ownerCtx.fiber).toBe(callerFiber)
  })

  it('rejects a second factory and clears the slot with its owner (HMR)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.setFactory(stubFactory().factory)
      expect(() => inner.agents.setFactory(stubFactory().factory)).toThrow(/already registered/)
    }, { inject: ['agents'] }))
    await expect(ctx.agents.create({ sessionId: SessionId('before-s') })).resolves.toBeDefined()
    await owner.dispose()
    await expect(ctx.agents.create({ sessionId: SessionId('after-s') })).rejects.toThrow(/no agent factory/)
  })

  it('canonicalizes an already traced Service before tracing it for the caller', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const states = new WeakMap<object, string[]>()
    class TracedFactory extends Service implements AgentFactory {
      constructor(inner: Context) {
        super(inner, 'tracedFactory')
        states.set(this, [])
      }
      private calls(): string[] {
        const original = (this as unknown as { [symbols.original]?: TracedFactory })[symbols.original] ?? this
        const calls = states.get(original)
        if (calls === undefined) throw new Error('factory receiver was not canonicalized')
        return calls
      }
      async createAgent(_ownerCtx: Context, options: CreateAgentOptions) {
        this.calls().push('create')
        return { agent: stubAgent(options.sessionId), dispose: () => Promise.resolve() }
      }
      async resume(_ownerCtx: Context, options: ResumeAgentOptions) {
        this.calls().push('resume')
        return { agent: stubAgent(options.resumeSessionId), dispose: () => Promise.resolve() }
      }
    }
    await ctx.plugin(TracedFactory)
    const traced = (ctx as Context & { tracedFactory: TracedFactory }).tracedFactory
    ctx.agents.setFactory(traced)
    await ctx.agents.create({ sessionId: SessionId('create-s') })
    await ctx.agents.resume({ resumeSessionId: SessionId('resume-s') })
    const raw = (traced as unknown as { [symbols.original]?: TracedFactory })[symbols.original]
    expect(states.get(raw!)).toEqual(['create', 'resume'])
  })
})
