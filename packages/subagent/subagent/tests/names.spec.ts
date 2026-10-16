import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import { SubagentNames, subagentNamesProjectionDefinition } from '../src/names.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { TestSessionQuery } from './test-session-query.ts'

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
    using first = names.reserve(parent, 'reviewer')
    first.commit(SessionId('first'))
    using second = names.reserve(other, 'reviewer')
    second.commit(SessionId('second'))
    expect(await names.resolve(parent, 'reviewer')).toBe('first')
    expect(await names.resolve(other, 'reviewer')).toBe('second')
  })

  it.each(['lead', 'unowned', '', 'Reviewer', 'has space', '1worker', 'legacy:old'])(
    'rejects invalid or reserved creation name %j before writing a fact', async (name) => {
      const { parent, names } = await setup()
      const seq = parent.session.seq
      expect(() => names.reserve(parent, name)).toThrow(expect.objectContaining({ code: 'INVALID_AGENT_NAME' }))
      expect(parent.session.seq).toBe(seq)
    },
  )

  it('rejects duplicates across nested parents and retains assignments after release', async () => {
    const { ctx, parent, names } = await setup()
    const session = ctx.sessions.create(SessionId('nested'), { meta: { origin: 'subagent', parentSession: parent.id } })
    const nested = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(nested, undefined))
    {
      using reservation = names.reserve(parent, 'reviewer')
      expect(() => names.reserve(nested, 'reviewer')).toThrow(expect.objectContaining({ code: 'DUPLICATE_AGENT_NAME' }))
      reservation.commit(session.id)
    }
    expect(names.nameOf(nested)).toBe('reviewer')
    expect(() => names.reserve(nested, 'reviewer')).toThrow(expect.objectContaining({ code: 'DUPLICATE_AGENT_NAME' }))
    expect(await names.resolve(nested, 'lead')).toBe(parent.id)
    const restoredManager = new SubagentNames(ctx)
    expect(await restoredManager.resolve(parent, 'reviewer')).toBe(session.id)
    expect(() => restoredManager.reserve(parent, 'reviewer')).toThrow(expect.objectContaining({ code: 'DUPLICATE_AGENT_NAME' }))
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
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start,
    })
    const spec = {
      name: 'reviewer', provider: 'external', label: 'review', delivery: 'caller' as const,
      request: { parent, prompt: [{ type: 'text' as const, text: 'Review' }] },
      signal: new AbortController().signal,
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
    expect(parent.session.snapshotEvents().filter(event => event.type === 'subagent/named')).toEqual([])
  })

  it('resolves historical addresses only for unnamed descendants in the same tree', async () => {
    const { ctx, parent, names } = await setup()
    const child = ctx.sessions.create(SessionId('old-child'), { meta: { origin: 'subagent', parentSession: parent.id } })
    parent.session.append('subagent/catalog', {
      version: 0, childId: child.id, childCreatedAt: 0, mode: 'continuable', label: 'Old child',
    })
    expect(names.nameOf(parent, child.id)).toBe('legacy:old-child')
    expect(await names.resolve(parent, 'legacy:old-child')).toBe(child.id)
    await expect(names.resolve(parent, 'legacy:missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    await expect(names.resolve(parent, 'missing')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    using reservation = names.reserve(parent, 'reviewer')
    reservation.commit(child.id)
    await expect(names.resolve(parent, 'legacy:old-child')).rejects.toMatchObject({ code: 'AGENT_NAME_NOT_FOUND' })
    const aborted = AbortSignal.abort(new Error('cancel lookup'))
    await expect(names.resolve(parent, 'lead', aborted)).rejects.toThrow('cancel lookup')
  })

  it('rejects stale callers and a detached child instead of treating it as a new root', async () => {
    const { ctx, parent, names } = await setup()
    expect(() => names.nameOf({ ...parent })).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    const session = ctx.sessions.create(SessionId('orphan'), {
      meta: { origin: 'subagent', parentSession: SessionId('missing') },
    })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    expect(() => names.nameOf(child)).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
  })

  it('refuses publication after ancestor replacement and missing naming state', async () => {
    const { ctx, parent, names } = await setup()
    const session = ctx.sessions.create(SessionId('nested'), { meta: { origin: 'subagent', parentSession: parent.id } })
    const child = { ...parent, id: session.id, session }
    onTestFinished(ctx.agents.enter(child, undefined))
    using reservation = names.reserve(child, 'reviewer')
    const get = ctx.agents.get.bind(ctx.agents)
    const replacement = { ...parent }
    const lookup = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === parent.id ? replacement : get(id))
    expect(() => { reservation.commit(SessionId('new-child')) }).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
    lookup.mockRestore()
    const state = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    expect(() => names.reserve(parent, 'other')).toThrow(expect.objectContaining({ code: 'CONTINUATION_UNAVAILABLE' }))
    state.mockRestore()
    const orphan = ctx.sessions.create(SessionId('no-parent'), { meta: { origin: 'subagent' } })
    const detached = { ...parent, id: orphan.id, session: orphan }
    onTestFinished(ctx.agents.enter(detached, undefined))
    expect(() => names.nameOf(detached)).toThrow(expect.objectContaining({ code: 'AGENT_TREE_UNAVAILABLE' }))
  })

  it('ignores fork-inherited names and refuses duplicate durable names or identities', async () => {
    const { parent } = await setup()
    const event = { type: 'subagent/named' as const, seq: SessionSeq(0), time: 0, data: { name: 'reviewer', id: SessionId('child') } }
    const inherited = subagentNamesProjectionDefinition.init(parent.session.header, SessionLogOffset(1))
    expect(subagentNamesProjectionDefinition.apply(inherited, event)).toBe(inherited)
    const empty = subagentNamesProjectionDefinition.init(parent.session.header, SessionLogOffset(0))
    const state = subagentNamesProjectionDefinition.apply(empty, event)
    expect(subagentNamesProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    for (const data of [{ name: 'reviewer', id: SessionId('other') }, { name: 'writer', id: SessionId('child') }]) {
      expect(subagentNamesProjectionDefinition.stateSchema.safeParse({ ...state, entries: [...state.entries, data] }).success).toBe(false)
      expect(() => subagentNamesProjectionDefinition.apply(state, { ...event, data, seq: SessionSeq(1) }))
        .toThrow(expect.objectContaining({ code: 'CORRUPT_AGENT_NAMES' }))
    }
  })
})
