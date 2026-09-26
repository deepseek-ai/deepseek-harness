/** Schemastery and Cordis config reference behavior through direct and Loader updates. */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Config } from './volatile-config.fixture.ts'
import { createVolatile, deepEqual, volatileEntries } from '@deepseek-ai/cosmokit'
import { redactSecrets } from '../packages/settings/settings/src/redact.ts'

describe('volatile schemas', () => {
  it('parses references with defaults and absent values while preserving schema metadata', () => {
    const parsed = Config({})
    expect(parsed.title.get()).toBe('hello')
    expect(parsed.optional.get()).toBeUndefined()
    expect(parsed.nested.count.get()).toBe(1)
    expectTypeOf(parsed.title).toEqualTypeOf<Volatile<string>>()
    expectTypeOf(parsed.optional).toEqualTypeOf<Volatile<string | undefined>>()
    expectTypeOf(parsed.nested.count).toEqualTypeOf<Volatile<number>>()
    expectTypeOf(z.string().volatile().description('Live text').default('text')().get()).toEqualTypeOf<string>()
    expectTypeOf(z.string().required().volatile()('text').get()).toEqualTypeOf<string>()
    expect(Config.dict?.title?.type).toBe('string')
    expect(Config.dict?.title?.meta.default).toBe('hello')
    expect(Config.simplify(parsed)).toBeNull()
    const reconstructed = new z<unknown>(JSON.parse(JSON.stringify(Config.toJSON())) as z<unknown>)
    expect((reconstructed({ title: 'changed' }) as ReturnType<typeof Config>).title.get()).toBe('changed')
    expect(reconstructed.simplify(reconstructed({ title: 'changed' }))).toEqual({ title: 'changed' })
    expect(z.string().volatile().required()('present').get()).toBe('present')
    expect(() => z.string().volatile().required()()).toThrow('missing required value')
    expect(() => Config({ nested: { count: -1 } })).toThrow()
    expect(Config({ nested: { count: -1 } }, { autofix: true }).nested.count.get()).toBe(1)
  })

  it('copies and freezes data snapshots without freezing the input', () => {
    const input = { group: { list: ['a'] } }
    const parsed = Config(input)
    input.group.list.push('b')
    expect(parsed.group.get()).toEqual({ list: ['a'] })
    expect(Object.isFrozen(parsed.group.get())).toBe(true)
    expect(Object.isFrozen(parsed.group.get().list)).toBe(true)
    expect(() => (parsed.group.get().list as string[]).push('c')).toThrow()
    expect(Object.keys(parsed.group)).toEqual(['get'])
    expect(() => z.any().volatile()(new Date())).toThrow('plain objects')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => z.any().volatile()(cyclic)).toThrow('cycles')
  })

  it.each([
    ['array', () => z.object({ items: z.array(z.string().volatile()) }), 'items'],
    ['dict', () => z.object({ items: z.dict(z.string().volatile()) }), 'items'],
    ['union', () => z.union([z.object({ title: z.string().volatile() }), z.string()]), 'title'],
    ['tuple', () => z.object({ items: z.tuple([z.string().volatile()]) }), 'items'],
    ['intersect', () => z.intersect([z.object({ title: z.string().volatile() })]), 'title'],
    ['transform', () => z.transform(z.object({ title: z.string().volatile() }), value => value), 'title'],
    ['nested', () => z.object({ block: z.object({ title: z.string().volatile() }).volatile() }), 'block'],
  ])('rejects %s placements even when input omits the field', (_name, schema, path) => {
    expect(() => schema()({})).toThrow(path)
  })

  it('rejects repeat wrapping and supports an entire array or union as a value', () => {
    expect(() => z.string().volatile().volatile()).toThrow('already wrapped')
    expect(z.array(z.string()).volatile()(['a']).get()).toEqual(['a'])
    expect(z.union([z.string(), z.number()]).volatile()(1).get()).toBe(1)
    const schema = z.string().volatile()
    expect(schema('first')).not.toBe(schema('first'))
  })

  it('retains ordinary fields and secret traversal in serialized schemas', () => {
    const schema = z.object({ block: z.object({ apiKey: z.string().role('secret'), title: z.string() }).volatile() })
    const restored = new z<unknown>(JSON.parse(JSON.stringify(schema.toJSON())) as z<unknown>)
    expect(restored.dict?.block?.type).toBe('object')
    expect(restored.dict?.block?.dict?.apiKey?.meta.role).toBe('secret')
    expect(redactSecrets(restored as z<never>, { block: { apiKey: 'secret', title: 'public' } }).value)
      .toEqual({ block: { title: 'public' } })
  })

  it('accepts metadata-free serialized nodes and checks their nested volatile declarations', () => {
    const schema = new z<{ enabled: boolean }>(JSON.parse('{"type":"object","dict":{"enabled":{"type":"boolean"}}}') as z<{ enabled: boolean }>)
    expect(schema({ enabled: true })).toEqual({ enabled: true })
    const dynamic = new z<unknown>(JSON.parse(
      '{"type":"object","dict":{"items":{"type":"array","inner":{"type":"string","meta":{"volatile":true}}}}}',
    ) as z<unknown>)
    expect(() => dynamic({ items: [] })).toThrow('items')
  })

  it('resolves recursive lazy schemas only for the supplied data', () => {
    interface Tree { name: string; children?: Tree[] }
    function tree(): z<Tree> {
      return z.object({ name: z.string(), children: z.array(z.lazy(tree)).default([]) })
    }
    expect(tree()({ name: 'root' })).toEqual({ name: 'root', children: [] })
    expect(tree()({ name: 'root', children: [{ name: 'leaf' }] }))
      .toEqual({ name: 'root', children: [{ name: 'leaf', children: [] }] })
    const schema = z.object({ lazy: z.lazy(() => z.object({ live: z.string().volatile() })) })
    expect(() => schema({ lazy: { live: 'value' } })).toThrow('lazy')
  })
})

