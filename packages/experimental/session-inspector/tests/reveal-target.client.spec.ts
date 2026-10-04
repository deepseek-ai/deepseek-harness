/** Inspector ranks precise and nearby reveal candidates from the loaded Chat model. */

import { expect, it } from 'vitest'
import { ConversationLocationIndex } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { resolveChatRevealTargets } from '../src/client/views/chat-node/reveal-target.ts'

function node(key: string, anchorSeq: number, kind = 'user', turnNumber = 1, stepNumber = 1): ChatConversationViewNode {
  const locations = new ConversationLocationIndex()
  const turn: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: turnNumber } }
  const step: SessionEvent<'step/start'> = { type: 'step/start', seq: SessionSeq(2), time: 0, data: { turn: turnNumber, step: stepNumber } }
  locations.appendBoundary(turn)
  locations.appendBoundary(step)
  return { key, kind, id: key, target: 'chat', anchorSeq, visibility: 'visible', location: locations.locationOf(step), data: {} }
}

it('finds an earlier user message by sequence independently of node order', () => {
  expect(resolveChatRevealTargets({ anchorSeq: 10 }, [node('later', 30), node('earlier', 10)])[0])
    .toEqual({ anchorSeq: 10, nodeKey: 'earlier', turn: 1 })
})

it('prefers tool identity and the owning Assistant over unrelated nearby nodes', () => {
  const tool = { ...node('tool', 3, 'tool-call'), data: { root: { callId: 'root-call' } } }
  expect(resolveChatRevealTargets({ anchorSeq: 10, callId: 'child-call', rootCallId: 'root-call', turn: 1, step: 1 }, [tool, node('later', 10)])[0])
    .toMatchObject({ nodeKey: 'tool', callId: 'child-call' })
  const assistant = node('assistant', 20, 'assistant-step')
  expect(resolveChatRevealTargets({ anchorSeq: 15, nodeKind: 'assistant-step', turn: 1, step: 1, groupPart: 'reasoning' },
    [{ ...assistant, key: 'hidden', visibility: 'hidden' }, node('nearby', 16), assistant])[0])
    .toMatchObject({ nodeKey: 'assistant', groupPart: 'reasoning' })
})

it('approximates within the requested Turn and preserves explicit object identities', () => {
  const nearby = node('nearby', 7)
  const other = { ...node('other', 8), location: { kind: 'session' as const } }
  expect(resolveChatRevealTargets({ anchorSeq: 8, turn: 1, step: 2 }, [other, nearby])[0]?.nodeKey).toBe('nearby')
  const absent = { anchorSeq: 8, turn: 9, step: 2 }
  expect(resolveChatRevealTargets(absent, [nearby])[0]).toEqual(absent)
  const exact = { nodeKey: 'explicit', turn: 1 }
  expect(resolveChatRevealTargets(exact, [nearby])[0]).toEqual(exact)
})

it('selects the nearest session-level node while retaining the first of equal-distance candidates', () => {
  const nodes = [node('farther', 1), node('nearest', 8), node('tied', 12)]
    .map(value => ({ ...value, location: { kind: 'session' as const } }))
  expect(resolveChatRevealTargets({ anchorSeq: 10 }, nodes)[0]).toEqual({ anchorSeq: 10, nodeKey: 'nearest' })
})

it('fills an explicit session-level node anchor without adding Turn or Step coordinates', () => {
  const explicit = { ...node('session', 12), location: { kind: 'session' as const } }
  expect(resolveChatRevealTargets({ nodeKey: 'session' }, [explicit])).toStrictEqual([
    { nodeKey: 'session', anchorSeq: 12 },
  ])
})

it('ranks visible neighbors of a hidden explicit node by Step, Turn, then Session with stable distance ties', () => {
  const target = { nodeKey: 'hidden', groupPart: 'reasoning' }
  const nodes = [
    node('other-turn-near', 100, 'user', 3, 3),
    node('same-turn-far', 60, 'user', 2, 4),
    node('same-step-after', 110, 'user', 2, 3),
    { ...node('session', 100), location: { kind: 'session' as const } },
    node('same-step-far', 140, 'user', 2, 3),
    { ...node('hidden', 100, 'assistant-step', 2, 3), visibility: 'hidden' as const },
    node('same-turn-near', 95, 'user', 2, 2),
    node('same-step-before', 90, 'user', 2, 3),
    node('other-turn-far', 180, 'user', 4, 3),
  ]
  const candidates = resolveChatRevealTargets(target, nodes)
  expect(candidates[0]).toMatchObject(target)
  expect(candidates).toEqual([
    { ...target, anchorSeq: 100, turn: 2, step: 3 },
    { nodeKey: 'same-step-after', anchorSeq: 110, turn: 2, step: 3 },
    { nodeKey: 'same-step-before', anchorSeq: 90, turn: 2, step: 3 },
    { nodeKey: 'same-step-far', anchorSeq: 140, turn: 2, step: 3 },
    { nodeKey: 'same-turn-near', anchorSeq: 95, turn: 2, step: 2 },
    { nodeKey: 'same-turn-far', anchorSeq: 60, turn: 2, step: 4 },
    { nodeKey: 'other-turn-near', anchorSeq: 100, turn: 3, step: 3 },
    { nodeKey: 'session', anchorSeq: 100 },
    { nodeKey: 'other-turn-far', anchorSeq: 180, turn: 4, step: 3 },
  ])
})

