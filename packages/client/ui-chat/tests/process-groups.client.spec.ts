import { describe, expect, it, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ConversationTimelineSnapshot, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { ProcessState } from '../src/client/conversation-nodes/process-groups.ts'
import { ConversationGroupStore } from '../../ui-conversation/src/client/conversation/group-store.ts'
import type { ProcessGroupData } from '../src/client/contract/process-groups.ts'

const turn: TurnLocation = {
  turn: 1, status: 'open', steps: [], end: undefined,
  start: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
  data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
}
const timeline: ConversationTimelineSnapshot = { turnOrder: [1], turns: new Map([[1, turn]]) }
const secondTurn: TurnLocation = {
  ...turn, turn: 2,
  start: { type: 'turn/start', seq: SessionSeq(10), time: 10, data: { turn: 2 } },
}
const twoTurns: ConversationTimelineSnapshot = { turnOrder: [1, 2], turns: new Map([[1, turn], [2, secondTurn]]) }

function assistant(text: string, response = ''): ChatNode<'assistant-step'> {
  return {
    key: 'assistant', id: 'assistant', kind: 'assistant-step', target: 'chat', anchorSeq: 2,
    location: { kind: 'turn', turn }, visibility: 'visible',
    data: {
      status: 'running', turn: 1, step: 1, time: 2,
      blocks: [{ kind: 'reasoning', text }, ...response === '' ? [] : [{ kind: 'text' as const, text: response }]],
    },
  }
}

function tool(key: string, seq: number, name = 'bash', owner = turn): ChatNode<'tool-call'> {
  return {
    key, id: key, kind: 'tool-call', target: 'chat', anchorSeq: seq,
    location: { kind: 'turn', turn: owner }, visibility: 'visible',
    data: { root: { phase: 'start' as const, callId: key, name, argsRaw: '{"command":"pwd"}', turn: owner.turn, step: 1, time: seq, subCalls: [] } },
  }
}

function separator(seq: number, inTurn: boolean): ChatNode<'user'> | ChatNode<'steering'> {
  const user: ChatNode<'user'> = {
    key: `user:${seq}`, id: `user:${seq}`, kind: 'user', target: 'chat', anchorSeq: seq,
    location: inTurn ? { kind: 'turn', turn } : { kind: 'session' }, visibility: 'visible',
    data: { kind: 'user', seq, time: seq, content: [{ type: 'text', text: 'continue' }], source: null },
  }
  return inTurn ? { ...user, kind: 'steering', data: { ...user.data, kind: 'steering', messageId: 'steer' as MessageId } } : user
}

function harness(nodes: ChatNode[], currentTimeline = timeline) {
  const builder = new ChatSnapshotBuilder()
  const state = new ProcessState()
  const store = new ConversationGroupStore<ProcessGroupData>()
  const commit = () => {
    const input = builder.groupInput()
    state.accept(input)
    const update = state.output()
    if (update !== null) store.prepareAndInstall(update, input.readNode)
    builder.publish()
    store.publish()
    return update
  }
  const snapshot = builder.replace({ nodes, timeline: currentTimeline })
  commit()
  return { builder, state, store, snapshot, commit }
}

describe('Definition-owned Chat process groups', () => {
  it('clears preparation from a closed group while retaining its recorded activity', () => {
    const preparing: ChatNode<'tool-call'> = {
      ...tool('call', 2, 'write'),
      data: { root: { phase: 'preparing', callId: 'call', name: 'write', turn: 1, step: 1, time: 2, subCalls: [] } },
    }
    const h = harness([preparing])
    const group = h.store.entries[0]!
    if (group.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(group.key)
    expect(source.getSnapshot()?.data.summary.preparing).toBe(true)
    h.builder.apply({ upserts: [separator(3, true)], timeline })
    h.commit()
    expect(source.getSnapshot()?.data).toEqual({
      turn: 1, closed: true,
      summary: { counts: [{ kind: 'write', count: 1 }], running: undefined, runningDetail: '' },
    })
  })

  it.each([
    ['read', 'read'], ['read_image', 'readImage'], ['write', 'write'], ['edit', 'edit'], ['apply_patch', 'edit'],
    ['todo_write', 'plan'], ['create_goal', 'plan'], ['update_goal', 'plan'], ['get_goal', 'plan'],
    ['list_mcp_resources', 'tools'], ['list_mcp_resource_templates', 'tools'], ['read_mcp_resource', 'tools'],
  ] as const)('%s keeps its activity category through preparation, dispatch, and result', (name, kind) => {
    const started = tool('call', 2, name)
    const preparing: ChatNode<'tool-call'> = {
      ...started,
      data: { root: { phase: 'preparing', callId: 'call', name, turn: 1, step: 1, time: 2, subCalls: [] } },
    }
    const h = harness([preparing])
    const group = h.store.entries[0]!
    if (group.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(group.key)
    expect(source.getSnapshot()?.data.summary).toEqual({
      counts: [{ kind, count: 1 }], running: kind, preparing: true, runningDetail: kind === 'tools' ? name : '',
    })
    h.builder.apply({ upserts: [started], timeline })
    h.commit()
    expect(source.getSnapshot()?.data.summary).toEqual({ counts: [{ kind, count: 1 }], running: kind, runningDetail: 'pwd' })
    const settled: ChatNode<'tool-call'> = {
      ...started,
      data: { root: {
        kind: 'tool-result', callId: 'call', seq: 3, time: 3, callTime: 2,
        call: { name, argsRaw: '{"command":"pwd"}' }, content: [], isError: false, subCalls: [],
      } },
    }
    h.builder.apply({ upserts: [settled], timeline })
    h.commit()
    expect(source.getSnapshot()?.data.summary).toEqual({ counts: [{ kind, count: 1 }], running: undefined, runningDetail: '' })
  })

  it('retains a group through repeated prepends and a later append', () => {
    const b = tool('b', 4)
    const c = tool('c', 6)
    const h = harness([b, c])
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(first.key)
    const a = tool('a', 3, 'read')
    h.builder.apply({ upserts: [a], timeline })
    h.commit()
    expect(h.store.entries).toEqual([first])
    expect(source.getSnapshot()?.members.map(member => member.key)).toEqual(['a', 'b', 'c'])

    const earlier = tool('earlier', 2)
    h.builder.replace({ nodes: [earlier, a, b, c], timeline })
    h.commit()
    expect(h.store.entries).toEqual([first])
    h.builder.apply({ upserts: [tool('later', 7)], timeline })
    h.commit()
    expect(h.store.entries).toEqual([first])
    expect(h.store.groupSource(first.key)).toBe(source)
    expect(source.getSnapshot()?.members.map(member => member.key)).toEqual(['earlier', 'a', 'b', 'c', 'later'])
  })

  it.each(['reply', 'steering'] as const)('keeps a %s boundary between newly loaded work and an existing group', (boundary) => {
    const h = harness([tool('retained', 4)])
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(first.key)
    const previous = source.getSnapshot()
    const upserts = boundary === 'reply' ? [assistant('older thought', 'older reply')]
      : [assistant('older thought'), separator(3, true)]
    h.builder.apply({ upserts, timeline })
    h.commit()
    expect(h.store.entries.map(entry => entry.kind)).toEqual(['group', 'node', 'group'])
    expect(h.store.entries[2]).toEqual(first)
    expect(source.getSnapshot()).toBe(previous)
  })

  it('splits an extended group without reusing one identity for two groups', () => {
    const h = harness([tool('b', 4), tool('c', 6)])
    h.builder.apply({ upserts: [tool('a', 2)], timeline })
    h.commit()
    h.builder.apply({ upserts: [separator(5, true)], timeline })
    h.commit()
    expect(h.store.entries.map(entry => entry.kind)).toEqual(['group', 'node', 'group'])
    const groups = h.store.entries.filter(entry => entry.kind === 'group')
    expect(new Set(groups.map(group => group.key)).size).toBe(2)
    expect(groups.map(group => h.store.groupSource(group.key).getSnapshot()?.members.map(member => member.key)))
      .toEqual([['a', 'b'], ['c']])
  })

  it('resegments only the changed Turn without notifying historical Node or Group sources', () => {
    const h = harness([tool('history', 2), tool('live', 12, 'read', secondTurn)], twoTurns)
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(first.key)
    const previous = source.getSnapshot()
    const groupChanged = vi.fn()
    const nodeChanged = vi.fn()
    const stopGroup = source.subscribe(groupChanged)
    const stopNode = h.snapshot.nodes.source('history').subscribe(nodeChanged)
    try {
      h.builder.apply({ upserts: [tool('new', 13, 'bash', secondTurn)], timeline: twoTurns })
      const input = h.builder.groupInput()
      const readNode = vi.fn(input.readNode)
      const readTurn = vi.fn(input.readTurn)
      h.state.accept({ ...input, readNode, readTurn })
      const update = h.state.output()
      if (update === null) throw new Error('expected new group member')
      h.store.prepareAndInstall(update, input.readNode)
      h.builder.publish()
      h.store.publish()
      expect(new Set(readTurn.mock.calls.map(([turn]) => turn))).toEqual(new Set([2]))
      expect(readNode.mock.calls.map(([key]) => key)).not.toContain('history')
      expect(source.getSnapshot()).toBe(previous)
      expect(groupChanged).not.toHaveBeenCalled()
      expect(nodeChanged).not.toHaveBeenCalled()
    } finally {
      stopGroup()
      stopNode()
    }
  })

  it('closes only the ended Turn without reading another Turn or rebuilding roots', () => {
    const h = harness([tool('history', 2), tool('live', 12, 'bash', secondTurn)], twoTurns)
    const roots = h.store.entries
    const ended: TurnLocation = {
      ...secondTurn, status: 'closed',
      end: { type: 'turn/end', seq: SessionSeq(14), time: 14, data: { turn: 2, reason: { kind: 'completed' } } },
    }
    h.builder.apply({
      upserts: [], timeline: { turnOrder: [1, 2], turns: new Map([[1, turn], [2, ended]]) }, changedTurns: [2],
    })
    const input = h.builder.groupInput()
    const readNode = vi.fn(input.readNode)
    const readTurn = vi.fn(input.readTurn)
    h.state.accept({ ...input, readNode, readTurn })
    const update = h.state.output()
    if (update === null) throw new Error('expected closed group')
    h.store.prepareAndInstall(update, input.readNode)
    h.store.publish()
    expect(readTurn).not.toHaveBeenCalled()
    expect(readNode.mock.calls.map(([key]) => key)).toEqual(['live'])
    expect(update.entries).toBeUndefined()
    expect(h.store.entries).toBe(roots)
  })

  it('splits and rejoins one Turn when an unscoped separator enters and leaves its order', () => {
    const h = harness([tool('a', 2), tool('b', 4)])
    const boundary = separator(3, false)
    h.builder.apply({ upserts: [boundary], timeline })
    const split = h.builder.groupInput()
    if (split.kind !== 'apply') throw new Error('expected apply')
    expect(split.changedTurnOrders).toEqual([1])
    h.commit()
    expect(h.store.entries.map(entry => entry.kind)).toEqual(['group', 'node', 'group'])
    h.builder.apply({ upserts: [{ ...boundary, visibility: 'hidden' }], timeline })
    h.commit()
    expect(h.store.entries.map(entry => entry.kind)).toEqual(['group'])
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    expect(h.store.groupSource(first.key).getSnapshot()?.members.map(member => member.key)).toEqual(['a', 'b'])
  })

  it('moves a group head between Turns in one atomic group update', () => {
    const h = harness([tool('moving', 2), tool('second', 12, 'bash', secondTurn)], twoTurns)
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    h.builder.apply({ upserts: [tool('moving', 2, 'bash', secondTurn)], timeline: twoTurns })
    h.commit()
    expect(h.store.entries).toEqual([first])
    expect(h.store.groupSource(first.key).getSnapshot()?.data.turn).toBe(2)
    expect(h.store.groupSource(first.key).getSnapshot()?.members.map(member => member.key)).toEqual(['moving', 'second'])
  })

  it('rereads only the changed group on a content update', () => {
    const h = harness([tool('history', 2, 'read'), separator(3, true), tool('live', 4)])
    const history = h.store.entries[0]!
    if (history.kind !== 'group') throw new Error('expected group')
    const previous = h.store.groupSource(history.key).getSnapshot()
    const live = tool('live', 4)
    h.builder.apply({
      upserts: [{ ...live, data: { root: { ...live.data.root, argsRaw: '{"command":"ls"}' } } }],
      timeline,
    })
    const input = h.builder.groupInput()
    const readNode = vi.fn(input.readNode)
    h.state.accept({ ...input, readNode })
    const update = h.state.output()
    if (update === null) throw new Error('expected updated detail')
    h.store.prepareAndInstall(update, input.readNode)
    h.store.publish()
    expect(readNode.mock.calls.map(([key]) => key)).toEqual(['live'])
    expect(update.entries).toBeUndefined()
    expect(h.store.groupSource(history.key).getSnapshot()).toBe(previous)
    expect(h.state.output()).toBe(update)
  })

  it('rebuilds ranges while retaining unchanged groups and recomputing category order', () => {
    const a = tool('a', 2, 'read')
    const b = tool('b', 3)
    const c = tool('c', 4)
    const h = harness([a, b, c, separator(5, true), tool('later', 6)])
    const first = h.store.entries[0]!
    const last = h.store.entries[2]!
    if (first.kind !== 'group' || last.kind !== 'group') throw new Error('expected groups')
    const lastSnapshot = h.store.groupSource(last.key).getSnapshot()
    expect(h.store.groupSource(first.key).getSnapshot()?.data.summary.counts).toEqual([
      { kind: 'commands', count: 2 }, { kind: 'read', count: 1 },
    ])
    h.builder.apply({ upserts: [{ ...c, visibility: 'hidden' }], timeline })
    h.commit()
    expect(h.store.groupSource(first.key).getSnapshot()?.data.summary.counts).toEqual([
      { kind: 'read', count: 1 }, { kind: 'commands', count: 1 },
    ])
    expect(h.store.groupSource(last.key).getSnapshot()).toBe(lastSnapshot)
  })

  it('restores live detail when replacement removes a closing separator', () => {
    const a = tool('a', 2)
    const h = harness([a, separator(3, false)])
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(first.key)
    expect(source.getSnapshot()?.data.closed).toBe(true)
    expect(source.getSnapshot()?.data.summary.runningDetail).toBe('')
    h.builder.replace({ nodes: [a], timeline })
    h.commit()
    expect(source.getSnapshot()?.data.closed).toBe(false)
    expect(source.getSnapshot()?.data.summary.running).toBe('commands')
    expect(source.getSnapshot()?.data.summary.runningDetail).toBe('pwd')
  })

  it('splits reasoning from replies and starts later groups after tools and steering in one Step', () => {
    const { store } = harness([separator(0, true), assistant('think', 'progress'), tool('a', 3), separator(4, true), tool('b', 5)])
    expect(store.entries.map(entry => entry.kind)).toEqual(['node', 'group', 'node', 'group', 'node', 'group'])
    const groups = store.entries.filter(entry => entry.kind === 'group')
    expect(groups).toHaveLength(3)
    expect(store.groupSource(groups[0]!.key).getSnapshot()?.members).toEqual([
      { kind: 'node', key: 'assistant', groupPart: 'reasoning' },
    ])
    expect(store.entries[2]).toEqual({ kind: 'node', key: 'assistant', groupPart: 'response' })
    expect(store.groupSource(groups[1]!.key).getSnapshot()?.members.map(member => member.key)).toEqual(['a'])
    expect(store.groupSource(groups[2]!.key).getSnapshot()?.members.map(member => member.key)).toEqual(['b'])
  })

  it('updates live detail without replacing roots or members and closes on the first reply', () => {
    const h = harness([assistant('first thought')])
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(first.key)
    const entries = h.store.entries
    const members = source.getSnapshot()!.members
    h.builder.apply({ upserts: [assistant('second thought')], timeline })
    expect(h.commit()?.entries).toBeUndefined()
    expect(h.store.entries).toBe(entries)
    expect(source.getSnapshot()!.members).toBe(members)
    expect(source.getSnapshot()!.data.summary.runningDetail).toBe('second thought')
    h.builder.apply({ upserts: [assistant('second thought', 'reply')], timeline })
    h.commit()
    expect(h.store.entries[0]).toEqual(first)
    expect(source.getSnapshot()!.data.closed).toBe(true)
    expect(h.store.entries[1]).toMatchObject({ kind: 'node', groupPart: 'response' })
    const closed = source.getSnapshot()
    const completed = assistant('second thought', 'settled reply')
    h.builder.apply({ upserts: [{ ...completed, data: { ...completed.data, status: 'settled' } }], timeline })
    expect(h.commit()).toBeNull()
    expect(source.getSnapshot()).toBe(closed)
  })

  it('keeps a no-Turn row between groups and repairs membership on replacement', () => {
    const a = tool('a', 2)
    const b = tool('b', 4)
    const h = harness([a, separator(3, false), b])
    expect(h.store.entries.map(entry => entry.kind)).toEqual(['group', 'node', 'group'])
    const removed = h.store.entries[2]!
    if (removed.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(removed.key)
    const head = h.store.entries[0]!
    if (head.kind !== 'group') throw new Error('expected group')
    h.builder.apply({ upserts: [{ ...b, visibility: 'hidden' }], timeline })
    h.commit()
    expect(h.store.entries).toHaveLength(2)
    expect(h.store.groupSource(head.key).getSnapshot()?.data.closed).toBe(true)
    expect(source.getSnapshot()).toBeUndefined()
    h.builder.replace({ nodes: [a, b], timeline })
    h.commit()
    expect(h.store.entries).toHaveLength(1)
    expect(source.getSnapshot()).toBeUndefined()
    expect(h.builder.groupInput().order).toHaveLength(2)
  })

  it('closes an active group on a lifecycle-only update', () => {
    const h = harness([tool('a', 2)])
    const first = h.store.entries[0]!
    if (first.kind !== 'group') throw new Error('expected group')
    const source = h.store.groupSource(first.key)
    const ended: TurnLocation = {
      ...turn, status: 'closed',
      end: { type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    }
    h.builder.apply({ upserts: [], timeline: { turnOrder: [1], turns: new Map([[1, ended]]) }, changedTurns: [1] })
    expect(h.commit()?.entries).toBeUndefined()
    expect(source.getSnapshot()?.data.closed).toBe(true)
  })
})
