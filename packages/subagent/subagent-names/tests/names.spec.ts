import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations } from '../../subagent/tests/local-activation.ts'
import { bindSubagentActivation } from '../../subagent/tests/manager-internals.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import { TestSessionQuery } from '../../subagent/tests/test-session-query.ts'
import SubagentNames from '../src/index.ts'
import type { NamedSubagentActivationSpec } from '../src/index.ts'

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const queryFiber = await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const namesFiber = await ctx.plugin(SubagentNames)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'mock', model: 'mock' })
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' } : next())
  const start = (overrides: Partial<NamedSubagentActivationSpec> = {}) => ctx.subagentNames.startActivation({
    provider: 'spawn', label: 'Review', parent, delivery: 'parent',
    prompt: [{ type: 'text', text: 'Review the change' }], signal: new AbortController().signal,
    ...overrides,
  })
  const catalog = () => ctx.sessionProjections.snapshot(parent.session, ['subagentCatalog']).values.subagentCatalog
  return { ctx, parent, namesFiber, queryFiber, adapter, start, catalog }
}

function localProvider(ctx: Context) {
  const provider = ctx.subagents.getProvider('spawn')
  if (provider?.prepareContinuable === undefined) throw new Error('spawn preparation is unavailable')
  return provider
}

function externalRun() {
  const result = Promise.withResolvers<SubagentResult>()
  const dispose = vi.fn(async () => { result.resolve({ output: [], stopReason: 'aborted' }) })
  const run: SubagentRun = { id: SessionId(randomUUID()), result: result.promise, dispose }
  return { result, dispose, run }
}

function registerExternal(ctx: Context, run: SubagentRun): void {
  ctx.subagents.registerProvider({
    name: 'external', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => run,
  })
}

