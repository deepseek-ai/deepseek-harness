import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import type {
  UserTextDataMap, UserTextEvaluator, UserTextNode, UserTextRule,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'

type JsonValue = string | number | null | readonly string[] | { readonly value: string }

interface AnnotationData {
  readonly label: string
  readonly nested?: { readonly values: readonly (string | number | boolean | null)[] }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'test.annotation': AnnotationData
    'test.json': { readonly value: JsonValue }
    'test.A': { readonly label: string }
    'test.a': { readonly label: string }
    'test.z': { readonly label: string }
    '': { readonly label: string }
    'test.function': { readonly callback: () => void }
    'test.date': { readonly date: Date }
    'test.map': { readonly map: Map<string, string> }
    'test.symbol': { readonly symbol: symbol }
    'test.bigint': { readonly bigint: bigint }
    'test.unknown': { readonly value: unknown }
    'test.nested': { readonly values: readonly { readonly action: () => void }[] }
  }
  interface UserTextFacts {
    readonly testEnabled: boolean
    readonly testLabel: string
    readonly testNested: NonNullable<AnnotationData['nested']>
    readonly testOther: number
    readonly testJson: JsonValue
    readonly skillNames: readonly string[]
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { userTextTestRegistry: UserTextRegistry }
}

function setup(): { ctx: Context; registry: UserTextRegistry } {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, registry: new UserTextRegistry(ctx) }
}

type TestId = 'test.A' | 'test.a' | 'test.z' | ''

function plain(text: string, start = 0): UserTextNode<'text'> {
  return { id: 'text', start, end: start + text.length, data: { text } }
}

function rule(id: TestId, order: number, needle: string): UserTextRule<TestId> {
  return { id, order, match(text, from) {
    const start = text.indexOf(needle, from)
    return start < 0 ? undefined : { id, start, end: start + needle.length, data: { label: id } }
  } }
}

function assertCoverage(text: string, nodes: readonly UserTextNode[]): void {
  let cursor = 0
  for (const node of nodes) {
    expect(node.start).toBe(cursor)
    expect(node.end).toBeGreaterThan(node.start)
    if (node.id === 'text') expect(node.data.text).toBe(text.slice(node.start, node.end))
    cursor = node.end
  }
  expect(cursor).toBe(text.length)
  expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes)
}

