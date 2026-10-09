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

function timeline(turns: readonly TurnLocation[]): ConversationTimelineSnapshot {
  return { turnOrder: turns.map(value => value.turn), turns: new Map(turns.map(value => [value.turn, value])) }
}

describe('assembler-owned Chat bottom membership', () => {
  it('notifies only old and new bottom keys among 4,000 observed historical Nodes', () => {
    const builder = new ChatSnapshotBuilder()
    const turns = Array.from({ length: 4_000 }, (_, index) => turn(index + 1))
    const nodes = turns.map(value => node(value.turn, value))
    const snapshot = builder.replace({ nodes, timeline: timeline(turns) })
    builder.publish()
    const sources = nodes.map(value => snapshot.nodes.bottomSource(value.key))
    const listeners = sources.map((source) => {
      const listener = vi.fn()
      source.subscribe(listener)
      return listener
    })
    const nextTurn = turn(4_001)
    const nextNode = node(4_001, nextTurn)
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
    builder.apply({ upserts: [node(4_001, nextTurn, 'updated')], timeline: timeline([...turns, nextTurn]) })
    builder.publish()
    expect(nextChanged).not.toHaveBeenCalled()
    expect(listeners.at(-1)).toHaveBeenCalledOnce()
  })

  it('advances on a Turn boundary before its Node materializes and retains source identity across replacement', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const second = turn(2)
    const initial = builder.replace({ nodes: [node(1, first)], timeline: timeline([first]) })
    builder.publish()
    const oldBottom = initial.nodes.bottomSource('user:1')
    const nextBottom = initial.nodes.bottomSource('user:2')
    const changed = vi.fn()
    const unsubscribe = oldBottom.subscribe(changed)
    builder.apply({ upserts: [], timeline: timeline([first, second]) })
    builder.publish()
    expect(changed).toHaveBeenCalledOnce()
    expect(oldBottom.getSnapshot()).toBe(false)
    expect(nextBottom.getSnapshot()).toBe(false)
    builder.apply({ upserts: [node(2, second)], timeline: timeline([first, second]) })
    builder.publish()
    expect(nextBottom.getSnapshot()).toBe(true)
    unsubscribe()
    const replaced = builder.replace({ nodes: [node(1, first)], timeline: timeline([first]) })
    builder.publish()
    expect(replaced.nodes.bottomSource('user:1')).toBe(oldBottom)
    expect(oldBottom.getSnapshot()).toBe(true)
    expect(nextBottom.getSnapshot()).toBe(false)
    expect(changed).toHaveBeenCalledOnce()
  })

  it('updates same-key Turn moves without changing root order and excludes unplaced or hidden Nodes', () => {
    const builder = new ChatSnapshotBuilder()
    const first = turn(1)
    const second = turn(2)
    const initial = builder.replace({ nodes: [node(1, first)], timeline: timeline([first, second]) })
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
