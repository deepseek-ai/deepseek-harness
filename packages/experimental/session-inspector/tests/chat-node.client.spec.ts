/** Chat inspection follows grouping while content updates stay on keyed row sources. */

import type { ChatConversationViewNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ChatSnapshotBuilder } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { ConversationGroupStore } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/group-store.ts'
import type { ConversationBinding, ConversationSnapshot, GroupKey, GroupSnapshot, NodeKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ChatNodeModel } from '../src/client/views/chat-node/model.ts'

const timeline = { turnOrder: [], turns: new Map() }
function node(key: string, text = key, anchorSeq = 1): ChatConversationViewNode {
  return { key, id: key, target: 'chat', kind: 'test', anchorSeq,
    location: { kind: 'session' }, visibility: 'visible', data: { text } }
}

it('nests group members, includes hidden Nodes, and leaves row order unchanged on content updates', async () => {
  const builder = new ChatSnapshotBuilder()
  const first = node('first')
  const second = node('second')
  const hidden = { ...node('hidden', 'hidden', 3), visibility: 'hidden' as const }
  let chat = builder.replace({ nodes: [first, second, hidden], timeline })
  const groups = new ConversationGroupStore<{ count: number }>()
  const groupKey = 'group' as GroupKey
  const group = (keys: string[]) => ({ key: groupKey, data: { count: keys.length },
    members: keys.map(key => ({ kind: 'node' as const, key: key as NodeKey })) })
  groups.prepareAndInstall({ entries: [{ kind: 'group', key: groupKey }, { kind: 'node', key: second.key as NodeKey }],
    groups: { kind: 'replace', snapshots: [group([first.key])] } }, key => chat.nodes.get(key))
  const viewStore = { get: () => chat, grouped: () => groups } as ConversationSnapshot['views']
  const snapshot = createSnapshotStore<ConversationSnapshot>({ views: viewStore, activeTargets: new Set(['chat']) })
  const binding: ConversationBinding = {
    snapshot, openTurn: createSnapshotStore<number | undefined>(undefined),
    activate: vi.fn(), target: () => { throw new Error('unused') },
  }
  const model = new ChatNodeModel(binding)
  const changed = vi.fn()
  onTestFinished(model.subscribe(changed))
  expect(model.getSnapshot()).toEqual([
    { key: 'group:group', depth: 0 }, { key: 'node:first:', parent: 'group:group', depth: 1 },
    { key: 'node:second:', depth: 0 }, { key: 'node:hidden:', depth: 0 },
  ])
  const order = model.getSnapshot()
  const source = model.row('node:first:')!
  const notify = vi.fn()
  onTestFinished(source.subscribe(notify))
  const before = source.getSnapshot()
  expect(before?.summary).not.toContain('key: first')
  expect(before?.summary).not.toContain('kind: test')
  expect(before?.value).toBe(first)
  expect(model.row('group:group')!.getSnapshot()?.summary).not.toContain('key: group')
  changed.mockClear()
  chat = builder.apply({ upserts: [node('first', 'updated')], timeline })
  builder.publish()
  snapshot.set({ views: viewStore, activeTargets: new Set(['chat']) })
  expect(notify).toHaveBeenCalledOnce()
  expect(source.getSnapshot()).not.toBe(before)
  expect(source.getSnapshot()?.value).toMatchObject({ data: { text: 'updated' } })
  expect(model.getSnapshot()).toBe(order)
  expect(changed).not.toHaveBeenCalled()
  groups.prepareAndInstall({ entries: [{ kind: 'group', key: groupKey }],
    groups: { kind: 'apply', upserts: [group([first.key, second.key])], removes: [] } }, key => chat.nodes.get(key))
  groups.publish()
  snapshot.set({ views: viewStore, activeTargets: new Set(['chat']) })
  await Promise.resolve()
  expect(model.getSnapshot().find(row => row.key === 'node:second:')).toMatchObject({ depth: 1, parent: 'group:group' })
  expect(model.row('node:first:')).toBe(source)
})

it('places unlisted assistant steps by event anchor without inventing group membership or appending after Turn tails', () => {
  const builder = new ChatSnapshotBuilder()
  const first = node('first-member', 'first', 3)
  const second = node('second-member', 'second', 7)
  const hidden = { ...node('assistant-step:1:1', 'hidden', 5), kind: 'assistant-step', visibility: 'hidden' as const }
  const otherHidden = { ...node('assistant-step:2:1', 'hidden', 15), kind: 'assistant-step', visibility: 'hidden' as const }
  let chat = builder.replace({ nodes: [
    node('turn-start:1', 'start', 1), first, second, node('turn-tail:1', 'tail', 10),
    node('turn-start:2', 'start', 11), node('turn-tail:2', 'tail', 20), otherHidden, hidden,
  ], timeline })
  const groupKey = 'process' as GroupKey
  const members = [first, second].map(value => ({ kind: 'node' as const, key: value.key as NodeKey }))
  const groups = new ConversationGroupStore()
  groups.prepareAndInstall({ entries: [
    { kind: 'node', key: 'turn-start:1' as NodeKey }, { kind: 'group', key: groupKey },
    ...['turn-tail:1', 'turn-start:2', 'turn-tail:2'].map(key => ({ kind: 'node' as const, key: key as NodeKey })),
  ], groups: { kind: 'replace', snapshots: [{ key: groupKey, members, data: {} }] } }, key => chat.nodes.get(key))
  const views = { get: () => chat, grouped: () => groups } as ConversationSnapshot['views']
  const snapshot = createSnapshotStore<ConversationSnapshot>({ views, activeTargets: new Set(['chat']) })
  const model = new ChatNodeModel({ snapshot, openTurn: createSnapshotStore<number | undefined>(undefined),
    activate: vi.fn(), target: () => { throw new Error('unused') } })
  onTestFinished(model.subscribe(vi.fn()))
  expect(model.getSnapshot().map(row => row.key)).toEqual([
    'node:turn-start:1:', 'group:process', 'node:first-member:', 'node:second-member:',
    'node:assistant-step:1:1:', 'node:turn-tail:1:', 'node:turn-start:2:', 'node:assistant-step:2:1:', 'node:turn-tail:2:',
  ])
  expect(groups.groupSource(groupKey).getSnapshot()?.members).toBe(members)
  expect(model.getSnapshot().find(row => row.key === 'node:assistant-step:1:1:')?.depth).toBe(0)
  const source = model.row('node:assistant-step:1:1:')
  chat = builder.apply({ upserts: [{ ...hidden, anchorSeq: 17 }], timeline })
  builder.publish()
  snapshot.set({ views, activeTargets: new Set(['chat']) })
  expect(model.getSnapshot().slice(-3).map(row => row.key))
    .toEqual(['node:assistant-step:2:1:', 'node:assistant-step:1:1:', 'node:turn-tail:2:'])
  expect(model.row('node:assistant-step:1:1:')).toBe(source)
})

