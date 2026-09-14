import { describe, expect, it } from 'vitest'
import * as vm from 'node:vm'
import { materializeFromRealm, MaterializeError, renderThrown } from '../src/realm.ts'

/** Evaluate an expression inside a fresh vm realm and hand back the raw realm value. */
function inRealm(expression: string): unknown {
  return vm.runInNewContext(`(${expression})`)
}

/** The MaterializeError message for a value that must be rejected (throws if accepted). */
function rejection(value: unknown): string {
  try {
    materializeFromRealm(value)
  } catch (error: unknown) {
    if (error instanceof MaterializeError) return error.message
    throw error
  }
  throw new Error('expected the value to be rejected')
}

describe('materializeFromRealm', () => {
  it('copies realm objects/arrays/scalars into host plain data', () => {
    const value = inRealm("{ a: 1, b: 'x', c: true, d: null, list: [1, [2, { deep: 'y' }]] }")
    const out = materializeFromRealm(value) as Record<string, unknown>
    expect(out).toEqual({ a: 1, b: 'x', c: true, d: null, list: [1, [2, { deep: 'y' }]] })
    // The copy is HOST data: prototypes are the host intrinsics.
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Array.isArray(out.list)).toBe(true)
    // And it round-trips through JSON byte-identically (the whole point).
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it('accepts undefined ONLY at the root (a valueless script return)', () => {
    expect(materializeFromRealm(undefined)).toBeUndefined()
    expect(rejection(inRealm('{ a: undefined }'))).toContain('value.a')
  })

  it('invokes getters ordinarily — the getter RESULT is what crosses (trust premise)', () => {
    const counter = inRealm(`
      (() => {
        globalThis.reads = 0
        return { get x() { globalThis.reads += 1; return globalThis.reads } }
      })()
    `)
    expect(materializeFromRealm(counter)).toEqual({ x: 1 })
  })

  it('a getter that THROWS surfaces as a MaterializeError carrying the rendered failure', () => {
    const hostile = inRealm("{ get x() { throw new Error('read failed') } }")
    const message = rejection(hostile)
    expect(message).toContain('reading the value threw')
    expect(message).toContain('read failed')
  })

  it('a "__proto__" key becomes an OWN data property of the copy, never a prototype mutation', () => {
    const value: unknown = vm.runInNewContext('JSON.parse(\'{"__proto__": {"polluted": 1}, "ok": 2}\')')
    const out = materializeFromRealm(value) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(out.ok).toBe(2)
    // The host Object.prototype was NOT touched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects functions, symbols (keys and values), and bigints with path-qualified messages', () => {
    expect(rejection(inRealm('{ fn: () => 1 }'))).toContain('value.fn')
    expect(rejection(inRealm("{ [Symbol('k')]: 1 }"))).toContain('symbol-keyed')
    expect(rejection(inRealm("{ s: Symbol('v') }"))).toContain('value.s')
    expect(rejection(inRealm('{ big: 1n }'))).toContain('value.big')
    expect(rejection(inRealm("[Symbol('x')]"))).toContain('value[0]')
    const taggedArray = inRealm("(() => { const a = [1]; a[Symbol('t')] = 1; return a })()")
    expect(rejection(taggedArray)).toContain('symbol-keyed')
  })

  it('rejects non-finite numbers and undefined values inside containers', () => {
    expect(rejection(inRealm('{ n: NaN }'))).toContain('non-finite')
    expect(rejection(inRealm('[Infinity]'))).toContain('non-finite')
  })

  it('rejects exotic prototypes (Date, Map, class instances) but accepts null-prototype data', () => {
    expect(rejection(inRealm('{ d: new Date(0) }'))).toContain('exotic prototype')
    expect(rejection(inRealm('new Map()'))).toContain('exotic prototype')
    expect(rejection(inRealm('(() => { class C { constructor() { this.x = 1 } } return new C() })()')))
      .toContain('exotic prototype')
    expect(materializeFromRealm(inRealm('Object.assign(Object.create(null), { a: 1 })'))).toEqual({ a: 1 })
  })

  it('rejects cycles and accepts the same object reused as a sibling (a DAG)', () => {
    expect(rejection(inRealm('(() => { const o = {}; o.self = o; return o })()'))).toContain('circular')
    const dag = inRealm('(() => { const leaf = { v: 1 }; return { a: leaf, b: leaf } })()')
    expect(materializeFromRealm(dag)).toEqual({ a: { v: 1 }, b: { v: 1 } })
  })

  it('rejects sparse arrays and non-index array properties; an array getter element materializes its value', () => {
    expect(rejection(inRealm('[1, , 3]'))).toContain('sparse')
    expect(rejection(inRealm('(() => { const a = [1]; a.total = 3; return a })()')))
      .toContain('non-index')
    expect(materializeFromRealm(inRealm('(() => { const a = [1]; Object.defineProperty(a, 0, { get: () => 7, enumerable: true }); return a })()')))
      .toEqual([7])
  })

  it('skips non-enumerable own properties (matching JSON.stringify exactly)', () => {
    const value = inRealm(`(() => {
      const o = { visible: 1 }
      Object.defineProperty(o, 'hidden', { value: () => 1, enumerable: false })
      return o
    })()`)
    expect(materializeFromRealm(value)).toEqual({ visible: 1 })
  })

  it('works on plain host values too (the boundary is realm-agnostic)', () => {
    expect(materializeFromRealm({ a: [1, 'x'] })).toEqual({ a: [1, 'x'] })
    expect(materializeFromRealm('str')).toBe('str')
    expect(materializeFromRealm(3)).toBe(3)
    expect(materializeFromRealm(false)).toBe(false)
    expect(materializeFromRealm(null)).toBeNull()
  })
})

describe('renderThrown', () => {
  it('prefers the stack, for host and realm errors alike', () => {
    const host = renderThrown(new Error('host failure'))
    expect(host).toContain('host failure')
    expect(host).toContain('at ') // a real stack, not just the message
    const realmError: unknown = vm.runInNewContext('(() => { try { throw new Error("realm failure") } catch (e) { return e } })()')
    expect(renderThrown(realmError)).toContain('realm failure')
  })

  it('falls back from stack to message to String()', () => {
    expect(renderThrown({ stack: 'custom data stack' })).toBe('custom data stack')
    const stackless = new Error('stackless failure')
    delete stackless.stack
    expect(renderThrown(stackless)).toBe('stackless failure')
    expect(renderThrown({ code: 42 })).toBe('[object Object]')
    expect(renderThrown('plain')).toBe('plain')
    expect(renderThrown(42)).toBe('42')
    expect(renderThrown(undefined)).toBe('undefined')
    expect(renderThrown(null)).toBe('null')
  })

  it('is total: a value whose accessors/toString throw renders as a fixed label', () => {
    expect(renderThrown({ get stack() { throw new Error('nope') } })).toBe('[unrenderable thrown value]')
    expect(renderThrown({ [Symbol.toPrimitive]() { throw new Error('nope') } })).toBe('[unrenderable thrown value]')
  })
})
