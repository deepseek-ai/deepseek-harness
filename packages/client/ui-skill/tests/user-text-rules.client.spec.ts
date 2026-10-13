import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import { skillReferenceRule } from '../src/client/user-text-rules.ts'

function setup(rule: UserTextRule = skillReferenceRule) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  registry.register(rule)
  return registry.createEvaluator()
}

describe('skillReferenceRule', () => {
  it('does not read names or rerun when text has no slash-token candidate', () => {
    const read = vi.fn()
    const match = vi.fn<UserTextRule<'skill'>['match']>((text, from, context) => skillReferenceRule.match(text, from, {
      read: (key) => { read(key); return context.read(key) },
    }))
    const evaluate = setup({ ...skillReferenceRule, match })
    const text = 'plain text /review.md /path/to/file'
    const before = evaluate({ text, facts: {} })
    expect(evaluate({ text, facts: { skillNames: ['review', 'path'] } })).toBe(before)
    expect(read).not.toHaveBeenCalled()
    expect(match).toHaveBeenCalledOnce()
  })

  it('reacts to missing names appearing and retains node identities when unrelated names are added', () => {
    const match = vi.fn<UserTextRule<'skill'>['match']>((text, from, context) => skillReferenceRule.match(text, from, context))
    const evaluate = setup({ ...skillReferenceRule, match })
    const text = 'use /review now'
    expect(evaluate({ text, facts: {} }).every(node => node.id === 'text')).toBe(true)
    const before = evaluate({ text, facts: { skillNames: ['review'] } })
    const after = evaluate({ text, facts: { skillNames: ['review', 'unrelated'] } })
    expect(after).toBe(before)
    expect(after.find(node => node.id === 'skill')).toBe(before.find(node => node.id === 'skill'))
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, 0, 11, 0, 11])
  })

  it('recognizes only names explicitly resolved for this message', () => {
    const evaluate = setup()
    const text = '用 /review 再 /test-skill\n/review'
    const input = Object.freeze({ text, facts: Object.freeze({ skillNames: Object.freeze(['review', 'test-skill', 'review']) }) })
    const nodes = evaluate(input)
    expect(nodes.filter(node => node.id === 'skill').map(node => ({ raw: text.slice(node.start, node.end), data: node.data }))).toEqual([
      { raw: '/review', data: { name: 'review' } }, { raw: '/test-skill', data: { name: 'test-skill' } },
      { raw: '/review', data: { name: 'review' } },
    ])
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes)
    expect(evaluate({ text, facts: {} })).toEqual([{ id: 'text', start: 0, end: text.length, data: { text } }])
    expect(evaluate({ text, facts: { skillNames: [] } }).every(node => node.id === 'text')).toBe(true)
  })

  it('requires whitespace or text boundaries and never strips attached punctuation', () => {
    const evaluate = setup()
    const text = '/x /x.md /x/path /path /x。 /x, (/x) prefix/x\t/x\n/x'
    const nodes = evaluate({ text, facts: { skillNames: ['x'] } })
    expect(nodes.filter(node => node.id === 'skill').map(node => [node.start, node.end, text.slice(node.start, node.end)])).toEqual([
      [0, 2, '/x'], [text.indexOf('\t/x') + 1, text.indexOf('\t/x') + 3, '/x'],
      [text.lastIndexOf('/x'), text.length, '/x'],
    ])
    for (const input of [
      { text: '/path /x.md /x', facts: {} },
      { text: '/path /x.md /x。', facts: { skillNames: ['x'] } },
      { text: '/nfs-hg/path /root-dir/ /plan.md /plan。', facts: { skillNames: ['nfs-hg', 'root-dir', 'plan'] } },
      { text: '/plan.md /nfs-hg/path /plan。', facts: { skillNames: ['plan.md', 'nfs-hg/path', 'plan。'] } },
    ]) {
      expect(evaluate(input).every(node => node.id === 'text')).toBe(true)
    }
  })
})
