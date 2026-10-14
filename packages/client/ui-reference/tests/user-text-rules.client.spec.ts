import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import { fileReferenceRule, folderReferenceRule } from '../src/client/user-text-rules.ts'

function setup(rules: readonly UserTextRule[] = [folderReferenceRule, fileReferenceRule]) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of rules) registry.register(rule)
  return registry.createEvaluator()
}

describe('fileReferenceRule and folderReferenceRule', () => {
  it('reads no facts and reuses the entire result across fact updates', () => {
    const read = vi.fn()
    const file = vi.fn<UserTextRule<'file'>['match']>((text, from, context) => fileReferenceRule.match(text, from, {
      read: (key) => { read(key); return context.read(key) },
    }))
    const folder = vi.fn<UserTextRule<'folder'>['match']>((text, from, context) => folderReferenceRule.match(text, from, {
      read: (key) => { read(key); return context.read(key) },
    }))
    const evaluate = setup([{ ...fileReferenceRule, match: file }, { ...folderReferenceRule, match: folder }])
    const text = '@src/a.ts @docs/'
    const before = evaluate({ text, facts: {} })
    expect(before.filter(node => node.id !== 'text').map(node => node.id)).toEqual(['file', 'folder'])
    expect(evaluate({ text, facts: { sessionLabels: ['new label'] } })).toBe(before)
    expect(read).not.toHaveBeenCalled()
    expect(file.mock.calls.map(([, from]) => from)).toEqual([0, text.indexOf(' ')])
    expect(folder.mock.calls.map(([, from]) => from)).toEqual([0, text.length])
  })

  it('separates ordinary files from directories and decodes quoted paths', () => {
    const evaluate = setup()
    const text = '@src/deep/file.txt 与 @dir/ 与 @"a b.md" 与 @"dir a/" 与 @C:\\src\\a.ts'
    const input = Object.freeze({ text, facts: Object.freeze({}) })
    const nodes = evaluate(input)
    expect(nodes.filter(node => node.id === 'file').map(node => ({ raw: text.slice(node.start, node.end), data: node.data }))).toEqual([
      { raw: '@src/deep/file.txt', data: { path: 'src/deep/file.txt', label: 'file.txt' } },
      { raw: '@"a b.md"', data: { path: 'a b.md', label: 'a b.md' } },
      { raw: '@C:\\src\\a.ts', data: { path: 'C:\\src\\a.ts', label: 'a.ts' } },
    ])
    expect(nodes.filter(node => node.id === 'folder').map(node => ({ raw: text.slice(node.start, node.end), data: node.data }))).toEqual([
      { raw: '@dir/', data: { path: 'dir/', label: 'dir' } },
      { raw: '@"dir a/"', data: { path: 'dir a/', label: 'dir a' } },
    ])
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes)
  })

  it('leaves trailing sentence punctuation outside ranges without stripping quoted filename punctuation', () => {
    const evaluate = setup()
    const text = '@a.ts，。；：！？ @b.md.,;:!? @"a!.md"， @dir/。'
    const nodes = evaluate({ text, facts: {} })
    expect(nodes.filter(node => node.id === 'file').map(node => ({ raw: text.slice(node.start, node.end), data: node.data })))
      .toEqual([
        { raw: '@a.ts', data: { path: 'a.ts', label: 'a.ts' } },
        { raw: '@b.md', data: { path: 'b.md', label: 'b.md' } },
        { raw: '@"a!.md"', data: { path: 'a!.md', label: 'a!.md' } },
      ])
    expect(nodes.filter(node => node.id === 'folder').map(node => text.slice(node.start, node.end))).toEqual(['@dir/'])
  })

  it('keeps root-directory display fallback and requires a token boundary', () => {
    const evaluate = setup()
    const text = '@"/" @/ mail@host prefix@a.ts @。 @'
    const nodes = evaluate({ text, facts: {} })
    expect(nodes.filter(node => node.id === 'folder').map(node => node.data)).toEqual([
      { path: '/', label: '"/"' }, { path: '/', label: '/' },
    ])
    expect(nodes.filter(node => node.id === 'file')).toEqual([])
    expect(evaluate({ text: '@name', facts: {} })).toEqual([
      { id: 'file', start: 0, end: 5, data: { path: 'name', label: 'name' } },
    ])
  })
})
