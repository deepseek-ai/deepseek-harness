import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { SubagentNames } from '../src/names.ts'
import { establishCatalogChild, establishExternalCatalogChild } from '../src/catalog.ts'
import { snapshotSubagentDescriptor } from '../src/descriptor.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { TestSessionQuery } from './test-session-query.ts'

const signal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  const parent = await externalTestParent(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TestSessionQuery)
  return { ctx, parent, names: new SubagentNames(ctx) }
}

describe('tree-wide agent names', () => {
  it('reserves lead for each root and isolates independent trees', async () => {
    const { ctx, parent, names } = await setup()
    const other = await externalTestParent(ctx)
    expect(names.nameOf(parent)).toBe('lead')
    expect(await names.resolve(other, 'lead')).toBe(other.id)
    for (const root of [parent, other]) {
      using reservation = await names.reserve(root, 'reviewer', signal)
      reservation.commit(SessionId('child'), () => { establishExternalCatalogChild(root.session, SessionId('child'), 'Review', 'reviewer') })
      expect(await names.resolve(root, 'reviewer')).toBe('child')
    }
  })

  it.each(['lead', 'unowned', '', 'Reviewer', 'has space', '1worker', 'legacy:old'])(
    'rejects invalid name %j without writing a creation record', async (name) => {
      const { parent, names } = await setup()
      const seq = parent.session.seq
      await expect(names.reserve(parent, name, signal)).rejects.toMatchObject({ code: 'INVALID_AGENT_NAME' })
      expect(parent.session.seq).toBe(seq)
    },
  )

  it('rebuilds nested assignments from catalogs and reads the child name from its descriptor', async () => {
    const { ctx, parent, names } = await setup()
    const session = ctx.sessions.create(SessionId('nested'), { meta: { origin: 'subagent', parentSession: parent.id } })
    const nested = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(nested, undefined))
    const descriptor = snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'Review', name: 'reviewer' })
    session.append('subagent/descriptor', descriptor)
    {
      using reservation = await names.reserve(parent, 'reviewer', signal, session.id)
      await expect(names.resolve(parent, 'reviewer')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
      await expect(names.reserve(nested, 'reviewer', signal)).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
      reservation.commit(session.id, () => { establishCatalogChild(parent.session, session.header, descriptor) })
    }
    {
      using reservation = await names.reserve(nested, 'writer', signal)
      reservation.commit(SessionId('external'), () => { establishExternalCatalogChild(session, SessionId('external'), 'Write', 'writer') })
    }
    expect(names.nameOf(nested)).toBe('reviewer')
    const restored = new SubagentNames(ctx)
    expect(await restored.resolve(nested, 'writer')).toBe('external')
    expect(await restored.resolve(parent, 'reviewer')).toBe(session.id)
    await expect(restored.reserve(parent, 'writer', signal)).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
    await expect(restored.reserve(parent, 'another', signal, session.id)).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
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
    expect(await ctx.subagents.resolveName(parent, 'first')).toBe(first.childId)
  })

  it('resolves only cataloged legacy addresses and rejects cancellation', async () => {
    const { ctx, parent, names } = await setup()
    const child = ctx.sessions.create(SessionId('old-child'), { meta: { origin: 'subagent', parentSession: parent.id } })
    parent.session.append('subagent/catalog', { version: 0, childId: child.id, childCreatedAt: 0, mode: 'continuable', label: 'Old child' })
    expect(await names.resolve(parent, 'legacy:old-child')).toBe(child.id)
    await expect(names.resolve(parent, 'legacy:missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    await expect(names.resolve(parent, 'missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    await expect(names.resolve(parent, 'lead', AbortSignal.abort(new Error('cancel lookup')))).rejects.toThrow('cancel lookup')
    const agent = { ...parent, id: child.id, session: child }
    onTestFinished(ctx.agents.enter(agent, undefined))
    expect(names.nameOf(agent)).toBe('legacy:old-child')
  })

  it('does not initialize a partial index when a historical branch cannot be read', async () => {
    const { ctx, parent, names } = await setup()
    parent.session.append('subagent/catalog', { version: 0, childId: SessionId('missing'), childCreatedAt: 0, mode: 'continuable', label: 'Missing', name: 'reviewer' })
    await expect(names.reserve(parent, 'writer', signal)).rejects.toThrow()
    const restored = ctx.sessions.create(SessionId('missing'), { meta: { origin: 'subagent', parentSession: parent.id } })
    establishExternalCatalogChild(restored, SessionId('writer-child'), 'Write', 'writer')
    await expect(names.reserve(parent, 'writer', signal)).rejects.toMatchObject({ code: 'DUPLICATE_AGENT_NAME' })
    expect(await names.resolve(parent, 'writer')).toBe('writer-child')
  })

  it.each(['name', 'identity'])('rejects duplicate cataloged %s when rebuilding', async (duplicate) => {
    const { parent, names } = await setup()
    establishExternalCatalogChild(parent.session, SessionId('first'), 'Review', 'reviewer')
    establishExternalCatalogChild(parent.session, SessionId(duplicate === 'identity' ? 'first' : 'second'), 'Write', duplicate === 'name' ? 'reviewer' : 'writer')
    await expect(names.reserve(parent, 'another', signal)).rejects.toMatchObject({ code: 'CORRUPT_AGENT_NAMES' })
  })

  it('refuses publication after ancestor replacement and releases the uncommitted name', async () => {
    const { ctx, parent, names } = await setup()
    {
      using reservation = await names.reserve(parent, 'reviewer', signal)
      const get = ctx.agents.get.bind(ctx.agents)
      const lookup = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === parent.id ? { ...parent } : get(id))
      const publish = vi.fn()
      expect(() => { reservation.commit(SessionId('child'), publish) }).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
      expect(publish).not.toHaveBeenCalled()
      lookup.mockRestore()
    }
    using retry = await names.reserve(parent, 'reviewer', signal)
    expect(() => { retry.commit(SessionId('child'), () => { throw new Error('append failed') }) }).toThrow('append failed')
  })

  it.each(['reserve', 'publish'] as const)('rejects an ancestry change during %s', async (phase) => {
    const { ctx, parent, names } = await setup()
    const otherRoot = await externalTestParent(ctx)
    const session = ctx.sessions.create(SessionId('nested'), { meta: { origin: 'subagent', parentSession: parent.id } })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    const pending = names.reserve(child, 'reviewer', signal)
    const reservation = phase === 'publish' ? await pending : undefined
    const replacement = { ...parent, session: Session.create(parent.id, undefined, {
      ...parent.session.header, origin: 'subagent', parentSession: otherRoot.id,
    }) }
    const get = ctx.agents.get.bind(ctx.agents)
    const lookup = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === parent.id ? replacement : get(id))
    try {
      if (reservation === undefined) {
        await expect(pending).rejects.toMatchObject({ code: 'AGENT_TREE_UNAVAILABLE' })
      } else {
        const publish = vi.fn()
        expect(() => { reservation.commit(SessionId('child'), publish) })
          .toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
        expect(publish).not.toHaveBeenCalled()
      }
    } finally {
      reservation?.[Symbol.dispose]()
      lookup.mockRestore()
    }
  })

  it('accepts repeated identical catalog facts and isolates fork-inherited assignments', async () => {
    const { ctx, parent, names } = await setup()
    establishExternalCatalogChild(parent.session, SessionId('old'), 'Review', 'reviewer')
    establishExternalCatalogChild(parent.session, SessionId('old'), 'Review', 'reviewer')
    expect(await names.resolve(parent, 'reviewer')).toBe('old')
    const fork = ctx.sessions.fork(parent.session, undefined, SessionId('fork'))
    const agent = { ...parent, id: fork.id, session: fork }
    onTestFinished(ctx.agents.enter(agent, undefined))
    expect(names.nameOf(agent)).toBe('lead')
    using reservation = await names.reserve(agent, 'reviewer', signal)
    reservation.commit(SessionId('new'), () => { establishExternalCatalogChild(fork, SessionId('new'), 'Review', 'reviewer') })
    expect(await names.resolve(agent, 'reviewer')).toBe('new')
  })

  it('rejects a subagent header without a parent', async () => {
    const { ctx, parent, names } = await setup()
    const session = ctx.sessions.create(SessionId('orphan'), { meta: { origin: 'subagent' } })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    await expect(names.reserve(child, 'writer', signal)).rejects.toMatchObject({ code: 'AGENT_TREE_UNAVAILABLE' })
  })

  it('rejects stale callers, detached children, and a missing identity projection', async () => {
    const { ctx, parent, names } = await setup()
    expect(() => names.nameOf({ ...parent })).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    const session = ctx.sessions.create(SessionId('orphan'), { meta: { origin: 'subagent', parentSession: SessionId('missing') } })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    expect(names.nameOf(child)).toBe('legacy:orphan')
    await expect(names.reserve(child, 'writer', signal)).rejects.toMatchObject({ code: 'AGENT_TREE_UNAVAILABLE' })
    const nestedSession = ctx.sessions.create(SessionId('nested'), { meta: { origin: 'subagent', parentSession: parent.id } })
    const nested = { ...parent, id: nestedSession.id, session: nestedSession }
    onTestFinished(ctx.agents.enter(nested, undefined))
    const state = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    expect(() => names.nameOf(nested)).toThrow(expect.objectContaining({ code: 'CONTINUATION_UNAVAILABLE' }))
    state.mockRestore()
  })
})
