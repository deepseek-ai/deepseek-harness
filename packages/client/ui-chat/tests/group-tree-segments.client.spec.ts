import { describe, expect, it } from 'vitest'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import { isAtOrOutside, type ChatGroupTree } from '../src/client/contract/group-tree.ts'
import { GroupTreeSegments } from '../src/client/conversation-nodes/group-tree-segments.ts'

function turn(index: number): TurnLocation {
  return {
    turn: index, start: undefined, end: undefined, status: 'closed', steps: [],
    data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
  }
}

function node(key: string, owner: number | undefined, groupTree?: ChatGroupTree): ChatConversationViewNode {
  return {
    key, id: key, kind: 'user', target: 'chat', anchorSeq: 0, visibility: 'hidden', groupTree,
    location: owner === undefined ? { kind: 'session' } : { kind: 'turn', turn: turn(owner) },
    data: null,
  }
}

function members(segments: GroupTreeSegments, turns: readonly number[]): number[] {
  return turns.filter(value => segments.inLatest(value))
}

describe('Chat group tree', () => {
  it('orders positions from the outermost exchange inward', () => {
    const at = (groupTree?: ChatGroupTree) => (['exchange', 'input', 'turn', 'process'] as const)
      .map(position => isAtOrOutside({ groupTree }, position))
    expect(at('exchange')).toEqual([true, true, true, true])
    expect(at('input')).toEqual([false, true, true, true])
    expect(at('turn')).toEqual([false, false, true, true])
    expect(at('process')).toEqual([false, false, false, true])
    expect(at(undefined)).toEqual([false, false, false, false])
  })

  it('starts the latest segment at the last opening Turn and reports only the Turns that moved', () => {
    const segments = new GroupTreeSegments('exchange')
    const order = [1, 2, 3, 4, 5]
    expect(segments.inLatest(1)).toBe(false)
    expect(segments.settle(order)).toEqual(order)
    expect(members(segments, order)).toEqual(order)

    segments.track(undefined, node('a', 2, 'exchange'))
    expect(segments.settle(order)).toEqual([1])
    expect(members(segments, order)).toEqual([2, 3, 4, 5])
    expect(segments.settle(order)).toEqual([])

    segments.track(undefined, node('b', 4, 'exchange'))
    expect(segments.settle(order)).toEqual([2, 3])
    expect(members(segments, order)).toEqual([4, 5])
    expect(segments.inLatest(undefined)).toBe(false)

    segments.track(node('b', 4, 'exchange'), undefined)
    expect(segments.settle(order)).toEqual([2, 3])
    expect(members(segments, order)).toEqual([2, 3, 4, 5])
  })

  it('counts every opening Node of a Turn and falls back as openings leave', () => {
    const segments = new GroupTreeSegments('exchange')
    const order = [1, 2, 3]
    const first = node('first', 1, 'exchange')
    const twin = node('twin', 3, 'exchange')
    const late = node('late', 3, 'exchange')
    for (const value of [late, first, twin]) segments.track(undefined, value)
    segments.settle(order)
    expect(members(segments, order)).toEqual([3])

    segments.track(late, node('late', 3))
    segments.settle(order)
    expect(members(segments, order)).toEqual([3])

    segments.track(first, undefined)
    segments.settle(order)
    expect(members(segments, order)).toEqual([3])

    segments.track(twin, { ...twin, location: { kind: 'session' } })
    expect(segments.settle(order)).toEqual([1, 2])
    expect(members(segments, order)).toEqual(order)
  })

  it('falls back to the latest remaining opening Turn whatever order the openings arrived in', () => {
    const segments = new GroupTreeSegments('exchange')
    const order = [1, 2, 3, 4, 5]
    const latest = node('latest', 5, 'exchange')
    for (const value of [node('middle', 3, 'exchange'), node('earliest', 1, 'exchange'), latest]) {
      segments.track(undefined, value)
    }
    segments.settle(order)
    expect(members(segments, order)).toEqual([5])

    segments.track(latest, undefined)
    expect(segments.settle(order)).toEqual([3, 4])
    expect(members(segments, order)).toEqual([3, 4, 5])
  })

  it('opens segments at Nodes of the configured position or an outer one', () => {
    const segments = new GroupTreeSegments('turn')
    const order = [1, 2, 3]
    segments.track(undefined, node('process', 3, 'process'))
    segments.track(undefined, node('turn', 2, 'turn'))
    segments.track(undefined, node('exchange', 1, 'exchange'))
    segments.track(node('none', 3), node('none', 3))
    segments.settle(order)
    expect(members(segments, order)).toEqual([2, 3])
  })

  it('clears the latest segment when no Turn is loaded', () => {
    const segments = new GroupTreeSegments('exchange')
    segments.track(undefined, node('a', 1, 'exchange'))
    segments.settle([1])
    segments.track(node('a', 1, 'exchange'), undefined)
    expect(segments.settle([])).toEqual([])
    expect(segments.inLatest(1)).toBe(false)
  })
})
