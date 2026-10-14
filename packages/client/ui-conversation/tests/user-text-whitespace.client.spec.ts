/** Whitespace is ordinary Text-producing matching, including scheduling and Facts invalidation. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import type { UserTextFacts, UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'
import { collapseWhitespaceRule, trimWhitespaceRule } from '../src/client/user-text/whitespace-rules.ts'
import { sessionReferenceRule } from '../src/client/user-text/session-reference-rule.ts'

function setup(extra: readonly UserTextRule[] = []) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new UserTextRegistry(ctx)
  const collapse = vi.fn(collapseWhitespaceRule.match)
  const trim = vi.fn(trimWhitespaceRule.match)
  registry.register({ ...collapseWhitespaceRule, match: collapse })
  registry.register({ ...trimWhitespaceRule, match: trim })
  for (const rule of extra) registry.register(rule)
  return { registry, evaluate: registry.createEvaluator(), collapse, trim }
}

function visible(nodes: readonly UserTextNode[]): string {
  return nodes.map(node => node.id === 'text' ? node.data.display ?? node.data.text : `[${node.id}]`).join('')
}

function assertSource(text: string, nodes: readonly UserTextNode[]): void {
  let cursor = 0
  for (const node of nodes) {
    expect(node.start).toBe(cursor)
    expect(node.end).toBeGreaterThan(cursor)
    if (node.id === 'text') expect(node.data.text).toBe(text.slice(node.start, node.end))
    cursor = node.end
  }
  expect(cursor).toBe(text.length)
  expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes)
}

describe('ordinary whitespace matchers', () => {
  it('uses the sole rule interface and keeps switches distinct from React props', () => {
    expectTypeOf(collapseWhitespaceRule).toExtend<UserTextRule>()
    expectTypeOf(trimWhitespaceRule).toExtend<UserTextRule>()
    expectTypeOf<UserTextRule>().not.toHaveProperty('transform')
    expectTypeOf<UserTextFacts['collapseWhitespace']>().toEqualTypeOf<boolean>()
    expectTypeOf<UserTextFacts['trimWhitespace']>().toEqualTypeOf<boolean>()
    expectTypeOf<UserTextFacts>().not.toHaveProperty('ellipsis')
    expectTypeOf<UserTextFacts>().not.toHaveProperty('interactive')
    expect(trimWhitespaceRule.order).toBeLessThan(collapseWhitespaceRule.order)
  })

  it.each(['', '  原文\r\n\t🙂e\u0301  '])('keeps missing switches as a cached no-match result for %j', (text) => {
    const k = setup()
    const original = k.evaluate({ text, facts: {} })
    expect(visible(original)).toBe(text)
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0])
    expect(k.collapse.mock.calls.map(([, from]) => from)).toEqual([0])
    expect(k.evaluate({ text, facts: { sessionLabels: ['new'] } })).toBe(original)
    expect(k.trim).toHaveBeenCalledOnce()
    expect(k.collapse).toHaveBeenCalledOnce()
    assertSource(text, original)
  })

  it('resolves edge collisions in favor of trim and keeps raw substrings in every Text candidate', () => {
    const k = setup()
    const text = ' \tA\n  B \r'
    const nodes = k.evaluate({ text, facts: { collapseWhitespace: true, trimWhitespace: true } })
    expect(nodes).toEqual([
      { id: 'text', start: 0, end: 2, data: { text: ' \t', display: '' } },
      { id: 'text', start: 2, end: 3, data: { text: 'A' } },
      { id: 'text', start: 3, end: 6, data: { text: '\n  ', display: ' ' } },
      { id: 'text', start: 6, end: 7, data: { text: 'B' } },
      { id: 'text', start: 7, end: 9, data: { text: ' \r', display: '' } },
    ])
    expect(visible(nodes)).toBe('A B')
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0, 2, 9])
    expect(k.collapse.mock.calls.map(([, from]) => from)).toEqual([0, 2, 6, 9])
    assertSource(text, nodes)
  })

  it('refreshes only the switch reader while reusing the competing whitespace query sequence', () => {
    const k = setup()
    const text = ' \tA\n  B \r'
    const collapseOnly = k.evaluate({ text, facts: { collapseWhitespace: true } })
    expect(visible(collapseOnly)).toBe(' A B ')
    k.trim.mockClear(); k.collapse.mockClear()
    const both = k.evaluate({ text, facts: { collapseWhitespace: true, trimWhitespace: true } })
    expect(visible(both)).toBe('A B')
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0, 2, 9])
    expect(k.collapse).not.toHaveBeenCalled()
    k.trim.mockClear()
    expect(k.evaluate({ text, facts: { collapseWhitespace: true, trimWhitespace: false } })).toEqual(collapseOnly)
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0])
    expect(k.collapse).not.toHaveBeenCalled()
  })

  it('lets cached collapse candidates win after trim is disabled without repeating their search', () => {
    const k = setup()
    const text = ' \t\n'
    const original = k.evaluate({ text, facts: { collapseWhitespace: true, trimWhitespace: true } })
    expect(visible(original)).toBe('')
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0, text.length])
    expect(k.collapse.mock.calls.map(([, from]) => from)).toEqual([0, text.length])
    k.trim.mockClear(); k.collapse.mockClear()
    expect(visible(k.evaluate({ text, facts: { collapseWhitespace: true } }))).toBe(' ')
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0])
    expect(k.collapse).not.toHaveBeenCalled()
  })

  it('keeps reference whitespace atomic through earlier-start competition, not a processing phase', () => {
    const reference = vi.fn(sessionReferenceRule.match)
    const k = setup([{ ...sessionReferenceRule, order: 100_000, match: reference }])
    const wire = '@[two  words](dsh-session:x)'
    const text = ` \t🙂甲\n ${wire} \r\n乙 \t`
    const original = k.evaluate({ text, facts: {} })
    reference.mockClear()
    const nodes = k.evaluate({ text, facts: { collapseWhitespace: true, trimWhitespace: true } })
    expect(visible(nodes)).toBe('🙂甲 [session] 乙')
    expect(nodes.find(node => node.id === 'session')).toBe(original.find(node => node.id === 'session'))
    expect(nodes.find(node => node.id === 'session')?.data).toEqual({ label: 'two  words' })
    expect(reference).not.toHaveBeenCalled()
    assertSource(text, nodes)
  })

  it.each([
    [' \t🙂 \n甲  👨‍👩‍👧‍👦\t 乙🇨🇳 \t', '🙂 甲 👨‍👩‍👧‍👦 乙🇨🇳'],
    ['\u00a0甲\r\n乙\u3000', '甲 乙'],
    ['甲 乙123', '甲 乙123'],
    ['', ''],
  ])('preserves emoji and collapses original whitespace in %j', (text, expected) => {
    const k = setup()
    const facts = { collapseWhitespace: true, trimWhitespace: true }
    const nodes = k.evaluate({ text, facts })
    expect(visible(nodes)).toBe(expected)
    assertSource(text, nodes)
    expect(visible(k.evaluate({ text, facts: { trimWhitespace: true } }))).toBe(text.trim())
    expect(visible(k.evaluate({ text, facts: {} }))).toBe(text)
    expect(k.evaluate({ text, facts })).toEqual(k.registry.createEvaluator()({ text, facts }))
  })

  it('ignores unrelated Facts without limiting long original text', () => {
    const k = setup()
    const text = `  ${'原文🙂\n'.repeat(100)}  `
    const facts = { collapseWhitespace: true, trimWhitespace: true }
    const nodes = k.evaluate({ text, facts })
    k.trim.mockClear(); k.collapse.mockClear()
    expect(k.evaluate({ text, facts: { ...facts, sessionLabels: ['changed'] } })).toBe(nodes)
    expect(k.trim).not.toHaveBeenCalled()
    expect(k.collapse).not.toHaveBeenCalled()
    assertSource(text, nodes)
  })

  it('keeps unchanged output identity when enabled matchers find no replacement', () => {
    const k = setup()
    const input = { text: '甲 乙123', facts: {} }
    const original = k.evaluate(input)
    expect(k.evaluate({ ...input, facts: { collapseWhitespace: true, trimWhitespace: true } })).toBe(original)
  })

  it.each([
    [' \n@[a](dsh-session:x) \t @[b](dsh-session:y) \t', '[session] \t [session]'],
    ['@[a](dsh-session:x) \t 甲 \n @[b](dsh-session:y)', '[session] \t 甲 \n [session]'],
    ['@[a](dsh-session:x) \t 甲 \n', '[session] \t 甲'],
    [' \t 甲 \n @[b](dsh-session:y)', '甲 \n [session]'],
  ])('does not trim through references or delete internal spacing in %s', (text, expected) => {
    const k = setup([sessionReferenceRule])
    const nodes = k.evaluate({ text, facts: { trimWhitespace: true } })
    expect(visible(nodes)).toBe(expected)
    assertSource(text, nodes)
  })

  it('handles long interior and trailing whitespace without changing source ranges', () => {
    const k = setup()
    const middle = `a${' '.repeat(80_000)}b`
    expect(visible(k.evaluate({ text: middle, facts: { trimWhitespace: true } }))).toBe(middle)
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0])
    k.trim.mockClear()
    const trailing = `a${' \t\u00a0'.repeat(20_000)}`
    const nodes = k.evaluate({ text: trailing, facts: { trimWhitespace: true } })
    expect(visible(nodes)).toBe('a')
    expect(nodes.at(-1)).toEqual({ id: 'text', start: 1, end: trailing.length,
      data: { text: trailing.slice(1), display: '' } })
    expect(k.trim.mock.calls.map(([, from]) => from)).toEqual([0, trailing.length])
    assertSource(trailing, nodes)
  })

  it('does not invent another original whitespace-run start inside a consumed run', () => {
    const facts: Partial<UserTextFacts> = { collapseWhitespace: true, trimWhitespace: true }
    const read = <K extends keyof UserTextFacts>(key: K) => facts[key]
    expect(collapseWhitespaceRule.match('   x', 1, { read })).toBeUndefined()
    expect(trimWhitespaceRule.match('   x', 1, { read })).toBeUndefined()
  })
})