describe('UserTextRegistry candidate rules', () => {
  it('queries every matcher for empty and nonempty original text', () => {
    const { registry } = setup()
    const match = vi.fn((_text: string, _from: number) => undefined)
    registry.register({ id: 'test.a', order: 0, match })
    const evaluate = registry.createEvaluator()
    expectTypeOf(evaluate).toEqualTypeOf<UserTextEvaluator>()
    expect(evaluate({ text: '', facts: {} })).toEqual([])
    const text = '  原文\r\n\t🙂e\u0301 /path @name  '
    const nodes = evaluate({ text, facts: {} })
    expect(nodes).toEqual([plain(text)])
    expect(match.mock.calls.map(([text, from]) => [text, from])).toEqual([['', 0], [text, 0]])
    assertCoverage(text, nodes)
  })

  it.each([
    [rule('test.a', 10, 'bc'), rule('test.z', -1, 'cde'), 'test.a'],
    [rule('test.a', -1, 'bc'), rule('test.z', 0, 'bcde'), 'test.a'],
    [rule('test.a', 0, 'bc'), rule('test.z', 0, 'bcde'), 'test.a'],
    [rule('test.A', 0, 'bc'), rule('test.a', 0, 'bcde'), 'test.A'],
  ] as const)('selects by start, then order and code-unit ID independently of load order (%j, %j)', (a, z, id) => {
    const { registry: forward } = setup()
    const { registry: reverse } = setup()
    forward.register(a)
    forward.register(z)
    reverse.register(z)
    reverse.register(a)
    const input = { text: 'abcde', facts: {} }
    const nodes = forward.createEvaluator()(input)
    expect(nodes.filter(node => node.id !== 'text').map(node => node.id)).toEqual([id])
    expect(reverse.createEvaluator()(input)).toEqual(nodes)
  })

  it('has one candidate interface for business and Text nodes', () => {
    expectTypeOf<UserTextRule>().not.toHaveProperty('phase')
    expectTypeOf<UserTextRule>().not.toHaveProperty('transform')
    expectTypeOf<Parameters<UserTextRule['match']>[0]>().toEqualTypeOf<string>()
    expectTypeOf<Parameters<UserTextRule['match']>[1]>().toEqualTypeOf<number>()
    const { registry } = setup()
    registry.register({ id: 'text.replacement', order: 10, match: (text, from) => from > 1 ? undefined : {
      id: 'text', start: 1, end: 2, data: { text: text.slice(1, 2), display: 'B' },
    } })
    const nodes = registry.createEvaluator()({ text: 'abc', facts: {} })
    expect(nodes).toEqual([plain('a'), { ...plain('b', 1), data: { text: 'b', display: 'B' } }, plain('c', 2)])
    assertCoverage('abc', nodes)
  })

  it.each(['xyz', '', 'ab'])('rejects a Text candidate whose raw value is %j for the original abc', (raw) => {
    const { registry } = setup()
    registry.register({ id: 'text.bad', order: 0, match: () => ({ id: 'text', start: 0, end: 3, data: { text: raw, display: 'abc' } }) })
    expect(() => registry.createEvaluator()({ text: 'abc', facts: {} })).toThrow(/text.bad/)
  })

  it('keeps nodes readonly without freezing borrowed payloads', () => {
    expectTypeOf<UserTextNode<'text'>>().toEqualTypeOf<Readonly<UserTextNode<'text'>>>()
    expectTypeOf<UserTextNode<'text'>['data']>().toEqualTypeOf<{ readonly text: string; readonly display?: string }>()
    const { registry } = setup()
    const nested = { values: ['borrowed'] }
    const definition: UserTextRule<'test.annotation'> = {
      id: 'test.annotation', order: 0,
      match: (_text, from, context) => {
        if (from > 0) return undefined
        const value = context.read('testNested')
        if (value === undefined) throw new Error('Missing test payload')
        return { id: 'test.annotation', start: 0, end: 1, data: { label: 'x', nested: value } }
      },
    }
    registry.register(definition)
    const nodes = registry.createEvaluator()({ text: 'x', facts: { testNested: nested } })
    if (nodes[0]?.id !== 'test.annotation') throw new Error('Missing annotation')
    expect(nodes[0].data.nested).toBe(nested)
    for (const value of [definition, nodes, nodes[0], nested, nested.values]) expect(Object.isFrozen(value)).toBe(false)
  })

  it('reuses equivalent nested JSON despite key order and changes only unequal payloads', () => {
    const { registry } = setup()
    const match = vi.fn((_text: string, from: number, context: Parameters<UserTextRule['match']>[2]): UserTextNode<'test.annotation'> | undefined => {
      if (from > 0) return undefined
      const label = context.read('testLabel') ?? 'same'
      const version = context.read('testOther') ?? 0
      const nested = { values: ['文字', 3, true, null] }
      return { id: 'test.annotation', start: 0, end: 3, data: version % 2 ? { nested, label } : { label, nested } }
    })
    registry.register({ id: 'test.annotation', order: 0, match })
    const evaluate = registry.createEvaluator()
    const original = evaluate({ text: 'abc', facts: {} })
    expect(evaluate({ text: 'abc', facts: { testOther: 1 } })).toBe(original)
    const changed = evaluate({ text: 'abc', facts: { testOther: 2, testLabel: 'changed' } })
    expect(changed[0]?.data).toMatchObject({ label: 'changed' })
    expect(changed).not.toBe(original)
    expect(evaluate({ text: 'abc', facts: { testOther: 3, testLabel: 'changed' } })).toBe(changed)
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, 3, 0, 3, 0, 3, 0, 3])
  })

  it('distinguishes arrays, objects, null and primitive payloads while reusing equal values', () => {
    const { registry } = setup()
    const match = vi.fn((_text: string, from: number, context: Parameters<UserTextRule['match']>[2]): UserTextNode<'test.json'> | undefined => {
      if (from > 0) return undefined
      return { id: 'test.json', start: 0, end: 1, data: { value: context.read('testJson') ?? null } }
    })
    registry.register({ id: 'test.json', order: 0, match })
    const evaluate = registry.createEvaluator()
    let previous = evaluate({ text: 'x', facts: { testJson: ['value'] } })
    for (const value of [{ value: 'value' }, ['value'], null, 'value', 1] satisfies JsonValue[]) {
      const nodes = evaluate({ text: 'x', facts: { testJson: value } })
      expect(nodes).not.toBe(previous)
      expect(nodes[0]?.data).toEqual({ value })
      expect(evaluate({ text: 'x', facts: { testJson: value } })).toBe(nodes)
      previous = nodes
    }
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
  })

  it('constrains declaration-merged JSON payloads recursively', () => {
    expectTypeOf<UserTextNode<'test.annotation'>['data']>().toExtend<AnnotationData>()
    expectTypeOf<UserTextDataMap['test.function']>().not.toExtend<UserTextNode<'test.function'>['data']>()
    expectTypeOf<UserTextDataMap['test.date']>().not.toExtend<UserTextNode<'test.date'>['data']>()
    expectTypeOf<UserTextDataMap['test.map']>().not.toExtend<UserTextNode<'test.map'>['data']>()
    expectTypeOf<UserTextDataMap['test.symbol']>().not.toExtend<UserTextNode<'test.symbol'>['data']>()
    expectTypeOf<UserTextDataMap['test.bigint']>().not.toExtend<UserTextNode<'test.bigint'>['data']>()
    expectTypeOf<UserTextDataMap['test.unknown']>().not.toExtend<UserTextNode<'test.unknown'>['data']>()
    expectTypeOf<UserTextDataMap['test.nested']>().not.toExtend<UserTextNode<'test.nested'>['data']>()
  })

  it.each([
    [-1, 1], [0, 0], [2, 1], [0, 4], [0.5, 1], [0, 1.5], [NaN, 1], [0, Infinity],
  ])('rejects invalid UTF-16 range [%s, %s)', (start, end) => {
    const { registry } = setup()
    registry.register({ id: 'test.a', order: 0, match: () => ({ id: 'test.a', start, end, data: { label: 'bad' } }) })
    expect(() => registry.createEvaluator()({ text: 'abc', facts: {} })).toThrow(/test\.a/)
  })

  it.each([Infinity, -Infinity, NaN])('rejects invalid order %s before publication', (order) => {
    const { registry } = setup()
    const revision = registry.getSnapshot()
    const listener = vi.fn()
    registry.subscribe(listener)
    expect(() => registry.register(rule('test.a', order, 'x'))).toThrow(/test\.a/)
    expect(registry.getSnapshot()).toBe(revision)
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects empty, reserved and duplicate IDs without changing revision', () => {
    const { registry } = setup()
    registry.register(rule('test.a', 0, 'x'))
    const revision = registry.getSnapshot()
    expect(() => registry.register(rule('', 0, 'x'))).toThrow(/id|ID/)
    expect(() => registry.register({ id: 'text', order: 0, match: () => undefined })).toThrow(/text/)
    expect(() => registry.register(rule('test.a', 1, 'x'))).toThrow(/test\.a/)
    expect(registry.getSnapshot()).toBe(revision)
  })

  it('publishes monotonic revisions and evaluates current rules without document subscriptions', () => {
    const { registry } = setup()
    const subscribe = vi.spyOn(registry, 'subscribe')
    const evaluate = registry.createEvaluator()
    expect(subscribe).not.toHaveBeenCalled()
    const revision = registry.getSnapshot()
    expectTypeOf(revision).toEqualTypeOf<number>()
    const seen: number[] = []
    const unsubscribe = registry.subscribe(() => { seen.push(registry.getSnapshot()) })
    const dispose = registry.register(rule('test.a', 0, 'a'))
    expect(registry.getSnapshot()).toBeGreaterThan(revision)
    const input = { text: 'abc', facts: {} }
    expect(evaluate(input)[0]?.id).toBe('test.a')
    dispose()
    expect(evaluate(input)).toEqual([plain('abc')])
    expect(seen[1]).toBeGreaterThan(seen[0]!)
    dispose()
    expect(seen).toHaveLength(2)
    unsubscribe()
    unsubscribe()
    registry.register(rule('test.a', 0, 'b'))
    dispose()
    expect(evaluate(input)[1]?.id).toBe('test.a')
    expect(seen).toHaveLength(2)
  })

  it('removes only the contributing fiber rules and cleans root registrations on disposal', async () => {
    const { ctx, registry } = setup()
    ctx.provide('userTextTestRegistry', registry)
    registry.register(rule('test.a', 0, 'a'))
    const feature = ctx.inject(['userTextTestRegistry'], (featureCtx) => {
      featureCtx.userTextTestRegistry.register(rule('test.z', 0, 'b'))
    })
    await feature.await()
    const evaluate = registry.createEvaluator()
    expect(evaluate({ text: 'ab', facts: {} }).map(node => node.id)).toEqual(['test.a', 'test.z'])
    await feature.dispose()
    expect(evaluate({ text: 'ab', facts: {} }).map(node => node.id)).toEqual(['test.a', 'text'])
    await ctx.fiber.dispose()
    expect(evaluate({ text: 'ab', facts: {} })).toEqual([plain('ab')])
  })
})

