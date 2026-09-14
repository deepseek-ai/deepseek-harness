import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { decodePtcJsonWire, encodePtcJsonWire, snapshotPtcJsonValue } from '../src/json-wire.ts'

describe('snapshotPtcJsonValue', () => {
  it('matches the canonical scalar boundary', () => {
    const unsupported = [undefined, 1n, Symbol('value'), () => 1]
    for (const value of [null, false, 'text', 1.25, -0, Number.NaN, Number.POSITIVE_INFINITY, ...unsupported]) {
      expect(snapshotPtcJsonValue(value)).toEqual(snapshotJsonValue(value))
    }
  })

  it('detaches dense arrays and plain or null-prototype records', () => {
    const shared = { value: 1 }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { shared })
    const source = { list: [nullPrototype, shared], alias: shared }

    const snapshot = snapshotPtcJsonValue(source) as Record<string, unknown>
    shared.value = 2

    expect(snapshot).toEqual({ list: [{ shared: { value: 1 } }, { value: 1 }], alias: { value: 1 } })
    expect(snapshot).not.toBe(source)
    expect((snapshot.list as unknown[])[0]).not.toBe(nullPrototype)
    expect(snapshot.alias).not.toBe(shared)
  })

  it('accepts intrinsic plain containers from another JavaScript realm', () => {
    const foreign = runInNewContext('({ object: { nested: [1] }, array: [2, { ok: true }] })') as {
      object: unknown
      array: unknown
    }

    expect(snapshotPtcJsonValue(foreign.object)).toEqual({ nested: [1] })
    expect(snapshotPtcJsonValue(foreign.array)).toEqual([2, { ok: true }])
  })

  it('reads each accepted slot once and preserves a literal __proto__ key', () => {
    let objectReads = 0
    let arrayReads = 0
    const source = Object.create(null) as Record<string, unknown>
    Object.defineProperty(source, '__proto__', {
      enumerable: true,
      get: () => {
        objectReads += 1
        return { safe: true }
      },
    })
    const array = new Array<unknown>(1)
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        arrayReads += 1
        return arrayReads === 1 ? source : undefined
      },
    })

    const snapshot = snapshotPtcJsonValue(array) as Record<string, unknown>[]

    expect(objectReads).toBe(1)
    expect(arrayReads).toBe(1)
    expect(Object.getPrototypeOf(snapshot[0])).toBe(Object.prototype)
    expect(Object.hasOwn(snapshot[0]!, '__proto__')).toBe(true)
    expect(snapshot[0]?.['__proto__']).toEqual({ safe: true })
  })

  it('accepts deeply nested valid JSON without using the JavaScript call stack', () => {
    let value: unknown = 'leaf'
    for (let depth = 0; depth < 5_000; depth++) value = [value]

    let cursor = snapshotPtcJsonValue(value)
    for (let depth = 0; depth < 5_000; depth++) {
      expect(Array.isArray(cursor)).toBe(true)
      cursor = Array.isArray(cursor) ? cursor[0] : undefined
    }
    expect(cursor).toBe('leaf')
  })

  it('rejects exotic containers, sparse arrays, cycles, and invalid children', () => {
    class ExoticObject {
      readonly value = 1
    }
    class ExoticArray extends Array<number> {}
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const decorated = [1]
    Object.defineProperty(decorated, 'extra', { value: true })
    const compensatedSparse = new Array(1)
    Object.defineProperty(compensatedSparse, 'extra', { value: true })
    const symbolDecorated = [1]
    Object.defineProperty(symbolDecorated, Symbol('extra'), { value: true })
    const hiddenObject = Object.defineProperty({}, 'hidden', { value: true })
    const symbolObject = { [Symbol('extra')]: true }
    const customPrototype = Object.create(null) as Record<string, unknown>
    const customPrototypeObject = Object.assign(Object.create(customPrototype) as Record<string, unknown>, { value: 1 })
    const forgedPrototype: unknown[] = []
    Object.setPrototypeOf(forgedPrototype, null)
    const forgedArray = [1]
    Object.setPrototypeOf(forgedArray, forgedPrototype)
    const spoofedObjectPrototype = Object.create(null) as Record<string, unknown>
    const SpoofedObject = function Object() {}
    SpoofedObject.prototype = spoofedObjectPrototype
    Object.defineProperty(spoofedObjectPrototype, 'constructor', { value: SpoofedObject })
    const spoofedObject = Object.create(spoofedObjectPrototype) as Record<string, unknown>
    spoofedObject.value = 1
    const revokedPrototype = Object.create(null) as Record<string, unknown>
    const RevokedObject = function Object() {}
    RevokedObject.prototype = revokedPrototype
    const revokedConstructor = Proxy.revocable(RevokedObject, {})
    Object.defineProperty(revokedPrototype, 'constructor', { value: revokedConstructor.proxy })
    const revokedObject = Object.create(revokedPrototype) as Record<string, unknown>
    revokedConstructor.revoke()
    const spoofedArrayPrototype: unknown[] = []
    Object.setPrototypeOf(spoofedArrayPrototype, Object.prototype)
    const SpoofedArray = function Array() {}
    SpoofedArray.prototype = spoofedArrayPrototype
    Object.defineProperty(spoofedArrayPrototype, 'constructor', { value: SpoofedArray })
    const spoofedArray = [1]
    Object.setPrototypeOf(spoofedArray, spoofedArrayPrototype)

    for (const value of [
      new ExoticObject(),
      new Map([['value', 1]]),
      new ExoticArray(1),
      new Array(1),
      decorated,
      compensatedSparse,
      symbolDecorated,
      hiddenObject,
      symbolObject,
      customPrototypeObject,
      forgedArray,
      spoofedObject,
      revokedObject,
      spoofedArray,
      cyclic,
      [undefined],
      { value: undefined },
    ]) {
      const canonical = snapshotJsonValue(value)
      expect(canonical).toBeUndefined()
      expect(snapshotPtcJsonValue(value)).toEqual(canonical)
    }
  })

  it('rejects an array whose getter mutates the validated length', () => {
    const array = [0, 2]
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        array.length = 1
        return 1
      },
    })

    expect(snapshotPtcJsonValue(array)).toBeUndefined()
  })

  it('propagates a throwing getter and releases its recursion guard', () => {
    const failure = new Error('getter failed')
    const source = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => { throw failure },
    })

    expect(() => snapshotPtcJsonValue(source)).toThrow(failure)
    expect(snapshotPtcJsonValue({ after: true })).toEqual({ after: true })
  })
})

