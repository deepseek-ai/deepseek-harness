import { Context } from '@deepseek-ai/cordis'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserTextFacts, UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { goalCommandReferenceRule } from '../src/client/user-text-rules.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'test.command.blocker': { readonly label: string }
  }
}

function setup(rules: readonly UserTextRule[] = [goalCommandReferenceRule]) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of rules) registry.register(rule)
  return registry.createEvaluator()
}

describe('goalCommandReferenceRule', () => {
  it('does not read command facts or rerun without an original slash-token boundary', () => {
    const read = vi.fn()
    const match = vi.fn<typeof goalCommandReferenceRule.match>((text, from, context) => goalCommandReferenceRule.match(text, from, {
      read: (key) => { read(key); return context.read(key) },
    }))
    const evaluate = setup([{ ...goalCommandReferenceRule, match }])
    const text = 'plain text prefix/goal'
    const before = evaluate({ text, facts: {} })
    expect(evaluate({ text, facts: { commands: [{ start: 0, end: 5, name: 'goal' }] } })).toBe(before)
    expect(read).not.toHaveBeenCalled()
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0])
  })

  it('offers confirmed ranges while the scheduler resolves an earlier same-start winner', () => {
    const text = '/goal /goal /goal'
    const blocker: UserTextNode<'test.command.blocker'> = {
      id: 'test.command.blocker', start: 0, end: 5, data: { label: 'claimed' },
    }
    const match = vi.fn<typeof goalCommandReferenceRule.match>(goalCommandReferenceRule.match)
    const evaluate = setup([
      { id: 'test.command.blocker', order: 0, match: (_text, from) => from === 0 ? blocker : undefined },
      { ...goalCommandReferenceRule, match },
    ])
    const nodes = evaluate({
      text, facts: { commands: [{ start: 0, end: 5, name: 'goal' }, { start: 6, end: 11, name: 'goal' }] },
    })
    expect(nodes[0]).toBe(blocker)
    expect(nodes.filter(node => node.id === 'command').map(node => [node.start, node.end])).toEqual([[6, 11]])
    expect(nodes.at(-1)).toEqual({ id: 'text', start: 11, end: text.length, data: { text: ' /goal' } })
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, 5, 11])
    expect(evaluate({ text, facts: { commands: [{ start: 6, end: 10, name: 'goal' }] } }).filter(node => node.id === 'command')).toEqual([])
  })

  it('marks only actual command ranges, not repeated command spelling in the body', () => {
    const evaluate = setup()
    const text = '/goal ship it\nthen discuss /goal again'
    const commands = [{ start: 0, end: 5, name: 'goal' }]
    const input = { text, facts: { commands } }
    const nodes = evaluate(input)
    expect(nodes.filter(node => node.id === 'command')).toEqual([
      { id: 'command', start: 0, end: 5, data: { name: 'goal' } },
    ])
    expect(evaluate({ text, facts: { commands } })).toBe(nodes)
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes)
    expect(evaluate({ text, facts: {} }).filter(node => node.id === 'command')).toEqual([])
  })

  it('returns one nearest valid range from unordered Facts at each requested offset', () => {
    const text = '/goal /goal /goal plain'
    const commands = [
      { start: 12, end: 17, name: 'goal' }, { start: 6, end: 17, name: 'goal' },
      { start: 0, end: 5, name: 'goal' }, { start: 6, end: 11, name: 'goal' },
      { start: 0, end: 5, name: 'goal' },
    ]
    const facts: Partial<UserTextFacts> = { commands }
    const context = { read: <K extends keyof UserTextFacts>(key: K) => facts[key] }
    expect(goalCommandReferenceRule.match(text, 0, context)?.start).toBe(0)
    expect(goalCommandReferenceRule.match(text, 5, context)?.start).toBe(6)
    expect(goalCommandReferenceRule.match(text, 11, context)?.start).toBe(12)
    expect(goalCommandReferenceRule.match(text, 17, context)).toBeUndefined()
  })

  it.each([
    [' /goalx', 1, 6], [' /other x/goal', 9, 14], [' /goal', 1, 7], [' /goal', 20, 25],
  ] as const)('ignores a nonmatching confirmed range in %s', (text, start, end) => {
    const facts: Partial<UserTextFacts> = { commands: [{ start, end, name: 'goal' }] }
    expect(goalCommandReferenceRule.match(text, 0, { read: key => facts[key] })).toBeUndefined()
  })

  it('uses original UTF-16 offsets without creating boundaries at the search cursor', () => {
    const evaluate = setup()
    const text = '🙂 /goal body /goal'
    expect(evaluate({ text, facts: { commands: [{ start: 3, end: 8, name: 'goal' }] } })
      .filter(node => node.id === 'command')).toEqual([{ id: 'command', start: 3, end: 8, data: { name: 'goal' } }])
    const facts: Partial<UserTextFacts> = { commands: [{ start: 1, end: 6, name: 'goal' }] }
    expect(goalCommandReferenceRule.match('x/goal', 1, { read: key => facts[key] })).toBeUndefined()
  })
})