it('shares activation while observed and retires groups and queued updates when hidden', async () => {
  const builder = new ChatSnapshotBuilder()
  const first = node('first')
  const second = node('second', 'second', 2)
  let chat: ChatSnapshot | undefined
  let groups: ConversationGroupStore<object> | undefined = undefined
  const views = { get: () => chat, grouped: () => groups } as ConversationSnapshot['views']
  const snapshot = createSnapshotStore<ConversationSnapshot>({ views, activeTargets: new Set() })
  const activate = vi.fn(() => { chat = builder.replace({ nodes: [first, second], timeline }) })
  const model = new ChatNodeModel({ snapshot, activate, openTurn: createSnapshotStore<number | undefined>(undefined),
    target: () => { throw new Error('unused') } })
  expect(model.getSnapshot()).toEqual([])
  expect(model.pick({ nodeKey: 'missing' })).toBeUndefined()
  const releases: Array<() => void> = []
  onTestFinished(() => { for (const release of releases.splice(0)) release() })
  releases.push(model.subscribe(vi.fn()), model.subscribe(vi.fn()))
  expect(activate).toHaveBeenCalledOnce()
  expect(model.getSnapshot()).toHaveLength(2)
  const original = model.row('node:first:')
  groups = new ConversationGroupStore()
  const key = 'live-group' as GroupKey
  const update = (keys: string[]): void => {
    groups!.prepareAndInstall({ entries: [{ kind: 'group', key }], groups: { kind: 'replace', snapshots: [{ key,
      members: keys.map(value => ({ kind: 'node', key: value as NodeKey })), data: {},
    }] } }, nodeKey => chat?.nodes.get(nodeKey))
    groups!.publish()
  }
  update(['first'])
  snapshot.set({ views, activeTargets: new Set(['chat']) })
  expect(model.row('node:first:')).not.toBe(original)
  update(['first', 'second'])
  update(['second'])
  update(['second'])
  await Promise.resolve()
  expect(model.getSnapshot().find(row => row.key === 'node:second:')?.parent).toBe('group:live-group')
  expect(model.getSnapshot().find(row => row.key === 'node:first:')?.parent).toBeUndefined()
  const previousGroups = groups
  groups = new ConversationGroupStore<object>()
  update(['second'])
  snapshot.set({ views, activeTargets: new Set(['chat']) })
  const currentRows = model.getSnapshot()
  previousGroups.clear()
  previousGroups.publish()
  await Promise.resolve()
  expect(model.getSnapshot()).toBe(currentRows)
  groups.clear()
  groups.publish()
  snapshot.set({ views, activeTargets: new Set(['chat']) })
  await Promise.resolve()
  expect(model.row('group:live-group')).toBeUndefined()
  update(['first'])
  snapshot.set({ views, activeTargets: new Set(['chat']) })
  update(['second'])
  for (const release of releases.splice(0)) release()
  const hidden = model.getSnapshot()
  await Promise.resolve()
  expect(model.getSnapshot()).toBe(hidden)
  chat = new ChatSnapshotBuilder().replace({ nodes: [], timeline })
  snapshot.set({ views, activeTargets: new Set(['chat']) })
  expect(model.getSnapshot()).toBe(hidden)
})

it('keeps an unavailable group source empty and orders unlisted nodes with equal anchors deterministically', () => {
  const builder = new ChatSnapshotBuilder()
  const nodes = ['b', 'a'].map(key => ({ ...node(key), visibility: 'hidden' as const }))
  const chat = builder.replace({ nodes, timeline })
  const key = 'loading-group' as GroupKey
  const group = createSnapshotStore<GroupSnapshot<unknown> | undefined>(undefined)
  const grouped = { entries: [{ kind: 'group' as const, key }], groupSource: () => group }
  const views = { get: () => chat, grouped: () => grouped } as ConversationSnapshot['views']
  const snapshot = createSnapshotStore<ConversationSnapshot>({ views, activeTargets: new Set(['chat']) })
  const model = new ChatNodeModel({ snapshot, activate: vi.fn(), openTurn: createSnapshotStore<number | undefined>(undefined),
    target: () => { throw new Error('unused') } })
  onTestFinished(model.subscribe(vi.fn()))
  expect(model.getSnapshot().map(row => row.key)).toEqual(['group:loading-group', 'node:a:', 'node:b:'])
  expect(model.row('group:loading-group')?.getSnapshot()).toBeUndefined()
})
