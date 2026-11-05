import { describe, expect, it } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { isVisibleChatNode } from '../src/client/contract/chat-visibility.ts'

const placement = {
  key: 'command:test', id: 'test', target: 'chat', anchorSeq: 1,
  location: { kind: 'unresolved' }, visibility: 'visible',
} as const

function command(args: string | null, outcome: ChatNode<'command'>['data']['outcome'], name: string | null = 'team'): ChatNode<'command'> {
  return {
    ...placement, kind: 'command',
    data: { kind: 'command', seq: 1, time: 0, commandId: CommandId('test'), name, args, outcome },
  }
}

describe('Chat-only command visibility', () => {
  it.each(['on', 'off', ' on ', '\toff\n'])('omits pending and successful Team selection %j without rewriting the record', (args) => {
    for (const outcome of [null, { kind: 'success', text: 'Unchanged recorded output' }] as const) {
      const node = command(args, outcome)
      const before = JSON.stringify(node)
      expect(isVisibleChatNode(node)).toBe(false)
      expect(JSON.stringify(node)).toBe(before)
    }
  })

  it.each(['on', 'off', null, 'invalid'])('keeps a failed Team command visible for input %j', (args) => {
    expect(isVisibleChatNode(command(args, { kind: 'error', text: 'The operation failed' }))).toBe(true)
  })

  it.each(['ON', 'status', '', null])('does not infer a toggle from result text for input %j', (args) => {
    expect(isVisibleChatNode(command(args, { kind: 'success', text: 'Agent Teams enabled.' }))).toBe(true)
    expect(isVisibleChatNode(command(args, null))).toBe(true)
  })

  it.each(['other', null])('retains unrelated and window-cut commands named %j', (name) => {
    expect(isVisibleChatNode(command('on', { kind: 'success', text: 'done' }, name))).toBe(true)
  })

  it('retains a failed toggle after its hidden pending record settles', () => {
    const pending = command('on', null)
    const failed = { ...pending, data: { ...pending.data, outcome: { kind: 'error' as const, text: 'Save failed' } } }
    expect(isVisibleChatNode(pending)).toBe(false)
    expect(isVisibleChatNode(failed)).toBe(true)
  })

  it('keeps the existing permission and explicit hidden-node policies', () => {
    expect(isVisibleChatNode(command('on', { kind: 'error', text: 'failure' }, 'permission'))).toBe(false)
    expect(isVisibleChatNode({ ...command('on', { kind: 'error', text: 'failure' }), visibility: 'hidden' })).toBe(false)
  })
})

it('hides system prompts but shows context injections', () => {
  const prompt: ChatNode<'system-prompt'> = { ...placement, kind: 'system-prompt', data: { text: 'system instructions' } }
  const context: ChatNode<'context'> = {
    ...placement, kind: 'context',
    data: {
      kind: 'context', seq: 1, time: 0, content: [{ type: 'text', text: 'context' }], source: null,
      producer: { role: 'inject', label: null }, form: null,
    },
  }
  expect(isVisibleChatNode(prompt)).toBe(false)
  expect(isVisibleChatNode(context)).toBe(true)
})