describe('flat worker JSON wire', () => {
  it('round-trips every JSON root while preserving object keys and container order', () => {
    const withPrototypeKey = Object.create(null) as Record<string, unknown>
    withPrototypeKey.__proto__ = { safe: true }
    const values = [null, false, true, 1.25, 'text', [], {}, [1, { nested: [2] }], withPrototypeKey]
    for (const value of values) {
      const snapshot = snapshotPtcJsonValue(value)
      expect(snapshot).not.toBeUndefined()
      expect(decodePtcJsonWire(encodePtcJsonWire(snapshot!))).toEqual(snapshot)
    }
    const decoded = decodePtcJsonWire(encodePtcJsonWire(snapshotPtcJsonValue(withPrototypeKey)!)) as Record<string, unknown>
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
    expect(decoded.__proto__).toEqual({ safe: true })
  })

  it('round-trips deep values through a bounded-depth token array', () => {
    let value: unknown = 'leaf'
    for (let depth = 0; depth < 5_000; depth++) value = [value]
    const snapshot = snapshotPtcJsonValue(value)!
    const wire = encodePtcJsonWire(snapshot)
    expect(wire).toHaveLength(5_001)

    let cursor = decodePtcJsonWire(wire)
    for (let depth = 0; depth < 5_000; depth++) {
      expect(Array.isArray(cursor)).toBe(true)
      cursor = Array.isArray(cursor) ? cursor[0] : undefined
    }
    expect(cursor).toBe('leaf')
  })

  it('rejects malformed, incomplete, lossy, sparse, decorated, and throwing wire values', () => {
    const sparse = new Array(1)
    const compensatedSparse = new Array(1)
    Object.defineProperty(compensatedSparse, 'extra', { value: true })
    const decorated: unknown[] = [null]
    Object.defineProperty(decorated, 'extra', { value: true })
    const throwing: unknown[] = []
    Object.defineProperty(throwing, 0, { enumerable: true, get: () => { throw new Error('wire getter') } })
    const decoratedKeys: unknown[] = ['x']
    Object.defineProperty(decoratedKeys, 'extra', { value: true })
    const foreignMarker: Record<string, unknown> = { kind: 'array', length: 0 }
    Object.setPrototypeOf(foreignMarker, {})
    const hiddenMarker = Object.defineProperty({ kind: 'array', length: 0 }, 'hidden', { value: true })

    for (const value of [
      undefined,
      null,
      {},
      [],
      sparse,
      compensatedSparse,
      decorated,
      throwing,
      [undefined],
      [-0],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [1, 2],
      [[]],
      [foreignMarker],
      [hiddenMarker],
      [{ kind: 'unknown' }],
      [{ kind: 'array', bogus: 0 }],
      [{ kind: 'array' }],
      [{ kind: 'array', length: '1' }],
      [{ kind: 'array', length: -1 }],
      [{ kind: 'array', length: Number.MAX_SAFE_INTEGER + 1 }],
      [{ kind: 'array', length: 1 }],
      [{ kind: 'array', length: 2 }, { kind: 'array', length: 1 }, null],
      [{ kind: 'array', length: 0, extra: true }],
      [{ kind: 'object' }],
      [{ kind: 'object', keys: 'x' }],
      [{ kind: 'object', keys: decoratedKeys }],
      [{ kind: 'object', keys: [1] }],
      [{ kind: 'object', keys: ['x', 'x'] }, 1, 2],
      [{ kind: 'object', keys: ['x'] }],
      [{ kind: 'object', keys: [], extra: true }],
    ]) {
      expect(decodePtcJsonWire(value)).toBeUndefined()
    }
  })

  it('rejects invalid values passed through a forged static type', () => {
    expect(() => encodePtcJsonWire([undefined] as never)).toThrow(/sparse JSON array/)
    expect(() => encodePtcJsonWire({ value: undefined } as never)).toThrow(/undefined JSON object property/)
  })
})
