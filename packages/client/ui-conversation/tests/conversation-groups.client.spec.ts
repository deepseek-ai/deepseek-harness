import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  ConversationTimelineSnapshot, ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode,
} from '../src/client/contract/conversation.ts'
import type {
  ConversationGroupDefinition, ConversationGroupInput, GroupKey, GroupUpdate, NodeKey,
} from '../src/client/contract/groups.ts'
import { ConversationNodeAssembler } from '../src/client/conversation/assembler.ts'
import { ConversationGroupRegistry } from '../src/client/conversation/group-registry.ts'
import { ConversationViewRegistry } from '../src/client/conversation/view-registry.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationGroupDataMap {
    'group-test': number
  }
}

const groupKey = brandString<GroupKey>('group')
const noEvents = { entries: () => [], fallbackEntry: () => undefined }

class GroupTestBuilder implements ConversationViewBuilder<ConversationViewNode, ReadonlyMap<string, ConversationViewNode>> {
  readonly empty = new Map<string, ConversationViewNode>()
  readonly nodes = new Map<string, ConversationViewNode>()
  readonly publish = vi.fn()
  private readonly readers = {
    readNode: (key: NodeKey) => this.nodes.get(key),
    readTurn: (_turn: number): readonly NodeKey[] => [],
    readPosition: (key: NodeKey) => {
      const index = this.input.order.indexOf(key)
      if (index < 0) return undefined
      return {
        turn: undefined,
        previous: this.input.order[index - 1],
        next: this.input.order[index + 1],
      }
    },
  }
  private input: ConversationGroupInput<ConversationViewNode> = {
    kind: 'replace', order: [], ...this.readers, timeline: { turnOrder: [], turns: new Map() },
  }

  replace({ nodes, timeline }: { nodes: readonly ConversationViewNode[]; timeline: ConversationTimelineSnapshot }) {
    this.nodes.clear()
    for (const node of nodes) this.nodes.set(node.key, node)
    this.input = { kind: 'replace', order: [...this.nodes.keys()] as NodeKey[], ...this.readers, timeline }
    return this.nodes
  }

  apply({ upserts, timeline, changedTurns = [] }: {
    upserts: readonly ConversationViewNode[]
    timeline: ConversationTimelineSnapshot
    changedTurns?: readonly number[]
  }) {
    const changes = upserts.map(current => ({ previous: this.nodes.get(current.key), current }))
    for (const node of upserts) this.nodes.set(node.key, node)
    this.input = {
      kind: 'apply', changes, changedTurns, changedTurnOrders: [],
      order: [...this.nodes.keys()] as NodeKey[], ...this.readers, timeline,
    }
    return this.nodes
  }

  groupInput() { return this.input }
}

function grouping(seen: ConversationGroupInput<ConversationViewNode>[] = []) {
  return {
    kind: 'test-group',
    target: 'group-test' as const,
    create: (): ConversationGroupInput<ConversationViewNode> | null => null,
    update: (_context, input) => { seen.push(input); return input },
    buildGroups: ({ state }) => state === null ? null : {
      entries: [{ kind: 'group', key: groupKey }],
      groups: {
        kind: 'replace',
        snapshots: [{
          key: groupKey,
          data: state.timeline.turns.get(1)?.status === 'closed' ? 1 : 0,
          members: state.order.map(key => ({ kind: 'node', key })),
        }],
      },
    },
  } satisfies ConversationGroupDefinition<ConversationViewNode, ConversationGroupInput<ConversationViewNode> | null, number>
}

function start(seq: number, turn = 1): SessionEvent<'turn/start'> {
  return { seq: SessionSeq(seq), time: seq, type: 'turn/start', data: { turn } }
}

function setup(definition: ConversationGroupDefinition = grouping()) {
  const builder = new GroupTestBuilder()
  const create = vi.fn(() => builder)
  let groupDefinitions = [definition]
  const views = [{ target: 'group-test', create }]
  const groups = {
    entries: () => groupDefinitions,
    forTarget: (target: string) => groupDefinitions.find(candidate => candidate.target === target),
  }
  const assembler = new ConversationNodeAssembler(noEvents, { entries: () => views }, groups)
  return {
    assembler, builder, create, views,
    removeGroups: () => { groupDefinitions = [] },
    replaceGroup: (next: ConversationGroupDefinition) => { groupDefinitions = [next] },
  }
}

