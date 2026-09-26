import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConversationViewNode } from '../src/client/contract/conversation.ts'
import type { GroupKey, GroupSnapshot, GroupUpdate, NodeKey, NodeReference, RenderEntry } from '../src/client/contract/groups.ts'
import { ConversationGroupStore } from '../src/client/conversation/group-store.ts'

const key = (value: string): GroupKey => brandString<GroupKey>(value)
const node = (value: string, groupPart?: string): NodeReference => ({
  kind: 'node', key: brandString<NodeKey>(value), ...groupPart === undefined ? {} : { groupPart },
})
const reference = (value: string): RenderEntry => ({ kind: 'group', key: key(value) })
const readNode = (id: NodeKey): ConversationViewNode | undefined => id === 'missing'
  ? undefined
  : { key: id, kind: 'test', id, target: 'test', data: id }
const group = (id: string, members: readonly NodeReference[], data = 0): GroupSnapshot<number> => ({ key: key(id), members, data })

function replace(store: ConversationGroupStore<number>, entries: readonly RenderEntry[], groups: readonly GroupSnapshot<number>[]) {
  store.prepareAndInstall({ entries, groups: { kind: 'replace', snapshots: groups } }, readNode)
}

describe('ConversationGroupStore', () => {
  it('publishes one changed group without changing root or member identities', () => {
    const store = new ConversationGroupStore<number>()
    const a = group('a', [node('a')])
    const b = group('b', [node('b')])
    replace(store, [reference('a'), node('reply'), reference('b')], [a, b])
    store.publish()
    const root = store.entries
    const source = store.groupSource(key('a'))
    const other = store.groupSource(key('b'))
    expect(store.groupSource(key('a'))).toBe(source)
    const changed = vi.fn()
    const otherChanged = vi.fn()
    const unsubscribe = source.subscribe(changed)
    const unsubscribeOther = other.subscribe(otherChanged)
    const reads = vi.fn(readNode)
    store.prepareAndInstall({ groups: { kind: 'apply', upserts: [{ ...a, data: 1 }], removes: [] } }, reads)
    expect(source.getSnapshot()).toEqual({ ...a, data: 1 })
    expect(source.getSnapshot()?.members).toBe(a.members)
    expect(other.getSnapshot()).toBe(b)
    expect(store.entries).toBe(root)
    expect(reads).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    store.publish()
    expect(changed).toHaveBeenCalledOnce()
    expect(otherChanged).not.toHaveBeenCalled()
    unsubscribe()
    unsubscribeOther()
    store.prepareAndInstall({ groups: { kind: 'apply', upserts: [{ ...a, data: 2 }], removes: [] } }, readNode)
    store.publish()
    expect(changed).toHaveBeenCalledOnce()
  })

  it('reuses equivalent snapshots and accepts parts in separate positions', () => {
    const store = new ConversationGroupStore<number>()
    const reasoning = node('assistant', 'reasoning')
    const reply = node('assistant', 'response')
    const original = group('a', [reasoning])
    replace(store, [reference('a'), reply], [original])
    const root = store.entries
    const source = store.groupSource(key('a'))
    const changed = vi.fn()
    source.subscribe(changed)
    store.publish()
    replace(store, [reference('a'), node('assistant', 'response')], [group('a', [node('assistant', 'reasoning')])])
    store.publish()
    expect(store.entries).toBe(root)
    expect(source.getSnapshot()).toBe(original)
    expect(changed).not.toHaveBeenCalled()
    store.prepareAndInstall({ groups: { kind: 'apply', upserts: [group('a', [node('assistant', 'reasoning')], 1)], removes: [] } }, readNode)
    expect(source.getSnapshot()?.members).toBe(original.members)
    store.publish()
    expect(changed).toHaveBeenCalledOnce()
  })

  it('moves references atomically and preserves surviving group sources', () => {
    const store = new ConversationGroupStore<number>()
    const a = node('a')
    const b = node('b')
    replace(store, [reference('old')], [group('old', [a, b])])
    store.publish()
    const oldSource = store.groupSource(key('old'))
    const nextSource = store.groupSource(key('next'))
    const oldChanged = vi.fn()
    oldSource.subscribe(oldChanged)
    store.prepareAndInstall({
      entries: [a, reference('next')],
      groups: { kind: 'apply', removes: [key('old')], upserts: [group('next', [b])] },
    }, readNode)
    expect(oldSource.getSnapshot()).toBeUndefined()
    expect(nextSource.getSnapshot()?.members).toEqual([b])
    expect(oldChanged).not.toHaveBeenCalled()
    store.publish()
    expect(oldChanged).toHaveBeenCalledOnce()
    const root = store.entries
    store.prepareAndInstall({ groups: { kind: 'apply', removes: [], upserts: [group('next', [node('c')])] } }, readNode)
    expect(store.entries).toBe(root)
    expect(store.groupSource(key('next'))).toBe(nextSource)
    store.prepareAndInstall({ entries: [node('c'), a], groups: { kind: 'apply', removes: [key('next')], upserts: [] } }, readNode)
    store.publish()
    expect(store.entries).toEqual([node('c'), a])
    store.clear()
    store.publish()
    expect(store.entries).toEqual([])
    expect(nextSource.getSnapshot()).toBeUndefined()
    store.clear()
    store.publish()
  })

  it('keeps omitted entries and allows an empty complete replacement', () => {
    const store = new ConversationGroupStore<number>()
    replace(store, [node('a'), node('b')], [])
    const root = store.entries
    store.prepareAndInstall({ groups: { kind: 'apply', upserts: [], removes: [] } }, readNode)
    expect(store.entries).toBe(root)
    store.prepareAndInstall({ entries: [node('b'), node('a')], groups: { kind: 'apply', upserts: [], removes: [] } }, readNode)
    expect(store.entries).toEqual([node('b'), node('a')])
    replace(store, [], [])
    expect(store.entries).toEqual([])
  })

  it('validates references again on complete replacement, even when arrays are reused', () => {
    const store = new ConversationGroupStore<number>()
    const initial = group('a', [node('a')])
    const entries = [reference('a'), node('b')]
    replace(store, entries, [initial])
    expect(() => { store.prepareAndInstall({ entries, groups: { kind: 'replace', snapshots: [initial] } }, () => undefined) })
      .toThrow('missing Node')
    expect(store.entries).toBe(entries)
    expect(store.groupSource(key('a')).getSnapshot()).toBe(initial)
  })

  it.each([
    [node('a'), node('a')],
    [node('a', 'reasoning'), node('a', 'reasoning')],
    [node('a'), node('a', 'reasoning')],
    [node('a', 'reasoning'), node('a')],
  ])('rejects overlapping Node positions without changing installed data: %j', (first, second) => {
    const store = new ConversationGroupStore<number>()
    replace(store, [node('before')], [])
    const root = store.entries
    expect(() => { replace(store, [first, reference('a')], [group('a', [second])]) }).toThrow('overlapping')
    expect(store.entries).toBe(root)
    replace(store, [reference('a')], [group('a', [first])])
    expect(store.groupSource(key('a')).getSnapshot()?.members).toEqual([first])
  })

  it.each<{ name: string; update: GroupUpdate<number>; error: string }>([
    { name: 'duplicate group roots', update: { entries: [reference('a'), reference('a')], groups: { kind: 'apply', upserts: [], removes: [] } }, error: 'duplicate root' },
    { name: 'unreferenced group', update: { entries: [reference('a'), reference('c')], groups: { kind: 'apply', upserts: [group('b', [])], removes: [] } }, error: 'no root reference' },
    { name: 'missing group', update: { entries: [reference('missing')], groups: { kind: 'apply', upserts: [], removes: [] } }, error: 'missing group' },
    { name: 'removed referenced group', update: { groups: { kind: 'apply', upserts: [group('b', [])], removes: [key('a')] } }, error: 'still referenced' },
    { name: 'record count mismatch', update: { entries: [], groups: { kind: 'apply', upserts: [], removes: [] } }, error: 'one-to-one' },
    { name: 'duplicate upserts', update: { groups: { kind: 'apply', upserts: [group('a', []), group('a', [])], removes: [] } }, error: 'duplicate upserts' },
    { name: 'duplicate removals', update: { entries: [], groups: { kind: 'apply', upserts: [], removes: [key('a'), key('a')] } }, error: 'duplicate removals' },
    { name: 'absent removal', update: { groups: { kind: 'apply', upserts: [], removes: [key('missing')] } }, error: 'absent' },
    { name: 'upsert and remove', update: { groups: { kind: 'apply', upserts: [group('a', [])], removes: [key('a')] } }, error: 'upserted and removed' },
    { name: 'missing Node', update: { groups: { kind: 'apply', upserts: [group('a', [node('missing')])], removes: [] } }, error: 'missing Node' },
  ])('rejects $name atomically', ({ update, error }) => {
    const store = new ConversationGroupStore<number>()
    const initial = group('a', [node('a')])
    replace(store, [reference('a')], [initial])
    store.publish()
    const root = store.entries
    const source = store.groupSource(key('a'))
    expect(() => { store.prepareAndInstall(update, readNode) }).toThrow(error)
    expect(store.entries).toBe(root)
    expect(source.getSnapshot()).toBe(initial)
  })
})