it('uses requested coordinates before the explicit node coordinates without reordering the input', () => {
  const target = { nodeKey: 'hidden', anchorSeq: 200, turn: 4, step: 5 }
  const nodes = Object.freeze([
    node('inferred-step', 100, 'user', 2, 3),
    node('requested-far', 160, 'user', 4, 5),
    node('requested-turn', 201, 'user', 4, 6),
    node('requested-near', 199, 'user', 4, 5),
    { ...node('hidden', 100, 'assistant-step', 2, 3), visibility: 'hidden' as const },
  ])
  const candidates = resolveChatRevealTargets(target, nodes)
  expect(candidates[0]).toEqual(target)
  expect(candidates.map(candidate => candidate.nodeKey))
    .toEqual(['hidden', 'requested-near', 'requested-far', 'requested-turn', 'inferred-step'])
  expect(nodes.map(value => value.key))
    .toEqual(['inferred-step', 'requested-far', 'requested-turn', 'requested-near', 'hidden'])
})

it('keeps a root tool primary ahead of exact, kind, and nearer fallback nodes', () => {
  const target = { anchorSeq: 100, turn: 2, step: 3, callId: 'child', rootCallId: 'root', nodeKind: 'assistant-step' }
  const tool = { ...node('tool', 300, 'tool-call', 9, 1), data: { root: { callId: 'root' } } }
  const candidates = resolveChatRevealTargets(target, [
    tool, node('assistant', 120, 'assistant-step', 2, 3), node('exact', 100, 'user', 2, 3),
  ])
  expect(candidates).toEqual([
    { ...target, nodeKey: 'tool' },
    { nodeKey: 'exact', anchorSeq: 100, turn: 2, step: 3 },
    { nodeKey: 'assistant', anchorSeq: 120, turn: 2, step: 3 },
    { nodeKey: 'tool', anchorSeq: 300, turn: 9, step: 1 },
  ])
})

it('keeps an exact primary ahead of an Assistant kind match', () => {
  const target = { anchorSeq: 10, turn: 1, step: 1, nodeKind: 'assistant-step' }
  expect(resolveChatRevealTargets(target, [node('assistant', 9, 'assistant-step'), node('exact', 10)])[0])
    .toEqual({ ...target, nodeKey: 'exact' })
})

it('retries an explicit node without its tool, group, or part selectors', () => {
  const target = {
    nodeKey: 'explicit', anchorSeq: 10, turn: 1, step: 1, nodeKind: 'assistant-step',
    callId: 'child', rootCallId: 'root', groupPart: 'reasoning', groupKey: 'process',
  }
  const candidates = resolveChatRevealTargets(target, [node('explicit', 10, 'assistant-step')])
  expect(candidates[0]).toEqual(target)
  expect(candidates).toEqual([target, { nodeKey: 'explicit', anchorSeq: 10, turn: 1, step: 1 }])
})

it('removes identical candidates without depending on property insertion order', () => {
  const target = { step: 1, turn: 1, anchorSeq: 10, nodeKey: 'explicit' }
  const explicit = node('explicit', 10)
  const neighbor = node('neighbor', 11)
  expect(resolveChatRevealTargets(target, [explicit, neighbor, { ...neighbor }]))
    .toEqual([target, { nodeKey: 'neighbor', anchorSeq: 11, turn: 1, step: 1 }])
})

it('offers other loaded Turns after an unresolved primary', () => {
  const target = { anchorSeq: 100, turn: 9, step: 2 }
  const candidates = resolveChatRevealTargets(target, [node('far', 80), node('near', 99)])
  expect(candidates[0]).toEqual(target)
  expect(candidates).toEqual([
    target,
    { nodeKey: 'near', anchorSeq: 99, turn: 1, step: 1 },
    { nodeKey: 'far', anchorSeq: 80, turn: 1, step: 1 },
  ])
})

it.each([
  { groupKey: 'process' },
  { nodeKey: 'unloaded', callId: 'child' },
  { turn: 1, step: 1 },
])('preserves a single target when its event position is unknown: %j', (target) => {
  const candidates = resolveChatRevealTargets(target, [node('first', 10)])
  expect(candidates).toEqual([target])
  expect(candidates[0]).toEqual(target)
})

it('retains the hidden explicit node Turn in the primary when only other Turns have visible candidates', () => {
  const target = Object.freeze({
    nodeKey: 'hidden', nodeKind: 'assistant-step', callId: 'child', rootCallId: 'root',
    groupKey: 'process', groupPart: 'reasoning',
  })
  const hidden = { ...node('hidden', 100, 'assistant-step', 2, 3), visibility: 'hidden' as const }
  expect(resolveChatRevealTargets(target, [node('other-turn', 101, 'user', 3, 1), hidden])).toEqual([
    { ...target, anchorSeq: 100, turn: 2, step: 3 },
    { nodeKey: 'other-turn', anchorSeq: 101, turn: 3, step: 1 },
  ])
})

it.each([
  { anchorSeq: 200 },
  { turn: 4 },
  { step: 5 },
])('fills only missing primary coordinates from an explicit node: %j', (requested) => {
  const target = { nodeKey: 'hidden', ...requested }
  const hidden = { ...node('hidden', 100, 'assistant-step', 2, 3), visibility: 'hidden' as const }
  expect(resolveChatRevealTargets(target, [hidden])).toEqual([
    { nodeKey: 'hidden', anchorSeq: 100, turn: 2, step: 3, ...requested },
  ])
})

it('deduplicates an enriched primary against the identical bare-node fallback', () => {
  expect(resolveChatRevealTargets({ nodeKey: 'explicit' }, [node('explicit', 10), node('neighbor', 11)])).toEqual([
    { nodeKey: 'explicit', anchorSeq: 10, turn: 1, step: 1 },
    { nodeKey: 'neighbor', anchorSeq: 11, turn: 1, step: 1 },
  ])
})
