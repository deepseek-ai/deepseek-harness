/** Candidate scheduling is measured by calls and query offsets, never clocks. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  UserTextFacts, UserTextRule, UserTextNode, UserTextTransformContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'

interface Range { readonly start: number; readonly end: number; readonly label: string }
type Id = 'schedule.a' | 'schedule.b' | 'schedule.c'
type Field = 'scheduleA' | 'scheduleB' | 'scheduleC'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'schedule.a': { readonly label: string }
    'schedule.b': { readonly label: string }
    'schedule.c': { readonly label: string }
  }
  interface UserTextFacts {
    readonly scheduleA: readonly Range[]
    readonly scheduleB: readonly Range[]
    readonly scheduleC: readonly Range[]
    readonly scheduleEnabled: boolean
    readonly scheduleOther: number
  }
}

const TEXT = '0123456789'.repeat(4)
const range = (start: number, end: number, label = `${start}:${end}`): Range => ({ start, end, label })

function setup(rules: readonly UserTextRule[] = []) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new UserTextRegistry(ctx)
  for (const rule of rules) registry.register(rule)
  return { registry, evaluate: registry.createEvaluator() }
}

function tracked(id: Id, field: Field, order: number) {
  const match = vi.fn((text: string, from: number, context: UserTextTransformContext): UserTextNode<Id> | undefined => {
    expect(text).toBe(TEXT)
    const candidates = context.read(field) ?? []
    let best: Range | undefined
    for (const item of candidates) {
      if (item.start >= from && (best === undefined || item.start < best.start
        || (item.start === best.start && item.end > best.end))) best = item
    }
    return best === undefined ? undefined : { id, start: best.start, end: best.end, data: { label: best.label } }
  })
  const rule: UserTextRule<Id> = { id, order, match }
  return { rule, match, calls: () => match.mock.calls.map(([, from]) => from) }
}

function kit() {
  const a = tracked('schedule.a', 'scheduleA', 0)
  const b = tracked('schedule.b', 'scheduleB', 1)
  const c = tracked('schedule.c', 'scheduleC', 2)
  const fixture = setup([c.rule, b.rule, a.rule])
  const evaluate = (facts: Readonly<Partial<UserTextFacts>>) => fixture.evaluate({ text: TEXT, facts })
  const clear = () => { a.match.mockClear(); b.match.mockClear(); c.match.mockClear() }
  return { ...fixture, a, b, c, evaluate, clear }
}

function business(nodes: readonly UserTextNode[]) {
  return nodes.filter(node => node.id !== 'text').map(node => [node.id, node.start, node.end, node.data])
}

function coverage(nodes: readonly UserTextNode[], text = TEXT) {
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

describe('UserText candidate scheduling', () => {
  it('keeps future candidates and exhausted matchers while advancing only consumed heads', () => {
    const k = kit()
    const nodes = k.evaluate({ scheduleA: [range(2, 4), range(12, 15)], scheduleB: [range(7, 9), range(18, 20)] })
    expect(k.a.calls()).toEqual([0, 4, 15])
    expect(k.b.calls()).toEqual([0, 9, 20])
    expect(k.c.calls()).toEqual([0])
    expect(nodes.filter(node => node.id !== 'text').map(node => node.start)).toEqual([2, 7, 12, 18])
    coverage(nodes)
  })

  it('queries overlapping heads at the winner end, without enumerating covered candidates', () => {
    const k = kit()
    const nodes = k.evaluate({ scheduleA: [range(2, 10)], scheduleB: [range(4, 6), range(8, 9), range(12, 14)] })
    expect(k.a.calls()).toEqual([0, 10])
    expect(k.b.calls()).toEqual([0, 10, 14])
    expect(k.c.calls()).toEqual([0])
    expect(nodes.filter(node => node.id !== 'text').map(node => [node.id, node.start])).toEqual([
      ['schedule.a', 2], ['schedule.b', 12],
    ])
    coverage(nodes)
  })

  it('retains a candidate exactly at the new cursor and queries once at a consumed text end', () => {
    const k = kit()
    k.evaluate({ scheduleA: [range(0, 4)], scheduleB: [range(4, TEXT.length)] })
    expect(k.a.calls()).toEqual([0, 4])
    expect(k.b.calls()).toEqual([0, TEXT.length])
    expect(k.c.calls()).toEqual([0])
  })

  it.each(['', 'plain'])('initializes Facts-free matchers even for %j', (text) => {
    const a = vi.fn((_text: string, _from: number) => undefined)
    const b = vi.fn((_text: string, _from: number) => undefined)
    const { evaluate } = setup([{ id: 'schedule.a', order: 0, match: a }, { id: 'schedule.b', order: 1, match: b }])
    const first = evaluate({ text, facts: {} })
    expect(a.mock.calls.map(([, from]) => from)).toEqual([0])
    expect(b.mock.calls.map(([, from]) => from)).toEqual([0])
    expect(evaluate({ text, facts: { scheduleOther: 1 } })).toBe(first)
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    coverage(first, text)
  })

  it('ignores unrelated fields and outer Facts identity without querying any matcher', () => {
    const k = kit()
    const facts = { scheduleA: [range(2, 4)], scheduleB: [range(7, 9)] }
    const before = k.evaluate(facts)
    k.clear()
    expect(k.evaluate({ ...facts, scheduleOther: 1 })).toBe(before)
    expect(k.evaluate({ ...facts, scheduleOther: 2 })).toBe(before)
    expect([k.a.calls(), k.b.calls(), k.c.calls()]).toEqual([[], [], []])
  })

  it('replays only one changed matcher and retains equivalent output identities', () => {
    const k = kit()
    const facts = { scheduleA: [range(2, 4), range(12, 15)], scheduleB: [range(7, 9), range(18, 20)] }
    const before = k.evaluate(facts)
    k.clear()
    const after = k.evaluate({ ...facts, scheduleA: facts.scheduleA.map(item => ({ ...item })) })
    expect(after).toBe(before)
    expect(k.a.calls()).toEqual([0, 4, 15])
    expect(k.b.calls()).toEqual([])
    expect(k.c.calls()).toEqual([])
  })

  it('changes one payload without calling other matchers or replacing unrelated nodes', () => {
    const k = kit()
    const facts = { scheduleA: [range(2, 4)], scheduleB: [range(7, 9)] }
    const before = k.evaluate(facts)
    k.clear()
    const after = k.evaluate({ ...facts, scheduleA: [range(2, 4, 'new')] })
    expect(after[1]?.data).toEqual({ label: 'new' })
    expect(after[1]).not.toBe(before[1])
    for (const index of [0, 2, 3, 4]) expect(after[index]).toBe(before[index])
    expect([k.a.calls(), k.b.calls(), k.c.calls()]).toEqual([[0, 4], [], []])
  })

  it('inserts into old plain text without querying unaffected matchers', () => {
    const k = kit()
    const facts = { scheduleA: [range(2, 4), range(12, 15)], scheduleB: [range(7, 9), range(18, 20)] }
    const before = k.evaluate(facts)
    k.clear()
    const next = { ...facts, scheduleA: [range(2, 4), range(5, 6), range(12, 15)] }
    const after = k.evaluate(next)
    expect([k.a.calls(), k.b.calls(), k.c.calls()]).toEqual([[0, 4, 6, 15], [], []])
    for (const node of before.filter(node => node.id === 'schedule.b')) expect(after).toContain(node)
    expect(after).toEqual(k.registry.createEvaluator()({ text: TEXT, facts: next }))
    coverage(after)
  })

  it('rejects refreshed candidates covered by an unchanged earlier winner without querying that winner', () => {
    const k = kit()
    const facts = { scheduleA: [range(0, 10)], scheduleB: [] }
    const before = k.evaluate(facts)
    k.clear()
    expect(k.evaluate({ ...facts, scheduleB: [range(4, 6)] })).toBe(before)
    expect([k.a.calls(), k.b.calls(), k.c.calls()]).toEqual([[], [0, 10], []])
  })

  it('queries only an uncovered offset when a refreshed winner extends across another head', () => {
    const k = kit()
    const facts = { scheduleA: [range(2, 4), range(12, 15)], scheduleB: [range(7, 9), range(18, 20)] }
    const before = k.evaluate(facts)
    k.clear()
    const next = { ...facts, scheduleA: [range(2, 8), range(12, 15)] }
    const after = k.evaluate(next)
    expect([k.a.calls(), k.b.calls(), k.c.calls()]).toEqual([[0, 8, 15], [8], []])
    expect(after.filter(node => node.id === 'schedule.b').map(node => node.start)).toEqual([18])
    expect(after).toEqual(k.registry.createEvaluator()({ text: TEXT, facts: next }))
    k.clear()
    expect(k.evaluate(facts)).toEqual(before)
    expect(k.b.calls()).toEqual([])
    expect(k.c.calls()).toEqual([])
  })

  it.each(['remove', 'shrink'] as const)('exposes cached losers and unsearched gaps when a winner changes: %s', (action) => {
    const k = kit()
    const facts = {
      scheduleA: [range(0, 10)], scheduleB: [range(2, 3), range(5, 6), range(12, 14)], scheduleC: [range(4, 5)],
    }
    k.evaluate(facts)
    expect(k.b.calls()).toEqual([0, 10, 14])
    expect(k.c.calls()).toEqual([0, 10])
    k.clear()
    const next = { ...facts, scheduleA: action === 'remove' ? [] : [range(0, 2)] }
    const after = k.evaluate(next)
    expect(k.a.calls()).toEqual(action === 'remove' ? [0] : [0, 2])
    expect(k.b.calls()).toEqual([3, 6])
    expect(k.c.calls()).toEqual([5])
    expect(after.filter(node => node.id === 'schedule.b').map(node => node.start)).toEqual([2, 5, 12])
    expect(after).toEqual(k.registry.createEvaluator()({ text: TEXT, facts: next }))
    k.clear()
    k.evaluate(facts)
    k.clear()
    k.evaluate(next)
    expect(k.b.calls()).toEqual([])
    expect(k.c.calls()).toEqual([])
    coverage(after)
  })

  it('removes an old early winner even when the new first candidate occurs much later', () => {
    const k = kit()
    const facts = { scheduleA: [range(2, 4), range(12, 15)], scheduleB: [range(7, 9)] }
    k.evaluate(facts)
    k.clear()
    const next = { ...facts, scheduleA: [range(12, 15)] }
    const after = k.evaluate(next)
    expect([k.a.calls(), k.b.calls(), k.c.calls()]).toEqual([[0, 15], [], []])
    expect(after[0]).toEqual({ id: 'text', start: 0, end: 7, data: { text: TEXT.slice(0, 7) } })
    expect(after).toEqual(k.registry.createEvaluator()({ text: TEXT, facts: next }))
  })

  it('reconciles two changed matchers together instead of giving update order precedence', () => {
    const k = kit()
    k.evaluate({ scheduleA: [range(2, 4)], scheduleB: [range(7, 9)] })
    k.clear()
    const facts = { scheduleB: [range(2, 5)], scheduleA: [range(7, 10)] }
    const after = k.evaluate(facts)
    expect([k.a.calls(), k.b.calls(), k.c.calls()]).toEqual([[0, 10], [0, 5], []])
    expect(after.filter(node => node.id !== 'text').map(node => node.id)).toEqual(['schedule.b', 'schedule.a'])
    expect(after).toEqual(k.registry.createEvaluator()({ text: TEXT, facts }))
  })

  it('refreshes a matcher once when two of its read fields change', () => {
    const match = vi.fn((_text: string, _from: number, context: UserTextTransformContext) => {
      context.read('scheduleA')
      context.read('scheduleB')
      return undefined
    })
    const { evaluate } = setup([{ id: 'schedule.a', order: 0, match }])
    evaluate({ text: TEXT, facts: {} })
    match.mockClear()
    evaluate({ text: TEXT, facts: { scheduleA: [], scheduleB: [] } })
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0])
  })

  it('tracks missing fields and replaces conditional dependencies when the cache generation changes', () => {
    const match = vi.fn((_text: string, from: number, context: UserTextTransformContext): UserTextNode<'schedule.a'> | undefined => {
      if (!context.read('scheduleEnabled')) return undefined
      const item = context.read('scheduleA')?.find(item => item.start >= from)
      return item === undefined ? undefined : { id: 'schedule.a', start: item.start, end: item.end, data: { label: item.label } }
    })
    const { evaluate } = setup([{ id: 'schedule.a', order: 0, match }])
    evaluate({ text: TEXT, facts: {} })
    evaluate({ text: TEXT, facts: { scheduleEnabled: true } })
    const facts = { scheduleEnabled: true, scheduleA: [range(2, 4)] }
    expect(business(evaluate({ text: TEXT, facts }))).toEqual([['schedule.a', 2, 4, { label: '2:4' }]])
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, 0, 0, 4])
    evaluate({ text: TEXT, facts: { ...facts, scheduleEnabled: false } })
    match.mockClear()
    evaluate({ text: TEXT, facts: { scheduleEnabled: false, scheduleA: [range(8, 9)] } })
    expect(match).not.toHaveBeenCalled()
  })

  it('tracks reads of losing and no-match queries across a generation', () => {
    const k = kit()
    const facts = { scheduleA: [range(0, 10)], scheduleB: [range(3, 5)] }
    const original = k.evaluate(facts)
    k.clear()
    const changed = k.evaluate({ ...facts, scheduleB: [range(12, 14)], scheduleC: [range(20, 22)] })
    expect(k.a.calls()).toEqual([])
    expect(k.b.calls()).toEqual([0, 14])
    expect(k.c.calls()).toEqual([0, 22])
    expect(changed[0]).toBe(original[0])
    expect(changed.filter(node => node.id !== 'text').map(node => node.start)).toEqual([0, 12, 20])
  })

  it('keeps exact-offset failures cached and retries after a missing dependency appears', () => {
    const cause = new Error('not ready')
    const match = vi.fn((_text: string, from: number, context: UserTextTransformContext): UserTextNode<'schedule.a'> | undefined => {
      if (from > 0) return undefined
      if (!context.read('scheduleEnabled')) throw cause
      return { id: 'schedule.a', start: 0, end: 1, data: { label: 'ready' } }
    })
    const { evaluate } = setup([{ id: 'schedule.a', order: 0, match }])
    let failure: unknown
    try { evaluate({ text: TEXT, facts: {} }) } catch (error) { failure = error }
    expect(failure).toHaveProperty('ruleId', 'schedule.a')
    expect(failure).toHaveProperty('cause', cause)
    expect(() => evaluate({ text: TEXT, facts: { scheduleOther: 1 } })).toThrow(failure)
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0])
    match.mockClear()
    expect(evaluate({ text: TEXT, facts: { scheduleEnabled: true } })[0]?.data).toEqual({ label: 'ready' })
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, 1])
  })

  it('reuses a failed query only at its exact offset, not as a negative range answer', () => {
    const a = tracked('schedule.a', 'scheduleA', 0)
    const cause = new Error('offset-three failure')
    const b = vi.fn((_text: string, from: number): UserTextNode<'schedule.b'> | undefined => {
      if (from === 3) throw cause
      return from === 0 ? { id: 'schedule.b', start: 1, end: 2, data: { label: 'hidden' } } : undefined
    })
    const { evaluate } = setup([a.rule, { id: 'schedule.b', order: 1, match: b }])
    const old = { scheduleA: [range(0, 3)] }
    expect(() => evaluate({ text: TEXT, facts: old })).toThrow(/schedule.b/)
    expect(b.mock.calls.map(([, from]) => from)).toEqual([0, 3])
    a.match.mockClear(); b.mockClear()
    const moved = evaluate({ text: TEXT, facts: { scheduleA: [range(0, 4)] } })
    expect(moved[0]?.end).toBe(4)
    expect(b.mock.calls.map(([, from]) => from)).toEqual([4])
    b.mockClear()
    expect(() => evaluate({ text: TEXT, facts: old })).toThrow(/schedule.b/)
    expect(b).not.toHaveBeenCalled()
  })

  it('rejects a matcher that moves behind the cursor or produces another rule ID', () => {
    const behind = vi.fn((_text: string, _from: number): UserTextNode<'schedule.a'> => ({
      id: 'schedule.a', start: 0, end: 1, data: { label: 'stuck' },
    }))
    const first = setup([{ id: 'schedule.a', order: 0, match: behind }])
    expect(() => first.evaluate({ text: TEXT, facts: {} })).toThrow(/schedule.a/)
    expect(behind.mock.calls.map(([, from]) => from)).toEqual([0, 1])
    const foreign = setup([{ id: 'schedule.a', order: 0, match: () => ({
      id: 'schedule.b', start: 0, end: 1, data: { label: 'foreign' },
    }) }])
    expect(() => foreign.evaluate({ text: TEXT, facts: {} })).toThrow(/schedule.a/)
  })

  it('closes matcher read contexts on success, throws and invalid asynchronous output', () => {
    let escaped: UserTextTransformContext | undefined
    const { evaluate } = setup([{ id: 'schedule.a', order: 0, match: (_text, _from, context) => {
      escaped = context
      if (context.read('scheduleEnabled')) throw new Error('failed')
      return undefined
    } }])
    evaluate({ text: TEXT, facts: {} })
    expect(() => escaped?.read('scheduleA')).toThrow(/closed/)
    expect(() => evaluate({ text: TEXT, facts: { scheduleEnabled: true } })).toThrow(/schedule.a/)
    expect(() => escaped?.read('scheduleA')).toThrow(/closed/)
    const asyncCase = setup([{ id: 'schedule.a', order: 0,
      // @ts-expect-error A matcher must return one synchronous candidate or undefined.
      match: (_text, _from, context) => { escaped = context; return Promise.resolve(undefined) },
    }])
    expect(() => asyncCase.evaluate({ text: TEXT, facts: {} })).toThrow(/schedule.a/)
    expect(() => escaped?.read('scheduleA')).toThrow(/closed/)
  })

  it('rejects matcher reentrancy without losing a later Facts-driven retry', () => {
    const { registry, evaluate } = setup()
    const match = vi.fn((_text: string, _from: number, context: UserTextTransformContext) => {
      if (context.read('scheduleEnabled')) evaluate({ text: 'nested', facts: {} })
      return undefined
    })
    registry.register({ id: 'schedule.a', order: 0, match })
    expect(() => evaluate({ text: TEXT, facts: { scheduleEnabled: true } })).toThrow(/schedule.a/)
    expect(evaluate({ text: TEXT, facts: { scheduleEnabled: false } })).toEqual([
      { id: 'text', start: 0, end: TEXT.length, data: { text: TEXT } },
    ])
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, 0])
  })

  it('keeps invalidated but unqueried matchers pending across an earlier failure', () => {
    const first = vi.fn((_text: string, _from: number, context: UserTextTransformContext) => {
      if (context.read('scheduleEnabled')) throw new Error('blocked')
      return undefined
    })
    const later = tracked('schedule.b', 'scheduleB', 1)
    const { evaluate } = setup([{ id: 'schedule.a', order: 0, match: first }, later.rule])
    evaluate({ text: TEXT, facts: { scheduleEnabled: false, scheduleB: [range(2, 4, 'old')] } })
    later.match.mockClear()
    const ranges = [range(2, 4, 'new')]
    expect(() => evaluate({ text: TEXT, facts: { scheduleEnabled: true, scheduleB: ranges } })).toThrow(/schedule.a/)
    expect(later.calls()).toEqual([])
    expect(() => evaluate({ text: TEXT, facts: { scheduleEnabled: true, scheduleB: ranges } })).toThrow(/schedule.a/)
    expect(evaluate({ text: TEXT, facts: { scheduleEnabled: false, scheduleB: ranges } })[1]?.data).toEqual({ label: 'new' })
    expect(later.calls()).toEqual([0, 4])
  })

  it('keeps evaluator query caches isolated and discards them on text changes', () => {
    const match = vi.fn((_text: string, _from: number) => undefined)
    const { registry, evaluate } = setup([{ id: 'schedule.a', order: 0, match }])
    const other = registry.createEvaluator()
    const first = evaluate({ text: 'abc', facts: {} })
    expect(other({ text: 'abc', facts: {} })).not.toBe(first)
    expect(match).toHaveBeenCalledTimes(2)
    expect(evaluate({ text: 'abc', facts: {} })).toBe(first)
    evaluate({ text: 'abcd', facts: {} })
    evaluate({ text: '', facts: {} })
    expect(match.mock.calls.map(([text, from]) => [text, from])).toEqual([['abc', 0], ['abc', 0], ['abcd', 0], ['', 0]])
  })

  it('reuses independent caches across registration, removal and priority changes', () => {
    const a = tracked('schedule.a', 'scheduleA', 0)
    const b = tracked('schedule.b', 'scheduleB', 1)
    const { registry, evaluate } = setup([a.rule])
    const input = { text: TEXT, facts: { scheduleA: [range(2, 4)], scheduleB: [range(2, 7)] } }
    evaluate(input)
    a.match.mockClear()
    let remove = registry.register(b.rule)
    expect(evaluate(input).filter(node => node.id !== 'text').map(node => node.id)).toEqual(['schedule.a'])
    expect(a.calls()).toEqual([])
    expect(b.calls()).toEqual([0, 4])
    remove()
    evaluate(input)
    remove = registry.register({ ...b.rule, order: -1 })
    a.match.mockClear(); b.match.mockClear()
    expect(evaluate(input).filter(node => node.id !== 'text').map(node => node.id)).toEqual(['schedule.b'])
    expect(a.calls()).toEqual([])
    expect(b.calls()).toEqual([0, 7])
    remove()
    expect(evaluate(input).filter(node => node.id !== 'text').map(node => node.id)).toEqual(['schedule.a'])
  })

  it('matches fresh evaluation throughout deterministic additions, removals and overlapping refreshes', () => {
    const k = kit()
    const variants = [[], [range(0, 10)], [range(2, 4), range(12, 15)], [range(5, 6), range(20, 25)]]
    for (const scheduleA of variants) for (const scheduleB of variants) for (const scheduleC of variants) {
      const facts = { scheduleA, scheduleB, scheduleC }
      const nodes = k.evaluate(facts)
      expect(nodes).toEqual(k.registry.createEvaluator()({ text: TEXT, facts }))
      coverage(nodes)
    }
  })
})