describe('sessionReferenceRule', () => {
  it('folds wire syntax to JSON label data while retaining the full original range', async () => {
    const { sessionReferenceRule } = await import('../src/client/user-text/session-reference-rule.ts')
    const { registry } = setup()
    registry.register(sessionReferenceRule)
    const wire = '@[查看并分析图片](dsh-session:InNlc3Npb24tNDM0)'
    const text = `看看 ${wire} 的结论`
    const nodes = registry.createEvaluator()({ text, facts: {} })
    expect(nodes).toEqual([
      plain('看看 '), { id: 'session', start: 3, end: 3 + wire.length, data: { label: '查看并分析图片' } },
      plain(' 的结论', 3 + wire.length),
    ])
    assertCoverage(text, nodes)
  })

  it('uses exact supplied labels, keeps the longest spelling and preserves repeated occurrences', async () => {
    const { sessionReferenceRule } = await import('../src/client/user-text/session-reference-rule.ts')
    const { registry } = setup()
    registry.register(sessionReferenceRule)
    const evaluate = registry.createEvaluator()
    const text = '@会话一 收尾 @会话一， @会话 @未知'
    const nodes = evaluate({ text, facts: { sessionLabels: ['会话', '会话一', '会话一'] } })
    expect(nodes.filter(node => node.id === 'session').map(node => ({ raw: text.slice(node.start, node.end), data: node.data })))
      .toEqual([
        { raw: '@会话一', data: { label: '会话一' } }, { raw: '@会话一', data: { label: '会话一' } },
        { raw: '@会话', data: { label: '会话' } },
      ])
    assertCoverage(text, nodes)
    expect(evaluate({ text: '@会话', facts: {} })).toEqual([plain('@会话')])
  })

  it('prefers complete wire syntax over an overlapping supplied label', async () => {
    const { sessionReferenceRule } = await import('../src/client/user-text/session-reference-rule.ts')
    const { registry } = setup()
    registry.register(sessionReferenceRule)
    const text = '@[a](dsh-session:x)'
    expect(registry.createEvaluator()({ text, facts: { sessionLabels: ['[a]'] } })).toEqual([
      { id: 'session', start: 0, end: text.length, data: { label: 'a' } },
    ])
  })
})
