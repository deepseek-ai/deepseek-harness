import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { SubagentNames } from '../src/names.ts'
import { subagentCatalogProjectionDefinition, subagentCatalogEntries, establishCatalogChild, establishExternalCatalogChild } from '../src/catalog.ts'
import { subagentIdentityProjectionDefinition } from '../src/projection.ts'
import { snapshotSubagentDescriptor } from '../src/descriptor.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { TestSessionQuery } from './test-session-query.ts'

const signal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  const parent = await externalTestParent(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TestSessionQuery)
  const catalog = await ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
  const identity = await ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  const sources = {
    catalogOf: (session: typeof parent.session) => subagentCatalogEntries(catalog.stateOf(session)),
    identityOf: (session: typeof parent.session) => identity.stateOf(session).identity,
    residencyOf: () => undefined,
  }
  return { ctx, parent, sources, names: new SubagentNames(ctx, sources) }
}

describe('agent paths', () => {
  it('reserves lead for each root and isolates independent trees', async () => {
    const { ctx, parent, names } = await setup()
    const other = await externalTestParent(ctx)
    expect(names.nameOf(parent)).toBe('lead')
    expect(await names.resolve(other, 'lead')).toBe(other.id)
    for (const root of [parent, other]) {
      using reservation = names.reserve(root, 'reviewer', signal)
      reservation.commit(SessionId('child'), () => { establishExternalCatalogChild(root.session, SessionId('child'), 'Review', 'reviewer') })
      expect(await names.resolve(root, 'lead/reviewer')).toBe('child')
    }
  })

  it.each(['', 'Reviewer', 'has space', '1worker', 'legacy:old', 'a/b', '.', '..', 'a\\b'])(
    'rejects invalid name %j without writing a creation record', async (name) => {
      const { parent, names } = await setup()
      const seq = parent.session.seq
      expect(() => names.reserve(parent, name, signal)).toThrow(expect.objectContaining({ code: 'INVALID_AGENT_NAME' }))
      expect(parent.session.seq).toBe(seq)
    },
  )

  it('reuses sibling names in separate branches and resolves paths through only their parent catalogs', async () => {
    const { ctx, parent, names, sources } = await setup()
    const session = ctx.sessions.create(SessionId('nested'), { meta: { origin: 'subagent', parentSession: parent.id } })
    const nested = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(nested, undefined))
    const descriptor = snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'Review', name: 'reviewer' })
    session.append('subagent/descriptor', descriptor)
    {
      using reservation = names.reserve(parent, 'reviewer', signal, session.id)
      expect(reservation.name).toBe('lead/reviewer')
      await expect(names.resolve(parent, reservation.name)).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
      reservation.commit(session.id, () => { establishCatalogChild(parent.session, session.header, descriptor) })
    }
    const rootEvents = parent.session.snapshotEvents()
    {
      using reservation = names.reserve(nested, 'reviewer', signal)
      expect(reservation.name).toBe('lead/reviewer/reviewer')
      reservation.commit(SessionId('external'), () => { establishExternalCatalogChild(session, SessionId('external'), 'Review', 'reviewer') })
    }
    expect(parent.session.snapshotEvents()).toEqual(rootEvents)
    expect(names.nameOf(nested)).toBe('lead/reviewer')
    expect(ctx.subagents.nameOf(nested)).toBe('lead/reviewer')
    const restored = new SubagentNames(ctx, sources)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    try {
      expect(await restored.resolve(nested, 'lead/reviewer/reviewer')).toBe('external')
      expect(observe.mock.calls.map(([id]) => id)).toEqual([session.id])
      expect(await restored.resolve(parent, 'lead/reviewer')).toBe(session.id)
      expect(() => restored.reserve(nested, 'reviewer', signal)).toThrow(expect.objectContaining({ code: 'DUPLICATE_AGENT_NAME' }))
      expect(() => restored.reserve(parent, 'another', signal, session.id)).toThrow(expect.objectContaining({ code: 'DUPLICATE_CHILD' }))
      await expect(restored.resolve(nested, 'lead/reviewer/reviewer/child')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    } finally {
      observe.mockRestore()
    }
  })

  it('holds and releases equal pending names independently under two live parents', async () => {
    const { ctx, parent, names } = await setup()
    const branches = ['review', 'explore'].map((name) => {
      const session = ctx.sessions.create(SessionId(name), { meta: { origin: 'subagent', parentSession: parent.id } })
      const agent = { ...parent, id: session.id, session }
      onTestFinished(ctx.agents.enter(agent, undefined))
      const descriptor = snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: name, name })
      session.append('subagent/descriptor', descriptor)
      establishCatalogChild(parent.session, session.header, descriptor)
      return agent
    })
    const first = names.reserve(branches[0]!, 'alice', signal)
    using second = names.reserve(branches[1]!, 'alice', signal)
    expect(first.name).toBe('lead/review/alice')
    expect(second.name).toBe('lead/explore/alice')
    first[Symbol.dispose]()
    using retry = names.reserve(branches[0]!, 'alice', signal)
    expect(() => names.reserve(branches[1]!, 'alice', signal)).toThrow(expect.objectContaining({ code: 'DUPLICATE_AGENT_NAME' }))
    retry.commit(SessionId('a'), () => { establishExternalCatalogChild(branches[0]!.session, SessionId('a'), 'Review', 'alice') })
    second.commit(SessionId('b'), () => { establishExternalCatalogChild(branches[1]!.session, SessionId('b'), 'Explore', 'alice') })
    expect(await names.resolve(parent, retry.name)).toBe('a')
    expect(await names.resolve(parent, second.name)).toBe('b')
  })

  it.each(['reviewer', '/lead/reviewer', 'lead//reviewer', 'lead/../reviewer', 'lead/reviewer/', 'lead/./reviewer'])(
    'rejects noncanonical path %j', async (path) => {
      const { parent, names } = await setup()
      establishExternalCatalogChild(parent.session, SessionId('child'), 'Review', 'reviewer')
      await expect(names.resolve(parent, path)).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    },
  )

  it('allows root and task-filter words as child segments', async () => {
    const { parent, names } = await setup()
    for (const name of ['lead', 'unowned']) {
      using reservation = names.reserve(parent, name, signal)
      reservation.commit(SessionId(name), () => { establishExternalCatalogChild(parent.session, SessionId(name), 'Task', name) })
      expect(await names.resolve(parent, `lead/${name}`)).toBe(name)
    }
  })

  it('releases failed startup reservations and refuses a concurrent duplicate before provider dispatch', async () => {
    const { ctx, parent } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const start = vi.fn(async () => {
      entered.resolve(undefined)
      await gate.promise
      throw new Error('provider failed')
    })
    ctx.subagents.registerProvider({
      name: 'external', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, start,
    })
    const spec = {
      name: 'reviewer', provider: 'external', label: 'review', delivery: 'caller' as const,
      request: { parent, prompt: [{ type: 'text' as const, text: 'Review' }] }, signal,
    }
    const first = ctx.subagents.startActivation(spec)
    const rejected = expect(first).rejects.toThrow('provider failed')
    try {
      await entered.promise
      await expect(ctx.subagents.startActivation(spec)).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
      expect(start).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve(undefined)
      await rejected
    }
    await expect(ctx.subagents.startActivation(spec)).rejects.toThrow('provider failed')
    expect(start).toHaveBeenCalledTimes(2)
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
  })

  it('rejects reuse of a disposed ephemeral local identity before publishing another child', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    const parent = await ctx.agentLoop.create(SessionId('root'), { provider: 'mock', model: 'mock' })
    const start = (name: string) => ctx.subagents.startActivation({
      name, childId: SessionId('ephemeral-child'), provider: 'spawn', label: 'Check', delivery: 'caller', signal,
      request: { parent, prompt: [{ type: 'text', text: 'Reply' }] },
    })
    await expect(start('Reviewer')).rejects.toMatchObject({ code: 'INVALID_AGENT_NAME' })
    const first = await start('first')
    await first.result
    expect(ctx.agents.get(first.childId)).toBeUndefined()
    expect(ctx.sessions.get(first.childId)).toBeUndefined()
    const before = parent.session.snapshotEvents()
    await expect(start('second')).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    expect(parent.session.snapshotEvents()).toEqual(before)
    expect(await ctx.subagents.resolveName(parent, 'lead/first')).toBe(first.childId)
  })

  it('resolves only cataloged legacy addresses and rejects cancellation', async () => {
    const { ctx, parent, names } = await setup()
    const child = ctx.sessions.create(SessionId('old-child'), { meta: { origin: 'subagent', parentSession: parent.id } })
    parent.session.append('subagent/catalog', { version: 0, childId: child.id, childCreatedAt: 0, mode: 'continuable', label: 'Old child' })
    expect(await names.resolve(parent, 'lead/legacy:old-child')).toBe(child.id)
    await expect(names.resolve(parent, 'lead/legacy:missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    await expect(names.resolve(parent, 'missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    await expect(names.resolve(parent, 'lead', AbortSignal.abort(new Error('cancel lookup')))).rejects.toThrow('cancel lookup')
    const agent = { ...parent, id: child.id, session: child }
    onTestFinished(ctx.agents.enter(agent, undefined))
    expect(names.nameOf(agent)).toBe('lead/legacy:old-child')
  })

  it('keeps unnamed direct-child ids occupied without reading their logs', async () => {
    const { ctx, parent, names } = await setup()
    parent.session.append('subagent/catalog', { version: 0, childId: SessionId('legacy-child'), childCreatedAt: 0, mode: 'continuable', label: 'Old child' })
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    try {
      expect(() => names.reserve(parent, 'writer', signal, SessionId('legacy-child')))
        .toThrow(expect.objectContaining({ code: 'DUPLICATE_CHILD' }))
      using reservation = names.reserve(parent, 'external', signal)
      const publish = vi.fn()
      expect(() => { reservation.commit(SessionId('legacy-child'), publish) })
        .toThrow(expect.objectContaining({ code: 'DUPLICATE_CHILD' }))
      expect(publish).not.toHaveBeenCalled()
      expect(observe).not.toHaveBeenCalled()
    } finally {
      observe.mockRestore()
    }
  })

  it('resolves historical nested paths after their Agents unload', async () => {
    const { ctx, parent, names } = await setup()
    const child = ctx.sessions.create(SessionId('old'), { meta: { origin: 'subagent', parentSession: parent.id } })
    establishCatalogChild(parent.session, child.header, { mode: 'continuable', label: 'Old' })
    child.append('subagent/catalog', { version: 2, childId: SessionId('remote'), childCreatedAt: 0, mode: 'external' })
    expect(ctx.agents.get(child.id)).toBeUndefined()
    expect(await names.resolve(parent, 'lead/legacy:old/legacy:remote')).toBe('remote')
    await expect(names.resolve(parent, 'lead/legacy:missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
  })

  it('lists direct children without reading their parent ancestry', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('orphan'), { meta: { origin: 'subagent' } })
    establishExternalCatalogChild(session, SessionId('remote'), 'Task', 'writer')
    expect(await ctx.subagents.listChildren(session.id)).toMatchObject([{ id: 'remote', name: 'writer' }])
  })

  it('checks sibling names without reading an unavailable historical branch', async () => {
    const { ctx, parent, names } = await setup()
    parent.session.append('subagent/catalog', { version: 0, childId: SessionId('missing'), childCreatedAt: 0, mode: 'continuable', label: 'Missing', name: 'reviewer' })
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    using _reservation = names.reserve(parent, 'writer', signal)
    expect(await names.resolve(parent, 'lead/reviewer')).toBe('missing')
    await expect(names.resolve(parent, 'lead/writer')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    expect(observe).not.toHaveBeenCalled()
    observe.mockRestore()
  })

  it('rejects an ambiguous persisted sibling name', async () => {
    const { parent, names } = await setup()
    establishExternalCatalogChild(parent.session, SessionId('first'), 'Review', 'reviewer')
    establishExternalCatalogChild(parent.session, SessionId('second'), 'Review again', 'reviewer')
    await expect(names.resolve(parent, 'lead/reviewer')).rejects.toMatchObject({ code: 'CORRUPT_AGENT_NAMES' })
  })

  it('refuses publication after ancestor replacement and releases the uncommitted name', async () => {
    const { ctx, parent, names } = await setup()
    {
      using reservation = names.reserve(parent, 'reviewer', signal)
      const get = ctx.agents.get.bind(ctx.agents)
      const lookup = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === parent.id ? { ...parent } : get(id))
      const publish = vi.fn()
      expect(() => { reservation.commit(SessionId('child'), publish) }).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
      expect(publish).not.toHaveBeenCalled()
      lookup.mockRestore()
    }
    using retry = names.reserve(parent, 'reviewer', signal)
    expect(() => { retry.commit(SessionId('child'), () => { throw new Error('append failed') }) }).toThrow('append failed')
  })

  it('rejects cyclic live ancestry', async () => {
    const { ctx, parent, names } = await setup()
    const session = ctx.sessions.create(SessionId('cycle'), { meta: { origin: 'subagent', parentSession: SessionId('cycle') } })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    expect(() => names.nameOf(child)).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
  })

  it('accepts repeated identical catalog facts and isolates fork-inherited assignments', async () => {
    const { ctx, parent, names } = await setup()
    establishExternalCatalogChild(parent.session, SessionId('old'), 'Review', 'reviewer')
    establishExternalCatalogChild(parent.session, SessionId('old'), 'Review', 'reviewer')
    expect(await names.resolve(parent, 'lead/reviewer')).toBe('old')
    const fork = ctx.sessions.fork(parent.session, undefined, SessionId('fork'))
    const agent = { ...parent, id: fork.id, session: fork }
    onTestFinished(ctx.agents.enter(agent, undefined))
    expect(names.nameOf(agent)).toBe('lead')
    using reservation = names.reserve(agent, 'reviewer', signal)
    reservation.commit(SessionId('new'), () => { establishExternalCatalogChild(fork, SessionId('new'), 'Review', 'reviewer') })
    expect(await names.resolve(agent, 'lead/reviewer')).toBe('new')
  })

  it('rejects a subagent header without a parent', async () => {
    const { ctx, parent, names } = await setup()
    const session = ctx.sessions.create(SessionId('orphan'), { meta: { origin: 'subagent' } })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    expect(() => names.reserve(child, 'writer', signal)).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
  })

  it('rejects stale callers and detached children', async () => {
    const { ctx, parent, names } = await setup()
    expect(() => names.nameOf({ ...parent })).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    const session = ctx.sessions.create(SessionId('orphan'), { meta: { origin: 'subagent', parentSession: SessionId('missing') } })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    expect(() => names.nameOf(child)).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
    expect(() => names.reserve(child, 'writer', signal)).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
  })
})