describe('catalog-backed subagent names', () => {
  it('allocates names, preserves explicit names, and resolves the same identities by name or id', async () => {
    const { ctx, parent, start } = await setup([textResponse('first'), textResponse('second'), textResponse('third')])
    expect(await ctx.subagentNames.nameOf(parent)).toBe('lead')
    const first = await start()
    await first.result
    const second = await start({ name: 'reviewer' })
    await second.result
    const third = await start()
    await third.result

    expect([first.name, second.name, third.name]).toEqual(['lead/agent-1', 'lead/reviewer', 'lead/agent-2'])
    for (const activation of [first, second, third]) {
      expect(await ctx.subagentNames.resolveName(parent, activation.name)).toBe(activation.childId)
      expect(await ctx.subagentNames.resolveName(parent, activation.childId)).toBe(activation.childId)
    }
    expect(await ctx.subagentNames.resolveName(parent, 'lead')).toBe(parent.id)
    expect(await ctx.subagentNames.resolveName(parent, parent.id)).toBe(parent.id)
    expect(await ctx.subagentNames.listDescendants(parent.id)).toMatchObject([
      { id: first.childId, parentId: parent.id, path: 'agent-1' },
      { id: second.childId, parentId: parent.id, path: 'reviewer' },
      { id: third.childId, parentId: parent.id, path: 'agent-2' },
    ])
    const stored = await loadStoredSession(ctx.sessionPersistence, first.childId)
    const initialMessage = stored.events.find(event => event.type === 'user/message')
    expect(initialMessage?.data.content.slice(0, 2)).toEqual([
      { type: 'text', text: 'Review the change' },
      { type: 'text', text: 'Your name is "lead/agent-1". Your parent agent name is "lead".' },
    ])
  })

  it('keeps unnamed SDK children discoverable by their legacy path and exact id', async () => {
    const { ctx, parent } = await setup([textResponse('legacy')])
    const legacy = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'SDK child', parent, delivery: 'caller',
      prompt: [{ type: 'text', text: 'SDK work' }], signal: new AbortController().signal,
    })
    await legacy.result
    expect(await ctx.subagentNames.resolveName(parent, `lead/legacy:${legacy.childId}`)).toBe(legacy.childId)
    expect(await ctx.subagentNames.resolveName(parent, legacy.childId)).toBe(legacy.childId)
    expect(await ctx.subagentNames.listDescendants(parent.id)).toMatchObject([{ id: legacy.childId, path: `legacy:${legacy.childId}` }])
  })

  it('keeps root naming and creation available without query while failing parent reads explicitly', async () => {
    const { ctx, parent, queryFiber, start } = await setup([textResponse('child')])
    await queryFiber.dispose()
    expect(await ctx.subagentNames.nameOf(parent)).toBe('lead')
    const child = await start({ name: 'reviewer' })
    await child.result
    await expect(ctx.subagentNames.resolveName(parent, child.name)).rejects.toMatchObject({ code: 'AGENT_NAMES_UNAVAILABLE' })
  })

  it('rejects observations that do not supply the naming projections', async () => {
    const { ctx, parent, start } = await setup([textResponse('child')])
    const child = await start({ name: 'reviewer' })
    await child.result
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
      observe(id, { ...options, projectionMode: 'none' }),
    )
    await expect(ctx.subagentNames.resolveName(parent, child.name)).rejects.toMatchObject({ code: 'AGENT_NAMES_UNAVAILABLE' })
  })

  it.each(['cyclic', 'missing-ancestry', 'uncatalogued'] as const)(
    'rejects %s creation ancestry instead of inventing a name', async (kind) => {
      const { ctx, parent } = await setup()
      const id = SessionId(randomUUID())
      const child = await ctx.agents.create({
        sessionId: id,
        meta: { origin: 'subagent', ...kind === 'missing-ancestry' ? {} : { parentSession: kind === 'cyclic' ? id : parent.id } },
      })
      bindSubagentActivation(ctx, child.agent, parent)
      await expect(ctx.subagentNames.nameOf(child.agent)).rejects.toMatchObject({
        code: kind === 'cyclic' ? 'CORRUPT_AGENT_NAMES' : 'AGENT_NAMES_UNAVAILABLE',
      })
    },
  )

  it('rejects two cataloged children that claim the same sibling name', async () => {
    const { ctx, parent, start } = await setup()
    for (let index = 0; index < 2; index++) {
      const childId = SessionId(randomUUID())
      parent.session.append('subagent-name/bound', { version: 1, childId, name: 'reviewer' })
      parent.session.append('subagent/catalog', { version: 2, childId, childCreatedAt: 1, mode: 'external' })
    }
    await expect(ctx.subagentNames.resolveName(parent, 'lead/reviewer')).rejects.toMatchObject({ code: 'CORRUPT_AGENT_NAMES' })
    await expect(start()).rejects.toMatchObject({ code: 'CORRUPT_AGENT_NAMES' })
  })

  it.each(['', 'Reviewer', 'lead/reviewer', 'two words', '1reviewer', 'legacy:child'])(
    'rejects invalid sibling name %j before preparing a child', async (name) => {
      const { ctx, start, catalog } = await setup()
      const prepare = vi.spyOn(localProvider(ctx), 'prepareContinuable')
      await expect(start({ name })).rejects.toMatchObject({ code: 'INVALID_AGENT_NAME' })
      expect(prepare).not.toHaveBeenCalled()
      expect(catalog()).toEqual([])
    },
  )

  it('holds the sibling reservation throughout overlapping provider preparation', async () => {
    const { ctx, start, catalog } = await setup([textResponse('first'), textResponse('second')])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const prepare = vi.spyOn(localProvider(ctx), 'prepareContinuable').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return {}
    })
    const first = start({ name: 'reviewer' })
    try {
      await entered.promise
      await expect(start({ name: 'reviewer' })).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
      expect(catalog()).toEqual([])
      expect(prepare).toHaveBeenCalledTimes(1)
      const independent = await start({ name: 'writer' })
      await independent.result
    } finally {
      release.resolve(undefined)
    }
    const accepted = await first
    await accepted.result
    expect(accepted.name).toBe('lead/reviewer')
    await expect(start({ name: 'reviewer' })).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
  })

  it('does not occupy a name when its candidate append fails', async () => {
    const { ctx, parent, start, catalog } = await setup([textResponse('retry')])
    const failure = new Error('name append failed')
    const append = vi.spyOn(parent.session, 'append').mockImplementationOnce(() => { throw failure })
    await expect(start({ name: 'reviewer' })).rejects.toBe(failure)
    append.mockRestore()
    expect(catalog()).toEqual([])
    const retry = await start({ name: 'reviewer' })
    await retry.result
    expect(await ctx.subagentNames.resolveName(parent, retry.name)).toBe(retry.childId)
  })

  it('ignores a candidate without a catalog child and reuses its name after failed preparation', async () => {
    const { ctx, parent, start, catalog } = await setup([textResponse('retry')])
    const failure = new Error('provider preparation failed')
    vi.spyOn(localProvider(ctx), 'prepareContinuable').mockRejectedValueOnce(failure)
    await expect(start({ name: 'reviewer' })).rejects.toBe(failure)
    expect(catalog()).toEqual([])
    expect(ctx.sessionProjections.snapshot(parent.session).values.subagentNames).toHaveLength(1)
    await expect(ctx.subagentNames.resolveName(parent, 'lead/reviewer')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    const retry = await start({ name: 'reviewer' })
    await retry.result
    expect(await ctx.subagentNames.resolveName(parent, retry.name)).toBe(retry.childId)
    expect(ctx.sessionProjections.snapshot(parent.session).values.subagentNames).toHaveLength(2)
  })

  it('retains the name when catalog publication commits before startup reports failure', async () => {
    const { ctx, parent, start, catalog } = await setup(['hang'])
    const failure = new Error('catalog acknowledgement failed')
    const append = parent.session.append.bind(parent.session)
    const spy = vi.spyOn(parent.session, 'append').mockImplementation((...args) => {
      const event = Reflect.apply(append, parent.session, args) as ReturnType<typeof append>
      if (args[0] === 'subagent/catalog') throw failure
      return event
    })
    await expect(start({ name: 'reviewer' })).rejects.toBe(failure)
    spy.mockRestore()
    const childId = catalog()?.[0]?.id
    expect(childId).toBeDefined()
    expect(await ctx.subagentNames.resolveName(parent, 'lead/reviewer')).toBe(childId)
    await expect(start({ name: 'reviewer' })).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
  })

  it('reads a resumed descendant name through its cold parent without restoring the parent', async () => {
    const { ctx, parent, adapter, start } = await setup(['hang', 'hang', 'hang'])
    const creator = await start({ name: 'reviewer' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const creatorAgent = ctx.agents.get(creator.childId)
    expect(creatorAgent).toBeDefined()
    const leaf = await start({ parent: creatorAgent!, name: 'facts' })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const leafAgent = ctx.agents.get(leaf.childId)
    expect(await ctx.subagentNames.nameOf(leafAgent!)).toBe('lead/reviewer/facts')
    await leaf.dispose()
    await creator.dispose()
    expect(ctx.agents.get(creator.childId)).toBeUndefined()
    expect(ctx.agents.get(leaf.childId)).toBeUndefined()

    await ctx.subagents.sendMessage(parent, leaf.childId, [{ type: 'text', text: 'Check again' }], { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const restored = ctx.agents.get(leaf.childId)
    expect(restored).toBeDefined()
    expect(await ctx.subagentNames.nameOf(restored!)).toBe('lead/reviewer/facts')
    expect(await ctx.subagentNames.resolveName(parent, 'lead/reviewer/facts')).toBe(leaf.childId)
    expect(await ctx.subagentNames.listDescendants(parent.id)).toMatchObject([
      { id: creator.childId, path: 'reviewer' }, { id: leaf.childId, path: 'reviewer/facts' },
    ])
    expect(ctx.agents.get(creator.childId)).toBeUndefined()
  })

  it('binds an external child only after the accepted provider identity is known', async () => {
    const { ctx, parent, start } = await setup()
    const backend = externalRun()
    registerExternal(ctx, backend.run)
    const activation = await start({ provider: 'external', name: 'reviewer', delivery: 'parent' })
    expect(activation.childId).toBe(backend.run.id)
    expect(await ctx.subagentNames.resolveName(parent, activation.name)).toBe(backend.run.id)
    await expect(ctx.subagentNames.resolveName(parent, `${activation.name}/child`)).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    await activation.dispose()
    expect(backend.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports both binding and disposal failures for an accepted external child', async () => {
    const { ctx, parent, start } = await setup()
    const backend = externalRun()
    registerExternal(ctx, backend.run)
    const bindingFailure = new Error('binding failed')
    const cleanupFailure = new Error('cleanup failed')
    backend.dispose.mockImplementationOnce(async () => {
      backend.result.resolve({ output: [], stopReason: 'aborted' })
      throw cleanupFailure
    })
    const append = parent.session.append.bind(parent.session)
    vi.spyOn(parent.session, 'append').mockImplementation((...args) => {
      if (args[0] === 'subagent-name/bound') throw bindingFailure
      return Reflect.apply(append, parent.session, args) as ReturnType<typeof append>
    })
    const error = await start({ provider: 'external', name: 'reviewer' }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'SUBAGENT_NAME_BIND_FAILED', childId: backend.run.id })
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error('expected named-start failure')
    expect(error.message).toContain('execution may still be active')
    expect(error.cause).toBeInstanceOf(AggregateError)
    if (!(error.cause instanceof AggregateError)) throw new Error('expected combined failure')
    expect(error.cause.errors).toHaveLength(2)
    expect(error.cause.errors[0]).toBe(bindingFailure)
    expect(error.cause.errors[1]).toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED', cause: cleanupFailure })
  })

  it('reports the started external child and awaits that receipt disposal when binding fails', async () => {
    const { ctx, parent, start } = await setup()
    const backend = externalRun()
    const unrelated = externalRun()
    registerExternal(ctx, backend.run)
    ctx.subagents.registerProvider({
      name: 'unrelated', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => unrelated.run,
    })
    const existing = await start({ provider: 'unrelated', name: 'writer', delivery: 'parent' })
    const cleaning = Promise.withResolvers<undefined>()
    const cleaned = Promise.withResolvers<undefined>()
    backend.dispose.mockImplementation(async () => {
      backend.result.resolve({ output: [], stopReason: 'aborted' })
      cleaning.resolve(undefined)
      await cleaned.promise
    })
    const failure = new Error('external binding append failed')
    const append = parent.session.append.bind(parent.session)
    const spy = vi.spyOn(parent.session, 'append').mockImplementation((...args) => {
      if (args[0] === 'subagent-name/bound') throw failure
      return Reflect.apply(append, parent.session, args) as ReturnType<typeof append>
    })
    const starting = start({ provider: 'external', name: 'reviewer', delivery: 'parent' })
    const observed = vi.fn()
    void starting.then(observed, observed)
    const rejected = expect(starting).rejects.toMatchObject({
      code: 'SUBAGENT_NAME_BIND_FAILED', childId: backend.run.id, cause: failure,
    })
    try {
      await cleaning.promise
      expect(backend.dispose).toHaveBeenCalledTimes(1)
      expect(unrelated.dispose).not.toHaveBeenCalled()
      expect(observed).not.toHaveBeenCalled()
    } finally {
      cleaned.resolve(undefined)
    }
    await rejected
    spy.mockRestore()
    await existing.dispose()
  })

  it('refuses to overwrite a historical name when an external provider reuses its child id', async () => {
    const { ctx, parent, start } = await setup()
    const first = externalRun()
    const next = externalRun()
    const reused = { ...next.run, id: first.run.id }
    const providerStart = vi.fn().mockResolvedValueOnce(first.run).mockResolvedValueOnce(reused)
    ctx.subagents.registerProvider({
      name: 'external', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: providerStart,
    })
    const original = await start({ provider: 'external', name: 'reviewer', delivery: 'parent' })
    await original.dispose()
    await expect(start({ provider: 'external', name: 'writer', delivery: 'parent' })).rejects.toMatchObject({
      code: 'SUBAGENT_NAME_BIND_FAILED', childId: first.run.id,
    })
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(next.dispose).toHaveBeenCalledTimes(1)
    expect(ctx.sessionProjections.snapshot(parent.session).values.subagentNames).toEqual([
      { childId: first.run.id, name: 'reviewer' },
    ])
    expect(await ctx.subagentNames.resolveName(parent, original.name)).toBe(first.run.id)
    await expect(ctx.subagentNames.resolveName(parent, 'lead/writer')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
  })

  it('aborts pending preparation and drains it before plugin disposal completes', async () => {
    const { ctx, parent, namesFiber, start, catalog } = await setup()
    const names = ctx.subagentNames
    const entered = Promise.withResolvers<AbortSignal>()
    const aborted = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    vi.spyOn(localProvider(ctx), 'prepareContinuable').mockImplementationOnce(async ({ signal }) => {
      entered.resolve(signal)
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      await aborted.promise
      await cleanup.promise
      signal.throwIfAborted()
      return {}
    })
    const starting = start({ name: 'reviewer' })
    const rejected = expect(starting).rejects.toThrow('unloading')
    const signal = await entered.promise
    const disposal = namesFiber.dispose()
    const disposed = vi.fn()
    void disposal.then(disposed, disposed)
    try {
      await aborted.promise
      expect(signal.aborted).toBe(true)
      expect(disposed).not.toHaveBeenCalled()
      expect(catalog()).toEqual([])
      const bindings = ctx.sessionProjections.snapshot(parent.session).values.subagentNames
      expect(bindings).toHaveLength(1)
      expect(bindings?.[0]?.childId).toEqual(expect.any(String))
      expect(bindings?.[0]?.name).toBe('reviewer')
      await expect(names.nameOf(parent)).rejects.toMatchObject({ code: 'AGENT_NAMES_UNAVAILABLE' })
    } finally {
      cleanup.resolve(undefined)
    }
    await rejected
    await disposal
    expect(ctx.get('subagentNames')).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(parent.session).values.subagentNames).toBeUndefined()
  })
})