describe('group Definition dispatch', () => {
  it('creates grouping on first activation without eagerly constructing a Builder', () => {
    const seen: ConversationGroupInput<ConversationViewNode>[] = []
    const { assembler, builder, create } = setup(grouping(seen))
    assembler.replaceWindow([{ type: 'event', event: start(1) }], false)
    expect(assembler.flush()).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(assembler.grouped('group-test')).toBeUndefined()
    builder.publish.mockImplementation(() => {
      expect(assembler.snapshot('group-test')).toBe(builder.nodes)
      expect(assembler.grouped('group-test')?.groupSource(groupKey).getSnapshot()?.data).toBe(0)
    })
    expect(assembler.activateTarget('group-test')).toBe(true)
    expect(create).toHaveBeenCalledOnce()
    expect(seen.map(input => input.kind)).toEqual(['replace'])
    expect(builder.publish).toHaveBeenCalledOnce()
    expect(assembler.activateTarget('group-test')).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('delivers lifecycle changes without Node upserts and installs groups before publication', () => {
    const seen: ConversationGroupInput<ConversationViewNode>[] = []
    const { assembler, builder } = setup(grouping(seen))
    assembler.replaceWindow([{ type: 'event', event: start(1) }], false)
    assembler.activateTarget('group-test')
    const grouped = assembler.grouped('group-test')!
    const entries = grouped.entries
    const source = grouped.groupSource(groupKey)
    const changed = vi.fn()
    source.subscribe(changed)
    const end: SessionEvent<'turn/end'> = { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }
    assembler.append({ type: 'event', event: end })
    builder.publish.mockImplementation(() => { expect(source.getSnapshot()?.data).toBe(1) })
    assembler.flush()
    const input = seen.at(-1)!
    expect(input.kind).toBe('apply')
    if (input.kind !== 'apply') throw new Error('expected apply')
    expect(input.changes).toEqual([])
    expect(input.changedTurns).toEqual([1])
    expect(grouped.entries).toBe(entries)
    expect(changed).toHaveBeenCalledOnce()
    expect(assembler.flush()).toBe(false)
  })

  it('rebuilds through the same path and invalidates sources when grouping is removed', () => {
    const seen: ConversationGroupInput<ConversationViewNode>[] = []
    const { assembler, removeGroups } = setup(grouping(seen))
    assembler.activateTarget('group-test')
    const source = assembler.grouped('group-test')!.groupSource(groupKey)
    const changed = vi.fn()
    source.subscribe(changed)
    assembler.rebuildRegistry()
    assembler.flush()
    expect(seen.map(input => input.kind)).toEqual(['replace', 'replace'])
    expect(assembler.grouped('group-test')!.groupSource(groupKey)).toBe(source)
    removeGroups()
    assembler.rebuildRegistry()
    assembler.flush()
    expect(source.getSnapshot()).toBeUndefined()
    expect(assembler.grouped('group-test')).toBeUndefined()
    expect(changed).toHaveBeenCalledOnce()
  })

  it('does not ask ungrouped Builders for grouping input', () => {
    const builder = new GroupTestBuilder()
    const input = vi.spyOn(builder, 'groupInput')
    const assembler = new ConversationNodeAssembler(noEvents, { entries: () => [{ target: 'group-test', create: () => builder }] })
    assembler.activateTarget('group-test')
    expect(input).not.toHaveBeenCalled()
  })

  it('keeps the installed group context until the registry rebuild replaces it', () => {
    const first = grouping()
    const firstUpdate = vi.spyOn(first, 'update')
    const next = grouping()
    const nextCreate = vi.spyOn(next, 'create')
    const { assembler, replaceGroup } = setup(first)
    assembler.activateTarget('group-test')
    const source = assembler.grouped('group-test')!.groupSource(groupKey)
    const changed = vi.fn()
    source.subscribe(changed)
    replaceGroup(next)
    assembler.append({ type: 'event', event: start(1) })
    assembler.flush()
    expect(firstUpdate).toHaveBeenCalledTimes(2)
    expect(nextCreate).not.toHaveBeenCalled()
    assembler.rebuildRegistry()
    assembler.flush()
    expect(nextCreate).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toBeUndefined()
    expect(changed).toHaveBeenCalledOnce()
    expect(assembler.grouped('group-test')!.groupSource(groupKey)).not.toBe(source)
  })

  it('keeps published grouping when a later buildGroups returns null', () => {
    const definition = grouping()
    const build = vi.spyOn(definition, 'buildGroups')
    const { assembler } = setup(definition)
    assembler.activateTarget('group-test')
    const grouped = assembler.grouped('group-test')!
    const root = grouped.entries
    const source = grouped.groupSource(groupKey)
    const value = source.getSnapshot()
    const changed = vi.fn()
    source.subscribe(changed)
    build.mockReturnValueOnce(null)
    assembler.append({ type: 'event', event: start(1) })
    assembler.flush()
    expect(grouped.entries).toBe(root)
    expect(source.getSnapshot()).toBe(value)
    expect(changed).not.toHaveBeenCalled()
  })

  it('rejects a missing Builder input method only after target activation', () => {
    const create = vi.fn(() => ({ empty: null, replace: () => null, apply: () => null }))
    const definition = grouping()
    const assembler = new ConversationNodeAssembler(noEvents, { entries: () => [{ target: 'group-test', create }] }, {
      entries: () => [definition], forTarget: () => definition,
    })
    expect(create).not.toHaveBeenCalled()
    expect(() => assembler.activateTarget('group-test')).toThrow('requires builder.groupInput()')
  })

  it('requires complete grouping for replacement input', () => {
    const definition = grouping()
    const missing = setup({ ...definition, buildGroups: () => null })
    expect(() => missing.assembler.activateTarget('group-test')).toThrow('complete grouping for replacement input')
    const retained = grouping()
    const build = vi.spyOn(retained, 'buildGroups')
    const { assembler } = setup(retained)
    assembler.activateTarget('group-test')
    build.mockReturnValueOnce(null)
    assembler.replaceWindow([], false)
    expect(() => assembler.flush()).toThrow('complete grouping for replacement input')
  })

  it.each<GroupUpdate<number>>([
    { groups: { kind: 'replace', snapshots: [] } },
    { entries: [], groups: { kind: 'apply', upserts: [], removes: [] } },
  ])('rejects incomplete grouping for replacement input: %j', (update) => {
    const { assembler } = setup({ ...grouping(), buildGroups: () => update })
    expect(() => assembler.activateTarget('group-test')).toThrow('complete grouping for replacement input')
  })

  it('pauses grouping when its View disappears and rebuilds when the View returns', () => {
    const seen: ConversationGroupInput<ConversationViewNode>[] = []
    const definition = grouping(seen)
    const createGroup = vi.spyOn(definition, 'create')
    const { assembler, views, create } = setup(definition)
    assembler.activateTarget('group-test')
    const source = assembler.grouped('group-test')!.groupSource(groupKey)
    const changed = vi.fn()
    source.subscribe(changed)

    const view = views.pop()!
    assembler.rebuildRegistry()
    expect(assembler.flush()).toBe(true)
    expect(assembler.snapshot('group-test')).toBeUndefined()
    expect(assembler.grouped('group-test')).toBeUndefined()
    expect(source.getSnapshot()).toBeUndefined()
    expect(changed).toHaveBeenCalledOnce()

    assembler.append({ type: 'event', event: start(1) })
    assembler.flush()
    expect(seen).toHaveLength(1)
    expect(createGroup).toHaveBeenCalledOnce()
    views.push(view)
    assembler.rebuildRegistry()
    assembler.flush()
    expect(create).toHaveBeenCalledTimes(2)
    expect(createGroup).toHaveBeenCalledTimes(2)
    expect(seen.map(input => input.kind)).toEqual(['replace', 'replace'])
    expect(seen.at(-1)?.timeline.turns.has(1)).toBe(true)
    expect(assembler.grouped('group-test')!.groupSource(groupKey).getSnapshot()?.data).toBe(0)
  })

  it('registers grouping without creating its Builder and disposes it with its effect', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const views = new ConversationViewRegistry(ctx)
    const groups = new ConversationGroupRegistry(ctx, views)
    const definition = grouping()
    expect(() => groups.register(definition)).toThrow('is not registered')
    const create = vi.fn(() => new GroupTestBuilder())
    views.register({ target: 'group-test', create } satisfies ConversationViewDefinition)
    const changed = vi.fn()
    const unsubscribe = groups.subscribe(changed)
    const dispose = groups.register(definition)
    expect(create).not.toHaveBeenCalled()
    expect(groups.forTarget('group-test')).toBe(definition)
    expect(() => groups.register(definition)).toThrow('already registered')
    dispose()
    dispose()
    expect(groups.forTarget('group-test')).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    groups.register(definition)
    await ctx.fiber.dispose()
    expect(groups.entries()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
