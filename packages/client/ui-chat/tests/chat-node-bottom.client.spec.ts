import { describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import type { ConversationTimelineSnapshot, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

function turn(index: number): TurnLocation {
  return {
    turn: index, start: undefined, end: undefined, status: 'closed', steps: [],
    data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
  }
}

function node(index: number, owner = turn(index), text = ''): ChatConversationViewNode {
  return {
    key: `user:${index}`, id: String(index), kind: 'user', target: 'chat', anchorSeq: index,
    visibility: 'visible', location: { kind: 'turn', turn: owner },
    data: { kind: 'user', messageId: `message:${index}`, seq: index, time: index, content: [{ type: 'text', text }], source: null },
  }
}

/** A Node whose Turn opens an exchange. */
function opening(index: number, owner = turn(index), text = ''): ChatConversationViewNode {
  return { ...node(index, owner, text), groupTree: 'exchange' }
}

function timeline(turns: readonly TurnLocation[]): ConversationTimelineSnapshot {
  return { turnOrder: turns.map(value => value.turn), turns: new Map(turns.map(value => [value.turn, value])) }
}

describe('assembler-owned Chat bottom membership', () => {
  it('notifies only the Turns leaving or entering the latest exchange among 4,000 observed historical Nodes', () => {
    const builder = new ChatSnapshotBuilder()
    const turns = Array.from({ length: 4_000 }, (_, index) => turn(index + 1))
    const nodes = turns.map(value => opening(value.turn, value))
    const snapshot = builder.replace({ nodes, timeline: timeline(turns) })
    builder.publish()
    const sources = nodes.map(value => snapshot.nodes.bottomSource(value.key))
    const listeners = sources.map((source) => {
      const listener = vi.fn()
      source.subscribe(listener)
      return listener
    })
    const nextTurn = turn(4_001)
    const nextNode = opening(4_001, nextTurn)
    const nextSource = snapshot.nodes.bottomSource(nextNode.key)
    const nextChanged = vi.fn()
    nextSource.subscribe(nextChanged)
    expect(sources.at(-1)?.getSnapshot()).toBe(true)
    expect(nextSource.getSnapshot()).toBe(false)

    builder.apply({ upserts: [nextNode], timeline: timeline([...turns, nextTurn]) })
    expect(listeners.every(listener => listener.mock.calls.length === 0)).toBe(true)
    expect(nextChanged).not.toHaveBeenCalled()
    builder.publish()
    expect(listeners.slice(0, -1).every(listener => listener.mock.calls.length === 0)).toBe(true)
    expect(listeners.at(-1)).toHaveBeenCalledOnce()
    expect(nextChanged).toHaveBeenCalledOnce()
    expect(sources.at(-1)?.getSnapshot()).toBe(false)
    expect(nextSource.getSnapshot()).toBe(true)
    expect(snapshot.nodes.bottomSource(nextNode.key)).toBe(nextSource)

    nextChanged.mockClear()
    builder.apply({ upserts: [opening(4_001, nextTurn, 'updated')], timeline: timeline([...turns, nextTurn]) })
    builder.publish()
    expect(nextChanged).not.toHaveBeenCalled()
    expect(listeners.at(-1)).toHaveBeenCalledOnce()
  })

  it('keeps a bare Turn boundary and continuation Turns in the latest exchange until an opening Node arrives', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const second = turn(2)
    const initial = builder.replace({ nodes: [opening(1, first)], timeline: timeline([first]) })
    builder.publish()
    const oldBottom = initial.nodes.bottomSource('user:1')
    const nextBottom = initial.nodes.bottomSource('user:2')
    const changed = vi.fn()
    const unsubscribe = oldBottom.subscribe(changed)
    builder.apply({ upserts: [], timeline: timeline([first, second]) })
    builder.publish()
    expect(changed).not.toHaveBeenCalled()
    expect(oldBottom.getSnapshot()).toBe(true)

    builder.apply({ upserts: [node(2, second)], timeline: timeline([first, second]) })
    builder.publish()
    expect(changed).not.toHaveBeenCalled()
    expect([oldBottom.getSnapshot(), nextBottom.getSnapshot()]).toEqual([true, true])

    builder.apply({ upserts: [opening(2, second)], timeline: timeline([first, second]) })
    builder.publish()
    expect(changed).toHaveBeenCalledOnce()
    expect([oldBottom.getSnapshot(), nextBottom.getSnapshot()]).toEqual([false, true])
    unsubscribe()

    const replaced = builder.replace({ nodes: [opening(1, first)], timeline: timeline([first]) })
    builder.publish()
    expect(replaced.nodes.bottomSource('user:1')).toBe(oldBottom)
    expect([oldBottom.getSnapshot(), nextBottom.getSnapshot()]).toEqual([true, false])

    builder.replace({ nodes: [node(1, first), node(2, second)], timeline: timeline([first, second]) })
    builder.publish()
    expect([oldBottom.getSnapshot(), nextBottom.getSnapshot()]).toEqual([true, true])
  })

  it('starts the latest exchange at the first loaded Turn while no opening Node is loaded', () => {
    const builder = new ChatSnapshotBuilder()
    const turns = [turn(3), turn(4), turn(5)]
    const initial = builder.replace({ nodes: turns.map(value => node(value.turn, value)), timeline: timeline(turns) })
    builder.publish()
    const bottoms = ['user:3', 'user:4', 'user:5'].map(key => initial.nodes.bottomSource(key))
    expect(bottoms.map(source => source.getSnapshot())).toEqual([true, true, true])

    const older = [turn(1), turn(2), ...turns]
    const loaded = builder.replace({ nodes: older.map(value => node(value.turn, value)), timeline: timeline(older) })
    builder.publish()
    expect(['user:1', 'user:2'].map(key => loaded.nodes.bottomSource(key).getSnapshot())).toEqual([true, true])

    builder.replace({ nodes: [], timeline: timeline([]) })
    builder.publish()
    expect(bottoms.map(source => source.getSnapshot())).toEqual([false, false, false])
  })

  it('follows the latest remaining opening Turn when opening Nodes leave, move, or repeat in one Turn', () => {
    const builder = new ChatSnapshotBuilder()
    const turns = [turn(1), turn(2), turn(3), turn(4)]
    const second: ChatConversationViewNode = { ...opening(22, turns[1]), key: 'user:2b' }
    const nodes = [opening(1, turns[0]), opening(2, turns[1]), second, node(3, turns[2]), opening(4, turns[3])]
    const initial = builder.replace({ nodes, timeline: timeline(turns) })
    builder.publish()
    const bottom = (key: string): boolean => initial.nodes.bottomSource(key).getSnapshot()
    const membership = (): boolean[] => ['user:1', 'user:2', 'user:3', 'user:4'].map(bottom)
    expect(membership()).toEqual([false, false, false, true])

    const before = vi.fn()
    const unchanged = vi.fn()
    initial.nodes.bottomSource('user:2').subscribe(before)
    initial.nodes.bottomSource('user:1').subscribe(unchanged)
    builder.apply({ upserts: [node(4, turns[3])], timeline: initial.timeline })
    builder.publish()
    expect(membership()).toEqual([false, true, true, true])
    expect(before).toHaveBeenCalledOnce()
    expect(unchanged).not.toHaveBeenCalled()

    builder.apply({ upserts: [node(2, turns[1])], timeline: initial.timeline })
    builder.publish()
    expect(membership()).toEqual([false, true, true, true])

    builder.apply({ upserts: [{ ...second, location: { kind: 'session' } }], timeline: initial.timeline })
    builder.publish()
    expect(membership()).toEqual([true, true, true, true])

    builder.apply({ upserts: [{ ...opening(3, turns[2]), visibility: 'hidden' }], timeline: initial.timeline })
    builder.publish()
    expect(membership()).toEqual([false, false, false, true])
    expect(bottom('user:2b')).toBe(false)

    builder.replace({ nodes: [opening(1, turns[0]), node(2, turns[1]), node(4, turns[3])], timeline: initial.timeline })
    builder.publish()
    expect(membership()).toEqual([true, true, false, true])
  })

  it('updates same-key Turn moves without changing root order and excludes unplaced or hidden Nodes', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const second = turn(2)
    const initial = builder.replace({ nodes: [node(1, first), opening(2, second)], timeline: timeline([first, second]) })
    builder.publish()
    const bottom = initial.nodes.bottomSource('user:1')
    expect(bottom.getSnapshot()).toBe(false)
    const moved = builder.apply({ upserts: [node(1, second)], timeline: initial.timeline })
    builder.publish()
    expect(moved.order).toBe(initial.order)
    expect(bottom.getSnapshot()).toBe(true)
    builder.apply({ upserts: [{ ...node(1, second), visibility: 'hidden' }], timeline: initial.timeline })
    builder.publish()
    expect(bottom.getSnapshot()).toBe(false)
    builder.apply({ upserts: [{ ...node(1), location: { kind: 'session' } }], timeline: initial.timeline })
    builder.publish()
    expect(bottom.getSnapshot()).toBe(false)
    expect(initial.nodes.bottomSource('missing').getSnapshot()).toBe(false)
    expect(new ChatSnapshotBuilder().empty.nodes.bottomSource('user:1').getSnapshot()).toBe(false)
  })
})