describe('volatile comparison semantics', () => {
  it('ignores reference contents while retaining ordinary differences', () => {
    const first = Config({ title: 'a' })
    const second = Config({ title: 'b' })
    expect(deepEqual(first, second, true)).toBe(true)
    expect(deepEqual(first, Config({ fixed: 'changed' }), true)).toBe(false)
    expect(deepEqual(first.title, 'a', true)).toBe(false)
    expect(deepEqual('a', first.title, true)).toBe(false)
    expect(deepEqual([undefined], [null], true)).toBe(false)
    expect(deepEqual([undefined], [null])).toBe(true)
    expect(deepEqual(new Date(0), new Date(0), true)).toBe(true)
    expect(deepEqual(/a/g, /a/i, true)).toBe(false)
    expect(deepEqual(new URL('https://a.example'), new URL('https://b.example'), true)).toBe(false)
    expect(deepEqual(new URL('https://EXAMPLE.com:443/'), new URL('https://example.com'), true)).toBe(true)
    expect(deepEqual(new URL('https://example.com'), {}, true)).toBe(false)
    expect(deepEqual({}, new URL('https://example.com'), true)).toBe(false)
    expect(deepEqual(new Uint8Array([1]).buffer, new Uint8Array([2]).buffer, true)).toBe(false)
    const firstCycle: Record<string, unknown> = {}; firstCycle.self = firstCycle
    const secondCycle: Record<string, unknown> = {}; secondCycle.self = secondCycle
    expect(deepEqual(firstCycle, secondCycle, true)).toBe(false)
  })
})

it('enumerates references through shared config containers without descending into snapshots or cycles', () => {
  const ref = createVolatile({ nested: 'value' })
  const shared = Object.assign(Object.create(null), { live: ref }) as Record<string, unknown>
  const config: Record<string, unknown> = { list: [shared, shared], opaque: new URL('https://example.com'), plain: 'value' }
  config.self = config
  expect(volatileEntries(config)).toEqual([
    { path: ['list', '0', 'live'], ref },
    { path: ['list', '1', 'live'], ref },
  ])
  expect(volatileEntries(ref)).toEqual([{ path: [], ref }])
})

it('compares sparse array slots as undefined in both directions', () => {
  for (const strict of [true, false]) {
    expect(deepEqual(Array(1), [undefined], strict)).toBe(true)
    expect(deepEqual([undefined], Array(1), strict)).toBe(true)
    expect(deepEqual(Array(1), ['new'], strict)).toBe(false)
    expect(deepEqual(['new'], Array(1), strict)).toBe(false)
    expect(deepEqual(Array(1), [], strict)).toBe(false)
    expect(deepEqual([], Array(1), strict)).toBe(false)
  }
  expect(deepEqual(Array(1), [null], true)).toBe(false)
  expect(deepEqual([null], Array(1), true)).toBe(false)
})

it('reports unsupported volatile values as validation issues with their path', () => {
  const schema = z.object({ block: z.object({ when: z.date().volatile() }) })
  expect(() => schema({ block: { when: new Date(0) } })).toThrow(z.ValidationError)
  expect(() => schema({ block: { when: new Date(0) } })).toThrow('$.block.when')
  expect(schema({ block: {} }).block.when.get()).toBeUndefined()
})
