/**
 * SkillNameProjector: the step's `skill-invocation` injections attach to the
 * direct messages of the same batch, incrementally — an assistant-only apply
 * must neither scan the store nor re-emit message Nodes.
 */
import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import type { ChatNodeStore } from '../src/client/contract/snapshot.ts'
import { SkillNameProjector } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

function viewNode(kind: string, seq: number, data: Record<string, unknown>): ChatConversationViewNode {
  return {
    key: `${kind}:${seq}`,
    kind,
    id: String(seq),
    target: 'chat',
    anchorSeq: seq,
    location: { kind: 'session' },
    visibility: 'visible',
    data: { kind, seq, time: seq, ...data },
  } as unknown as ChatConversationViewNode
}
const user = (seq: number, text: string) =>
  viewNode('user', seq, { content: [{ type: 'text', text }], source: { kind: 'user' } })
const skill = (seq: number, name: string) =>
  viewNode('context', seq, { content: [], source: { kind: 'skill-invocation', name, form: 'instructions' } })
const instructions = (seq: number) =>
  viewNode('context', seq, { content: [], source: { kind: 'agent-instructions', changes: [] } })
const assistant = (seq: number, text = 'answer') => viewNode('assistant-step', seq, { text })

function storeOf(nodes: readonly ChatConversationViewNode[]): ChatNodeStore & { valuesCalls: number } {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const store = {
    valuesCalls: 0,
    get: (key: string) => byKey.get(key),
    values: () => {
      store.valuesCalls += 1
      return [...byKey.values()]
    },
    source: () => { throw new Error('unused') },
    processSource: () => { throw new Error('unused') },
  }
  return store
}

const names = (node: ChatConversationViewNode | undefined) =>
  (node?.data as { skillNames?: readonly string[] } | undefined)?.skillNames

describe('SkillNameProjector', () => {
  it('attaches a batch\'s injected skill names on replace and leaves other Nodes untouched', () => {
    const projector = new SkillNameProjector()
    const answer = assistant(6)
    const out = projector.replace([user(2, '/demo go'), instructions(4), skill(5, 'demo'), answer, user(10, '/demo later?')])
    expect(names(out[0])).toEqual(['demo'])
    expect(names(out[4])).toBeUndefined()
    expect(out[3]).toBe(answer)
  })

  it('an assistant-only apply neither scans the store nor re-emits message Nodes', () => {
    const projector = new SkillNameProjector()
    const replaced = projector.replace([user(2, '/demo go'), skill(5, 'demo'), assistant(6)])
    const store = storeOf(replaced)
    const frame = assistant(6, 'answer grows')
    const out = projector.apply([frame], store)
    expect(out).toEqual([frame])
    expect(store.valuesCalls).toBe(0)
  })

  it('a late skill injection updates only the direct messages of its batch', () => {
    const projector = new SkillNameProjector()
    const replaced = projector.replace([user(2, '/demo go'), assistant(6), user(10, 'unrelated')])
    const store = storeOf(replaced)
    const injection = skill(3, 'demo')
    const out = projector.apply([injection], store)
    expect(out.map(node => node.key).sort()).toEqual(['context:3', 'user:2'])
    expect(names(out.find(node => node.key === 'user:2'))).toEqual(['demo'])
  })

  it('re-decorates a direct message the assembler re-emits without names', () => {
    const projector = new SkillNameProjector()
    const replaced = projector.replace([user(2, '/demo go'), skill(5, 'demo'), assistant(6)])
    expect(names(replaced[0])).toEqual(['demo'])
    const store = storeOf(replaced)
    // A rebuilt message Node carries Definition state only: no skillNames.
    const rebuilt = user(2, '/demo go')
    const out = projector.apply([rebuilt], store)
    expect(out.map(node => node.key)).toEqual(['user:2'])
    expect(names(out[0])).toEqual(['demo'])
    expect(store.valuesCalls).toBe(0)
  })

  it('a boundary arriving inside a batch splits it and drops the names past it', () => {
    const projector = new SkillNameProjector()
    const replaced = projector.replace([user(2, '/demo go'), skill(4, 'demo'), user(8, '/demo again')])
    expect(names(replaced[2])).toEqual(['demo'])
    const store = storeOf(replaced)
    const out = projector.apply([assistant(6)], store)
    expect(out.map(node => node.key).sort()).toEqual(['assistant-step:6', 'user:8'])
    expect(names(out.find(node => node.key === 'user:8'))).toBeUndefined()
  })
})
