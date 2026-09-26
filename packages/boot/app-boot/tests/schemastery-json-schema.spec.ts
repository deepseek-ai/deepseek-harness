/** JSON Schema describes Config inputs, while native normalization remains explicit. */

import { describe, expect, it, vi } from 'vitest'
import { Ajv2020 } from 'ajv/dist/2020.js'
import Schema from '@deepseek-ai/schemastery'
import { createConfigProjector, type ConfigProjection } from '../src/config-schema/projector.ts'

const projector = await createConfigProjector()
const validator = new Ajv2020({ strict: false, validateFormats: false })
function project(schema: Schema): ConfigProjection {
  return projector(schema, 'test')
}
function accepts(result: ConfigProjection, input: unknown, engine: Ajv2020 = validator): boolean {
  const validate = engine.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      ...result.definitions,
      loaderExpression: { type: 'object', properties: { __jsExpr: { type: 'string' } }, required: ['__jsExpr'] },
    },
    allOf: [result.schema],
  })
  return validate(input)
}

describe('Schemastery input projection', () => {
  it.each([
    ['optional scalar', Schema.string(), true, true],
    ['required scalar', Schema.string().required(), false, false],
    ['required with default', Schema.string().required().default('fallback'), false, false],
    ['default scalar', Schema.number().default(3), true, true],
    ['invalid scalar fallback', Schema.number().default('invalid' as never), false, false],
    ['implicit object default', Schema.object({ token: Schema.string().required() }), false, false],
    ['nested implicit object', Schema.object({ auth: Schema.object({ token: Schema.string().required() }) }), false, false],
    ['required array item missing', Schema.array(String).min(1), false, false],
    ['union wrapper has no object default', Schema.union([Schema.object({ token: Schema.string().required() })]), true, true],
    ['removed array default', Schema.array(String).min(1).extra('default', undefined), true, true],
    ['nullable never', Schema.never(), true, true],
    ['required never', Schema.never().required(), false, false],
    ['required null const', Schema.const(null).required(), false, false],
    ['null const', Schema.const(null), true, true],
    ['undefined const', Schema.const(undefined), true, true],
    ['required undefined const', Schema.const(undefined).required(), false, false],
  ])('%s preserves omission and null acceptance', (_name, schema, missing, nullValue) => {
    const result = project(schema)
    expect(result.acceptsMissing).toBe(missing)
    expect(accepts(result, null)).toBe(nullValue)
    expect(result.limitations).toEqual([])
  })

  it('derives required parent fields from fallback validation, not only meta.required', () => {
    const result = project(Schema.object({ auth: Schema.object({ token: Schema.string().required() }) }))
    expect(accepts(result, {})).toBe(false)
    expect(accepts(result, { auth: {} })).toBe(false)
    expect(accepts(result, { auth: { token: 'secret' }, extra: true })).toBe(true)
  })

  it('preserves overlapping union acceptance instead of emitting oneOf', () => {
    const schema = Schema.union([
      Schema.object({ command: Schema.string().required(), transport: Schema.const('stdio') }),
      Schema.object({ url: Schema.string().required(), transport: Schema.const('http') }),
    ])
    const result = project(schema)
    expect(accepts(result, { command: 'server', url: 'https://example.com' })).toBe(true)
    expect(JSON.stringify(result.schema)).not.toContain('oneOf')
    expect(JSON.stringify(result.schema)).toContain('first-success')
  })

  it('keeps native container behavior for arrays, dictionaries, and tuples', () => {
    expect(accepts(project(Schema.array(String)), [null])).toBe(false)
    expect(accepts(project(Schema.array(Schema.string())), [null])).toBe(true)
    expect(accepts(project(Schema.array(Schema.object({})).min(2)), [])).toBe(true)
    expect(accepts(project(Schema.array(String).min(1).max(2)), ['a', 'b', 'c'])).toBe(false)
    const dict = project(Schema.dict(Schema.string(), Schema.union(['low', 'high'])))
    expect(accepts(dict, { low: null })).toBe(true)
    expect(accepts(dict, { invalid: 'value' })).toBe(false)
    const tuple = project(Schema.tuple([String, Schema.number()]))
    expect(accepts(tuple, [])).toBe(false)
    expect(accepts(tuple, ['a'])).toBe(true)
    expect(accepts(tuple, ['a', 1, 'extra'])).toBe(true)
  })

  it('emits ordinary number, string, and const constraints', () => {
    const integer = project(Schema.number().min(1).max(10).step(1))
    expect(accepts(integer, 1.5)).toBe(false)
    expect(accepts(integer, 11)).toBe(false)
    expect(accepts(integer, 2)).toBe(true)
    expect(accepts(project(Schema.number().step(2).min(0)), 3)).toBe(false)
    expect(accepts(project(Schema.number().step(0)), 1.5)).toBe(true)
    expect(accepts(project(Schema.string().min(1).pattern(/^https?:\/\/\S+$/u)), '')).toBe(false)
    expect(accepts(project(Schema.string().max(0)), 'x')).toBe(false)
    expect(accepts(project(Schema.const('fixed')), 'other')).toBe(false)
    expect(accepts(project(Schema.boolean()), 'true')).toBe(false)
    expect(accepts(project(Schema.any().required()), null)).toBe(false)
    expect(accepts(project(Schema.union([]).required()), 1)).toBe(false)
  })

  it.each([
    Schema.number().min(1).step(2),
    Schema.string().min(2),
    Schema.string().max(2),
    Schema.string().pattern(/^a$/i),
    Schema.intersect([Schema.object({ a: Schema.string() })]),
    Schema.function(),
    Schema.string().loose(),
  ])('marks unprojected behavior explicitly', (schema) => {
    expect(project(schema).limitations.length).toBeGreaterThan(0)
  })

  it('does not run transform callbacks and marks their validation partial', () => {
    const callback = vi.fn((): string => { throw new Error('must not run') })
    const result = project(Schema.transform(Schema.string().required(), callback).default('value'))
    expect(callback).not.toHaveBeenCalled()
    expect(result.acceptsMissing).toBe('unknown')
    expect(result.limitations.join(' ')).toContain('transform callback')
    expect(accepts(result, 3)).toBe(false)
    expect(JSON.stringify(result)).not.toContain('must not run')
  })

  it.each([/^.$/, /\uD83D/, /\a/])('does not emit unsafe flagless regex constraints: %s', (pattern) => {
    const result = project(Schema.string().pattern(pattern))
    expect(result.limitations.join(' ')).toContain('regular-expression')
    expect(accepts(result, '😀')).toBe(true)
  })

  it('keeps transform-strict dictionaries separate from ordinary dictionaries', () => {
    const dict = Schema.dict(Schema.string(), Schema.union(['allowed']))
    const callback = vi.fn((value: Record<string, string>) => value)
    const schema = Schema.object({
      plain: dict,
      transformed: Schema.transform(dict, callback),
      throughUnion: Schema.transform(Schema.union([dict]), callback),
    })
    const result = project(schema)
    expect(callback).not.toHaveBeenCalled()
    expect(accepts(result, { plain: { allowed: 'text' }, transformed: { other: 3 }, throughUnion: { other: 3 } })).toBe(true)
    expect(accepts(result, { plain: { other: 'text' } })).toBe(false)
    expect(result.limitations.join(' ')).toContain('strict dictionary filtering')
    expect(JSON.stringify(result)).toContain('dictionaryValidation')
  })

  it('permits expressions inside structured constants while rejecting non-null extra members', () => {
    const object = project(Schema.const({ value: 1, nullable: null }))
    expect(accepts(object, { value: { __jsExpr: '1' }, nullable: null })).toBe(true)
    expect(accepts(object, { value: 2, nullable: null })).toBe(false)
    expect(accepts(object, { value: 1, nullable: null, extra: 1 })).toBe(false)
    expect(accepts(object, { value: 1, extra: { __jsExpr: 'ctx.optional' } })).toBe(true)
    const array = project(Schema.const([1]))
    expect(accepts(array, [{ __jsExpr: '1' }])).toBe(true)
    expect(accepts(array, [1, { __jsExpr: '1' }])).toBe(false)
    expect(accepts(project(Schema.const([])), [])).toBe(true)
    expect(accepts(project(Schema.const({})), {})).toBe(true)
  })

  it.each([null, undefined])('matches native nullable constant object members: %s', (empty) => {
    const native = Schema.const({ x: empty })
    const result = project(native)
    for (const value of [{}, { x: null }, { x: null, extra: null }]) {
      expect(() => Schema.resolve(value, native, {})).not.toThrow()
      expect(accepts(result, value)).toBe(true)
    }
    for (const value of [{ x: 1 }, { extra: 1 }]) {
      expect(() => Schema.resolve(value, native, {})).toThrow()
      expect(accepts(result, value)).toBe(false)
    }
    expect(result.limitations.join(' ')).toContain('inherited-member comparison')
  })

  it('retains nested nullish constants and exact array length', () => {
    const native = Schema.const({ nested: { x: undefined }, values: [undefined] })
    const result = project(native)
    const value = { nested: {}, values: [null], extra: null }
    expect(() => Schema.resolve(value, native, {})).not.toThrow()
    expect(accepts(result, value)).toBe(true)
    expect(accepts(result, { nested: {}, values: [] })).toBe(false)
    expect(accepts(result, { nested: {}, values: [1] })).toBe(false)
    expect(accepts(project(Schema.const(Array(1))), [null])).toBe(true)
  })

  it('keeps inherited-key object constant behavior partial without rejecting valid defaults', () => {
    const value = JSON.parse('{"__proto__":{}}') as Record<string, unknown>
    const native = Schema.const({}).default(value)
    expect(() => Schema.resolve(undefined, native, {})).not.toThrow()
    const result = project(native)
    expect(accepts(result, value)).toBe(true)
    expect(result.acceptsMissing).toBe('unknown')
    expect(result.limitations.join(' ')).toContain('inherited-member comparison')
    const declaredPrototype = Schema.const(value)
    expect(() => Schema.resolve({}, declaredPrototype, {})).not.toThrow()
    expect(accepts(project(declaredPrototype), {}, new Ajv2020({ strict: false, ownProperties: true }))).toBe(true)
    expect(() => Schema.resolve({ toString: null }, Schema.const({}), {})).toThrow()
    expect(project(Schema.const({})).limitations.length).toBeGreaterThan(0)
    const named = project(Schema.const({ toString: null }))
    expect(accepts(named, {})).toBe(false)
    expect(accepts(named, { toString: null })).toBe(true)
  })

  it('marks inherited intersect fallback acceptance unknown instead of optional', () => {
    const native = Schema.intersect([Schema.object({ x: Schema.string().required() })])
    expect(() => native(undefined)).toThrow()
    expect(() => native(null)).toThrow()
    expect(project(native).acceptsMissing).toBe('unknown')
    expect(project(Schema.intersect([native])).acceptsMissing).toBe('unknown')
    expect(project(native.required()).acceptsMissing).toBe(false)
    const enclosing = project(Schema.object({ nested: native }))
    expect(enclosing.acceptsMissing).toBe('unknown')
    expect(enclosing.limitations.join(' ')).toContain('intersect')
  })

  it('widens ordered unions when failed branches can adapt the input', () => {
    const callback = vi.fn(() => 1)
    const native = Schema.union([
      Schema.object({ x: Schema.transform(Schema.string(), callback), stop: Schema.never().required() }),
      Schema.object({ x: Schema.number().required() }),
    ]).required()
    const result = project(native)
    expect(callback).not.toHaveBeenCalled()
    expect(accepts(result, { x: 'text' })).toBe(true)
    expect(accepts(result, null)).toBe(false)
    const input = { x: 'text' }
    expect(() => Schema.resolve(input, native, {})).not.toThrow()
    expect(input.x).toBe(1)
    expect(result.limitations.join(' ')).toContain('earlier union branches')
  })

  it('does not mistake ordinary defaults for input writeback', () => {
    const native = Schema.union([
      Schema.object({ x: Schema.number().default(1), stop: Schema.never().required() }),
      Schema.object({ x: Schema.number().required() }),
    ]).required()
    const input = { x: null }
    expect(accepts(project(native), input)).toBe(false)
    expect(() => Schema.resolve(input, native, {})).toThrow()
    expect(input).toEqual({ x: null })
  })

  it.each(['transform', 'loose'])('allows original dictionary values affected by %s key collisions', (kind) => {
    const callback = vi.fn(() => 'b')
    const key = kind === 'transform' ? Schema.transform(Schema.string(), callback)
      : Schema.string().pattern(/^b$/).loose().default('b')
    const native = Schema.dict(Schema.number().required(), key)
    const result = project(native)
    expect(callback).not.toHaveBeenCalled()
    expect(accepts(result, { a: 1, b: 'bad' })).toBe(true)
    expect(() => Schema.resolve({ a: 1, b: 'bad' }, native, {})).not.toThrow()
    expect(result.limitations.join(' ')).toContain('key normalization')
  })

  it('keeps strict dictionary value assertions when every string key is accepted unchanged', () => {
    const callback = vi.fn((value: unknown) => value)
    const result = project(Schema.transform(Schema.dict(Schema.number().required()), callback).required())
    expect(callback).not.toHaveBeenCalled()
    expect(accepts(result, { a: 1 })).toBe(true)
    expect(accepts(result, { a: 'bad' })).toBe(false)
    expect(JSON.stringify(result)).not.toContain('dictionaryValidation')
  })

  it('preserves cached and fresh lazy loose fallback, including missing input', () => {
    const cached = Schema.lazy(() => Schema.string().required())
    Schema.resolve('warm', cached, {})
    for (const native of [cached.required().loose(), Schema.lazy(() => Schema.string().required()).required().loose()]) {
      const result = project(native)
      expect(accepts(result, 3)).toBe(true)
      expect(accepts(result, null)).toBe(true)
      expect(result.acceptsMissing).not.toBe(false)
      expect(() => Schema.resolve(null, native, {})).not.toThrow()
      expect(result.limitations.join(' ')).toContain('lazy loose fallback')
    }
    expect(accepts(project(Schema.lazy((): Schema => { throw new Error('builder failed') }).loose()), 3)).toBe(true)
  })

  it('does not turn a failed shared traversal into a dangling recursive reference', () => {
    const builder = vi.fn((): Schema => { throw new Error('bad builder') })
    const shared = Schema.object({ bad: Schema.lazy(builder) })
    expect(accepts(project(Schema.lazy(() => shared).loose()), {})).toBe(true)
    expect(builder).not.toHaveBeenCalled()
    const native = Schema.object({ first: Schema.lazy(() => shared).loose(), second: shared })
    expect(() => project(native)).toThrow('bad builder')
  })

  it('does not simulate shared lazy metadata changes or reject values they may enable', () => {
    const shared = Schema.number()
    const native = Schema.object({ first: Schema.lazy(() => shared).loose(), second: shared })
    const result = project(native)
    expect(shared.meta.loose).toBeUndefined()
    expect(accepts(result, { first: 1, second: 'bad' })).toBe(true)
    expect(() => Schema.resolve({ first: 1, second: 'bad' }, native, {})).not.toThrow()
    expect(result.limitations.join(' ')).toContain('metadata propagation')
    const item = Schema.string()
    const container = Schema.object({ first: Schema.lazy(() => item).default('x'), later: Schema.array(item).min(2) })
    const projected = project(container)
    expect(item.meta.default).toBeUndefined()
    expect(accepts(projected, { first: 'hello', later: [] })).toBe(true)
    expect(() => Schema.resolve({ first: 'hello', later: [] }, container, {})).not.toThrow()
    const booleanItem = Schema.boolean()
    const booleans = Schema.object({ first: Schema.lazy(() => booleanItem).default(false), later: Schema.array(booleanItem).min(2) })
    expect(accepts(project(booleans), { first: true, later: [] })).toBe(true)
    expect(booleanItem.meta.default).toBeUndefined()
  })

  it('keeps UTF-16 maximum length as a sound code-point upper bound', () => {
    const native = Schema.string().max(4)
    const result = project(native)
    expect(accepts(result, 'abcde')).toBe(false)
    expect(accepts(result, '😀😀😀')).toBe(true)
    expect(() => native('😀😀😀')).toThrow()
    expect(result.limitations.join(' ')).toContain('UTF-16 maximum')
    expect(accepts(project(Schema.string().max(-1).pattern(/x/)), '')).toBe(false)
  })

  it('keeps descendant limitations at their owning field', () => {
    const result = project(Schema.object({ nested: Schema.object({ value: Schema.string().pattern(/x/i) }) }))
    expect(result.limitations).toHaveLength(1)
    expect((result.schema as { 'x-cordis'?: object })['x-cordis']).not.toHaveProperty('limitations')
    expect(JSON.stringify(result.schema).match(/regular-expression syntax/g)).toHaveLength(1)
  })

  it('preserves roles, units, presentation metadata, and localized descriptions', () => {
    const schema = Schema.string().role('credential-ref', { source: 'environment' }).hidden().collapse().disabled()
      .link('https://example.com').comment('Credential name').experimental()
    schema.meta.description = { en: 'Credential reference', zh: '凭据引用' }
    const result = project(schema)
    expect(JSON.stringify(result.schema)).toContain('credential-ref')
    expect(JSON.stringify(result.schema)).toContain('Credential reference')
    expect(JSON.stringify(result.schema)).toContain('凭据引用')
    expect(JSON.stringify(project(Schema.natural().role('ms').default(100)).schema)).toContain('ms')
    expect(JSON.stringify(project(Schema.string().role('secret')).schema)).toContain('secret')
  })

  it('accepts expressions at every config value but not dictionary keys', () => {
    const result = project(Schema.object({ values: Schema.array(Schema.number().required()).required() }).required())
    expect(accepts(result, { __jsExpr: 'throw new Error("not evaluated")' })).toBe(true)
    expect(accepts(result, { values: { __jsExpr: 'ctx.values' } })).toBe(true)
    expect(accepts(result, { values: [{ __jsExpr: 'ctx.value' }] })).toBe(true)
    expect(accepts(result, { values: ['wrong'] })).toBe(false)
  })

  it('exports finite recursive references without mutating native lazy schemas', () => {
    const recursive: Schema = Schema.lazy(() => Schema.object({ children: Schema.array(recursive) }))
    const inner = recursive.inner
    const result = project(recursive)
    expect(recursive.inner).toBe(inner)
    expect(Object.keys(result.definitions)).toEqual(['testRecursive0'])
    expect(accepts(result, { children: [{ children: [] }] })).toBe(true)
    expect(result.limitations.join(' ')).toContain('recursive default')
    expect(result.definitions.testRecursive0).not.toHaveProperty('anyOf')
    expect(accepts(result, { __jsExpr: 'ctx.root' })).toBe(true)
    expect(accepts(result, { children: [{ __jsExpr: 'ctx.child' }] })).toBe(true)
    expect(accepts(result, { children: [3] })).toBe(false)
    expect(JSON.stringify(result)).not.toContain('"uid"')
  })

  it('rejects lazy cycles without a concrete schema and reports builder failures', () => {
    const cycle: Schema = Schema.lazy(() => cycle)
    expect(() => project(cycle)).toThrow('lazy cycle has no concrete schema')
    expect(() => project(Schema.lazy(() => { throw new Error('builder failed') }))).toThrow('builder failed')
  })

  it('reuses recursive targets reached more than once and keeps required null rejection', () => {
    const recursive = Schema.object({}).required()
    recursive.set('left', recursive)
    recursive.set('right', recursive)
    const result = project(recursive)
    expect(Object.keys(result.definitions)).toEqual(['testRecursive0'])
    expect(result.acceptsMissing).toBe(false)
    expect(accepts(result, null)).toBe(false)
  })

  it('preserves effective cached lazy metadata instead of applying later outer requiredness', () => {
    const lazy = Schema.lazy(() => Schema.string())
    Schema.resolve('value', lazy, {})
    const declared = Schema.object({ field: lazy.required() })
    expect(() => Schema.resolve({}, declared, {})).not.toThrow()
    const result = project(declared)
    expect(accepts(result, {})).toBe(true)
    expect(result.acceptsMissing).toBe(true)
    expect(project(Schema.lazy(() => Schema.string()).required()).acceptsMissing).toBe('unknown')
  })

  it('retains volatile metadata without changing JSON input types', () => {
    const result = project(Schema.object({ value: Schema.string().volatile() }))
    expect(JSON.stringify(result.schema)).toContain('"volatile":true')
    expect(accepts(result, { value: 'updated' })).toBe(true)
    expect(accepts(result, { value: 3 })).toBe(false)
    const lazy = project(Schema.lazy(() => Schema.string()).volatile())
    expect(JSON.stringify(lazy.schema)).toContain('"volatile":true')
    expect(accepts(lazy, 'value')).toBe(true)
  })

  it.each([
    Schema.array(Schema.string().volatile()),
    Schema.dict(Schema.string().volatile()),
    Schema.union([Schema.string().volatile()]),
    Schema.tuple([Schema.string().volatile()]),
    Schema.object({ nested: Schema.string().volatile() }).volatile(),
    Schema.lazy(() => Schema.string().volatile()),
  ])('rejects volatile fields without a fixed, nonvolatile parent path', (schema) => {
    expect(() => Schema.resolve(undefined, schema, {})).toThrow('volatile fields require a fixed object path')
    expect(() => project(schema)).toThrow('volatile fields require a fixed object path')
  })

  it('uses an already resolved lazy inner schema without invoking its builder again', () => {
    const builder = vi.fn(() => Schema.string())
    const lazy = Schema.lazy(builder)
    lazy.inner = Schema.string().required()
    expect(project(lazy).acceptsMissing).toBe(false)
    expect(builder).not.toHaveBeenCalled()
  })

  it.each(['lazy', 'array', 'tuple', 'union'])('reports an incomplete native %s declaration', (type) => {
    expect(() => project(new Schema({ type }))).toThrow('schema')
  })

  it('supports empty and optional tuples and unrestricted object declarations', () => {
    expect(accepts(project(Schema.tuple([])), ['extra'])).toBe(true)
    expect(accepts(project(Schema.tuple([Schema.string()])), [])).toBe(true)
    expect(accepts(project(new Schema({ type: 'object' })), { extra: true })).toBe(true)
    expect(accepts(project(new Schema({ type: 'dict', inner: Schema.string() })), { anyKey: 'value' })).toBe(true)
    expect(accepts(project(Schema.array(String).max(-1)), [])).toBe(false)
    expect(accepts(project(Schema.number().step(-2).min(0)), 4)).toBe(true)
    expect(project(Schema.number().step(0.1)).limitations.length).toBeGreaterThan(0)
  })

  it.each([{ '': 'Default language' }, { zh: '中文' }, {}])('preserves descriptions without an English entry: %j', (description) => {
    const schema = Schema.string()
    schema.meta.description = description
    const result = project(schema)
    expect(JSON.stringify(result)).toContain('descriptions')
  })

  it.each([
    ['min', Infinity], ['max', -Infinity], ['step', Infinity], ['step', NaN],
  ] as const)('omits non-finite %s %d without losing type constraints', (key, value) => {
    const schema = Schema.number()
    schema.meta[key] = value
    const result = project(schema)
    expect(result.limitations.join(' ')).toContain(`non-finite ${key}`)
    expect(accepts(result, 3)).toBe(true)
    expect(accepts(result, 'wrong')).toBe(false)
    expect(schema.meta[key]).toBe(value)
  })

  it('treats native no-op infinite bounds as absent unless a step origin depends on them', () => {
    const inert: Schema[] = [
      Schema.number().max(Infinity), Schema.number().min(-Infinity), Schema.string().max(Infinity), Schema.array(Number).max(Infinity),
    ]
    for (const schema of inert) {
      const result = project(schema)
      expect(result.limitations).toEqual([])
      expect(JSON.stringify(result.schema)).not.toContain('maximum')
      expect(JSON.stringify(result.schema)).not.toContain('minimum')
    }
    const stepped = Schema.number().min(-Infinity).step(2)
    expect(() => Schema.resolve(4, stepped, {})).toThrow()
    expect(project(stepped).limitations.join(' ')).toContain('non-finite min')
  })

  it('keeps anyOf when an earlier primitive transform branch cannot write back into the input', () => {
    const callback = vi.fn((value: string) => [value])
    const native = Schema.union([Schema.transform(Schema.string(), callback), Schema.array(String)]).required()
    const result = project(native)
    expect(callback).not.toHaveBeenCalled()
    expect(result.limitations.join(' ')).not.toContain('earlier union branches')
    expect(accepts(result, 'text')).toBe(true)
    expect(accepts(result, ['text'])).toBe(true)
    expect(accepts(result, 3)).toBe(false)
    const container = Schema.transform(Schema.object({ x: Schema.transform(Schema.string(), callback) }), value => value)
    expect(project(Schema.union([container, Schema.object({})])).limitations.join(' ')).toContain('earlier union branches')
  })

  it('does not duplicate null in the type list of a wrapped null-only projection', () => {
    const native = Schema.object({ never: Schema.transform(Schema.never(), value => value) })
    const result = project(native)
    expect(accepts(result, {})).toBe(true)
    expect(accepts(result, { never: null })).toBe(true)
    expect(accepts(result, { never: 1 })).toBe(false)
    expect(() => Schema.resolve({}, native, {})).not.toThrow()
    const nullable = project(Schema.transform(Schema.string(), value => value))
    expect(nullable.schema).toMatchObject({ anyOf: [{ type: ['string', 'null'] }, { $ref: '#/$defs/loaderExpression' }] })
    expect(accepts(project(Schema.transform(Schema.string(), value => value).required()), null)).toBe(false)
    expect(accepts(project(Schema.transform(Schema.never(), value => value).required()), null)).toBe(false)
  })

  it('invokes a shared lazy builder once across chains within one document', () => {
    const builder = vi.fn<() => Schema>(() => Schema.number().required()).mockImplementationOnce(() => Schema.string().required())
    const shared = Schema.lazy(builder)
    const native = Schema.object({ a: Schema.lazy(() => shared), b: shared })
    const result = project(native)
    expect(builder).toHaveBeenCalledTimes(1)
    expect(accepts(result, { a: 'x', b: 'y' })).toBe(true)
    expect(accepts(result, { a: 'x', b: 1 })).toBe(false)
  })

  it('omits cyclic default annotations while retaining the schema', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const result = project(Schema.string().extra('default', cycle))
    expect(result.schema).not.toHaveProperty('default')
    expect(result.acceptsMissing).toBe('unknown')
    expect(result.limitations.join(' ')).toContain('cycle')
    expect(accepts(result, 'value')).toBe(true)
    expect(accepts(result, 1)).toBe(false)
  })

  it('has deterministic output independent of native allocation ids', () => {
    const first = project(Schema.object({ 'a/b~c': Schema.string().default('value') }))
    for (let index = 0; index < 10; index++) Schema.string()
    expect(project(Schema.object({ 'a/b~c': Schema.string().default('value') }))).toEqual(first)
  })

  it.each([Infinity, () => {}, Symbol('value'), new Date(), { value: undefined }])('omits non-JSON defaults with an explicit partial annotation', (value) => {
    const result = project(Schema.string().extra('default', value))
    expect(result.schema).not.toHaveProperty('default')
    expect(result.acceptsMissing).toBe('unknown')
    expect(result.limitations.join(' ')).toContain('default: annotation omitted')
    expect(accepts(result, 'value')).toBe(true)
    expect(accepts(result, 3)).toBe(false)
    expect(project(Schema.string().required().extra('default', value)).acceptsMissing).toBe(false)
  })

  it('keeps valid defaults and input precision when presentation metadata is omitted', () => {
    const render = vi.fn(() => { throw new Error('DO_NOT_CALL_RENDER') })
    const field = Schema.string().default('value').description('Field label').role('custom', { render })
    const result = project(Schema.object({ field }))
    expect(render).not.toHaveBeenCalled()
    expect(result.acceptsMissing).toBe(true)
    expect(accepts(result, {})).toBe(true)
    expect(accepts(result, { field: 3 })).toBe(false)
    expect(JSON.stringify(result.schema)).toContain('Field label')
    expect(JSON.stringify(result.schema)).toContain('custom')
    expect(JSON.stringify(result.schema)).not.toContain('DO_NOT_CALL_RENDER')
    expect(result.limitations.join(' ')).toContain('extra: annotation omitted')
  })

  it.each(['default', 'constant'])('reports non-Error %s annotation failures without losing the document', (kind) => {
    const value = { get field() { throw 'annotation getter failed' } }
    const schema = kind === 'default' ? Schema.string().extra('default', value) : Schema.const(value)
    const result = project(schema)
    expect(result.limitations.join(' ')).toContain('annotation getter failed')
  })

  it('omits unrepresentable localized descriptions without executing their callbacks', () => {
    const callback = vi.fn()
    const schema = Schema.string()
    Object.defineProperty(schema.meta, 'description', { value: { en: callback }, enumerable: true })
    const result = project(schema)
    expect(result.schema).not.toHaveProperty('description')
    expect(result.limitations.join(' ')).toContain('description: annotation omitted')
    expect(accepts(result, 'value')).toBe(true)
    expect(accepts(result, 3)).toBe(false)
    expect(callback).not.toHaveBeenCalled()
  })

  it('retains sibling constraints when a nested default or constant is not JSON-compatible', () => {
    const result = project(Schema.object({
      value: Schema.string().extra('default', () => 'dynamic'),
      constant: Schema.const(new Date()),
      count: Schema.number().required(),
    }))
    expect(accepts(result, { value: 'literal', count: 1 })).toBe(true)
    expect(accepts(result, { value: 3, count: 1 })).toBe(false)
    expect(accepts(result, { count: 'wrong' })).toBe(false)
    expect(result.limitations.length).toBeGreaterThan(0)
  })
})
