/** Raw config comparison reads schema metadata without resolving config or committing references. */
import { expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { equalExceptVolatile as equal } from '../vendor/loader/src/config/diff.ts'

it('ignores volatile fields in frozen raw inputs without running schema callbacks', () => {
  const validate = vi.fn((value: string) => value.trim())
  const schema = z.object({ title: z.transform(z.string(), validate).volatile(), fixed: z.string() })
  Object.freeze(schema.meta)
  Object.freeze(schema.dict)
  const previous = Object.freeze({ title: 'old', fixed: 'same' })
  const next = Object.freeze({ title: { __jsExpr: 'throw new Error("must not run")' }, fixed: 'same' })
  expect(equal(previous, next, schema)).toBe(true)
  expect(equal(previous, next, schema)).toBe(true)
  expect(validate).not.toHaveBeenCalled()
  expect(previous.title).toBe('old')
  expect(next.title).toEqual({ __jsExpr: 'throw new Error("must not run")' })
})

it('ignores absent, nested and whole-object/array/union volatile fields', () => {
  const schema = z.object({
    nested: z.object({ value: z.string().volatile() }),
    block: z.object({ title: z.string() }).volatile(),
    list: z.array(z.string()).volatile(),
    choice: z.union([z.string(), z.number()]).volatile(),
  })
  const next = { nested: { value: 'new' }, block: { title: 'new' }, list: ['new'], choice: 1 }
  expect(equal({}, next, schema)).toBe(true)
  expect(equal(next, {}, schema)).toBe(true)
  expect(equal('old', 'new', z.string().volatile())).toBe(true)
  const restored = new z<unknown>(JSON.parse(JSON.stringify(schema)) as z<unknown>)
  expect(equal({}, next, restored)).toBe(true)
})

it('preserves ordinary and unknown fields, object defaults and parent expressions', () => {
  const schema = z.object({ nested: z.object({ live: z.string().volatile(), fixed: z.string() }).default({ fixed: 'default' }) })
  expect(equal({}, { nested: { live: 'new', fixed: 'default' } }, schema)).toBe(true)
  expect(equal({}, { nested: { live: 'new' } }, schema)).toBe(false)
  expect(equal({}, { unknown: 'new' }, schema)).toBe(false)
  expect(equal({ nested: { __jsExpr: 'source.a' } }, { nested: { __jsExpr: 'source.b' } }, schema)).toBe(false)
  expect(equal({ nested: 'invalid' }, { nested: { live: 'new' } }, schema)).toBe(false)
  expect(equal({ nested: new Date(0) }, { nested: new Date(1) }, schema)).toBe(false)
  expect(equal({ nested: [] }, { nested: ['new'] }, schema)).toBe(false)
})

it('keeps ordinary raw changes even if schema validation would normalize them to equal values', () => {
  const normalize = vi.fn(() => 'same')
  const schema = z.object({ fixed: z.transform(z.string(), normalize), live: z.string().volatile() })
  expect(equal({ fixed: 'first' }, { fixed: 'second' }, schema)).toBe(false)
  expect(normalize).not.toHaveBeenCalled()
  const other = { '~standard': { version: 1 as const, vendor: 'other', validate: vi.fn() } }
  expect(equal('first', 'second', other)).toBe(false)
  expect(other['~standard'].validate).not.toHaveBeenCalled()
  expect(equal('first', 'second', undefined)).toBe(false)
})

it('compares raw values strictly without a schema', () => {
  expect(equal([undefined], [null], undefined)).toBe(false)
  expect(equal(undefined, null, undefined)).toBe(false)
  expect(equal({ fixed: 'same' }, { fixed: 'same' }, undefined)).toBe(true)
  expect(equal({ list: Array(1) }, { list: ['new'] }, undefined)).toBe(false)
})

it('compares recursive schemas conservatively and visits shared schema nodes at each path', () => {
  const recursive = z.object({ value: z.string() }).extra('default', undefined)
  recursive.set('child', recursive)
  expect(equal({ value: 'old' }, { value: 'new' }, recursive)).toBe(false)
  const shared = z.object({ value: z.string().volatile() })
  const schema = z.object({ first: shared, second: shared })
  expect(equal({}, { first: { value: 'one' }, second: { value: 'two' } }, schema)).toBe(true)
})

it('equates absent objects with defaults while preserving ordinary field differences', () => {
  const schema = z.object({ nested: z.object({ fixed: z.string() }).default({ fixed: 'default' }) })
  for (const absent of [undefined, null]) {
    expect(equal(absent, {}, schema)).toBe(true)
    expect(equal({}, absent, schema)).toBe(true)
    expect(equal({ nested: absent }, { nested: { fixed: 'default' } }, schema)).toBe(true)
  }
  expect(equal({}, { nested: { fixed: 'changed' } }, schema)).toBe(false)
  expect(equal({}, { nested: {} }, schema)).toBe(false)
})

it('preserves parent expression edits even when their marker matches a volatile field', () => {
  const schema = z.object({ __jsExpr: z.string().volatile() })
  expect(equal({ __jsExpr: 'first' }, { __jsExpr: 'second' }, schema)).toBe(false)
})

it('detects ordinary sparse array edits in both directions', () => {
  const schema = z.object({ list: z.array(z.string()), live: z.string().volatile() })
  const before = { list: Array(1), live: 'before' }
  const after = { list: ['new'], live: 'after' }
  expect(equal(before, after, schema)).toBe(false)
  expect(equal(after, before, schema)).toBe(false)
})

it('compares unknown fields whose names match Object prototype properties', () => {
  const schema = z.object({ live: z.string().volatile() })
  for (const key of ['constructor', 'toString', '__proto__']) {
    const previous = { [key]: 'first', live: 'old' }
    expect(equal(previous, { [key]: 'second', live: 'new' }, schema)).toBe(false)
    expect(equal(previous, { [key]: 'first', live: 'new' }, schema)).toBe(true)
  }
})

it('compares metadata-free serialized schema nodes', () => {
  const schema = new z<unknown>(JSON.parse('{"type":"object","dict":{"nested":{"type":"object","dict":{"enabled":{"type":"boolean"}}}}}') as z<unknown>)
  expect(equal({ nested: { enabled: true } }, { nested: { enabled: false } }, schema)).toBe(false)
})
