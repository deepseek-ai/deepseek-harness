import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { isJsonValue, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

function objectWithForgedIntrinsicPrototype(revoked = false): Record<string, unknown> {
  const prototype = Object.create(null) as Record<string, unknown>
  const ForgedObject = function ForgedObject(): void {}
  Object.defineProperty(ForgedObject, 'name', { value: 'Object' })
  ForgedObject.prototype = prototype
  const constructor = revoked ? Proxy.revocable(ForgedObject, {}) : undefined
  if (constructor !== undefined) constructor.revoke()
  Object.defineProperty(prototype, 'constructor', { value: constructor?.proxy ?? ForgedObject })
  return Object.assign(Object.create(prototype) as Record<string, unknown>, { value: 1 })
}

describe('snapshotJsonValue and isJsonValue', () => {
  it('copies the complete JSON scalar vocabulary and rejects unsupported scalars', () => {
    const unsupportedFunction = (): void => {}

    expect(snapshotJsonValue(null)).toBeNull()
    expect(snapshotJsonValue(true)).toBe(true)
    expect(snapshotJsonValue('text')).toBe('text')
    expect(snapshotJsonValue(1.25)).toBe(1.25)
    expect(snapshotJsonValue(-0)).toBeUndefined()
    expect(isJsonValue(-0)).toBe(false)
    expect(snapshotJsonValue(Number.NaN)).toBeUndefined()
    expect(snapshotJsonValue(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(snapshotJsonValue(1n)).toBeUndefined()
    expect(snapshotJsonValue(unsupportedFunction)).toBeUndefined()
    expect(snapshotJsonValue(Symbol('value'))).toBeUndefined()
    const unsupportedUndefined: unknown = undefined
    expect(snapshotJsonValue(unsupportedUndefined)).toBeUndefined()
  })

  it('recursively detaches dense arrays and plain or null-prototype objects', () => {
    const shared = { value: 1 }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { shared })
    const source = { list: [nullPrototype, shared], alias: shared }

    const snapshot = snapshotJsonValue(source)!
    shared.value = 2

    expect(snapshot).toEqual({ list: [{ shared: { value: 1 } }, { value: 1 }], alias: { value: 1 } })
    expect(snapshot).not.toBe(source)
    expect(snapshot.list).not.toBe(source.list)
    expect(snapshot.alias).not.toBe(shared)
    expect(snapshot.list[0]).not.toBe(nullPrototype)
    expect(Object.getPrototypeOf(snapshot.list[0])).toBe(Object.prototype)
  })

  it('accepts intrinsic plain containers from another JavaScript realm', () => {
    const foreign = runInNewContext('({ object: { nested: [1] }, array: [2, { ok: true }] })') as {
      object: { nested: number[] }
      array: JsonValue[]
    }

    expect(isJsonValue(foreign.object)).toBe(true)
    expect(isJsonValue(foreign.array)).toBe(true)
    const objectSnapshot = snapshotJsonValue(foreign.object)!
    const arraySnapshot = snapshotJsonValue(foreign.array)!
    expect(objectSnapshot).toEqual({ nested: [1] })
    expect(arraySnapshot).toEqual([2, { ok: true }])
    expect(Object.getPrototypeOf(objectSnapshot)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(arraySnapshot)).toBe(Array.prototype)
  })

  it('accepts intrinsic containers with WebKit native constructor formatting across realms', () => {
    const foreign = runInNewContext('({ Object, Array, value: { nested: [1] } })') as {
      Object: ObjectConstructor
      Array: ArrayConstructor
      value: { nested: number[] }
    }
    const originalDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')!
    const originalToString = originalDescriptor.value as (this: unknown) => string
    const toString = vi.spyOn(Function.prototype, 'toString').mockImplementation(function (this: unknown) {
      if (this === Object || this === foreign.Object) return 'function Object() {\n    [native code]\n}'
      if (this === Array || this === foreign.Array) return 'function Array() {\n    [native code]\n}'
      return originalToString.call(this)
    })
    try {
      for (const value of [{ nested: [1] }, [1], foreign.value, foreign.value.nested]) {
        expect(isJsonValue(value)).toBe(true)
        const snapshot = snapshotJsonValue(value)
        expect(snapshot).toEqual(value)
        expect(snapshot).not.toBe(value)
      }
      const forged = objectWithForgedIntrinsicPrototype()
      expect(isJsonValue(forged)).toBe(false)
      expect(snapshotJsonValue(forged)).toBeUndefined()
    } finally {
      toString.mockRestore()
    }
    expect(Object.getOwnPropertyDescriptor(Function.prototype, 'toString')).toEqual(originalDescriptor)
  })

  it('reads each object value and array slot once while materializing', () => {
    class Exotic {
      readonly accepted = false
    }
    let objectReads = 0
    let arrayReads = 0
    const nested = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        objectReads += 1
        return objectReads === 1 ? { accepted: true } : new Exotic()
      },
    })
    const array = new Array<unknown>(1)
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        arrayReads += 1
        return arrayReads === 1 ? nested : new Exotic()
      },
    })

    expect(snapshotJsonValue(array)).toEqual([{ value: { accepted: true } }])
    expect(objectReads).toBe(1)
    expect(arrayReads).toBe(1)
  })

  it.each(['snapshot', 'predicate'] as const)('keeps captured keys and lengths with depth-first getter reads in %s mode', (mode) => {
    const reads: string[] = []
    const items: unknown[] = [0, 1]
    Object.defineProperty(items, 0, {
      enumerable: true,
      get: () => {
        reads.push('item')
        items[1] = 7
        items.push('added')
        return { get child() { reads.push('child'); return 3 } }
      },
    })
    const source = {
      get items() {
        reads.push('items')
        Object.defineProperty(source, 'added', {
          enumerable: true,
          get: () => { reads.push('added'); return 9 },
        })
        return items
      },
      get tail() { reads.push('tail'); return 4 },
    }

    const result = mode === 'snapshot' ? snapshotJsonValue(source) : isJsonValue(source)

    expect(result).toEqual(mode === 'snapshot' ? { items: [{ child: 3 }, 7], tail: 4 } : true)
    expect(reads).toEqual(['items', 'item', 'child', 'tail'])
  })

  it.each(['snapshot', 'predicate'] as const)('rejects an array slot deleted by an earlier getter in %s mode', (mode) => {
    const source = [0, 1]
    Object.defineProperty(source, 0, {
      enumerable: true,
      get: () => {
        Reflect.deleteProperty(source, 1)
        return 0
      },
    })

    expect(mode === 'snapshot' ? snapshotJsonValue(source) : isJsonValue(source))
      .toBe(mode === 'snapshot' ? undefined : false)
  })

  it.each(['snapshot', 'predicate'] as const)('uses one captured Proxy index schedule in %s mode', (mode) => {
    for (const secondLength of [2, 1.5, Number.NaN]) {
      let coercions = 0
      const length = {
        valueOf() {
          coercions += 1
          if (coercions > 2) throw new Error('length was coerced again')
          return coercions === 1 ? 2 : secondLength
        },
      }
      const source = new Proxy([1, 2], {
        get(target, key): unknown {
          if (key === 'length') return length
          const value: unknown = Reflect.get(target, key)
          return value
        },
      })
      const expected = Number.isNaN(secondLength) ? [] : secondLength === 2 ? [1, 2] : undefined

      const result = mode === 'snapshot' ? snapshotJsonValue(source) : isJsonValue(source)

      expect(result).toEqual(mode === 'snapshot' ? expected : expected !== undefined)
      expect(coercions).toBe(2)
    }
  })

  it.each([false, true])('does not read an array slot outside a fractional Proxy length, throwing slot=%s', (throwing) => {
    let reads = 0
    const source = new Proxy([42], {
      get(target, key): unknown {
        if (key === 'length') return 1 - Number.EPSILON / 2
        if (key === '0') {
          reads += 1
          if (throwing) throw new Error('array slot must not be read')
        }
        const value: unknown = Reflect.get(target, key)
        return value
      },
    })

    expect(JSON.stringify(source)).toBe('[]')
    expect(snapshotJsonValue(source)).toEqual([])
    expect(isJsonValue(source)).toBe(true)
    expect(reads).toBe(0)
  })

  it('detaches every occurrence of a shared child in a wide array', () => {
    const shared = { nested: [{ value: 1 }] }
    const source = Array.from({ length: 4_096 }, () => shared)

    expect(isJsonValue(source)).toBe(true)
    const snapshot = snapshotJsonValue(source)!
    expect(snapshot).toEqual(source)
    shared.nested[0]!.value = 2
    snapshot[0]!.nested[0]!.value = 3

    expect(source.at(-1)?.nested[0]?.value).toBe(2)
    expect(snapshot[0]?.nested[0]?.value).toBe(3)
    expect(snapshot.at(-1)?.nested[0]?.value).toBe(1)
  })

  it('accepts deeply nested valid JSON without using the JavaScript call stack', () => {
    let value: JsonValue = 'leaf'
    for (let depth = 0; depth < 5_000; depth++) value = [value]

    expect(isJsonValue(value)).toBe(true)
    let cursor: JsonValue | undefined = snapshotJsonValue(value)
    for (let depth = 0; depth < 5_000; depth++) {
      expect(Array.isArray(cursor)).toBe(true)
      cursor = Array.isArray(cursor) ? cursor[0] : undefined
    }
    expect(cursor).toBe('leaf')
  })

  it('rejects exotic containers, sparse or decorated arrays, cycles, and invalid children', () => {
    class ExoticObject {
      readonly value = 1
    }
    class ExoticArray extends Array<number> {}
    const sparse = new Array<number>(1)
    const compensatedSparse = new Array<number>(1)
    Object.defineProperty(compensatedSparse, 'extra', { value: true })
    const decorated = [1]
    Object.defineProperty(decorated, 'extra', { value: true })
    const symbolDecorated = [1]
    Object.defineProperty(symbolDecorated, Symbol('extra'), { value: true })
    const hiddenObject = Object.defineProperty({}, 'hidden', { value: true })
    const symbolObject = { [Symbol('extra')]: true }
    const customPrototype = Object.create(null) as Record<string, unknown>
    const customPrototypeObject = Object.assign(Object.create(customPrototype) as Record<string, unknown>, { value: 1 })
    const forgedIntrinsicObject = objectWithForgedIntrinsicPrototype()
    const revokedIntrinsicObject = objectWithForgedIntrinsicPrototype(true)
    const forgedPrototype: unknown[] = []
    Object.setPrototypeOf(forgedPrototype, null)
    const forgedArray = [1]
    Object.setPrototypeOf(forgedArray, forgedPrototype)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const foreignExotics = runInNewContext(`(() => {
      class Box { constructor() { this.value = 1 } }
      class List extends Array {}
      return [new Box(), new List(1)]
    })()`) as [object, unknown[]]

    expect(snapshotJsonValue(new ExoticObject())).toBeUndefined()
    expect(snapshotJsonValue(new Map([['value', 1]]))).toBeUndefined()
    expect(snapshotJsonValue(new ExoticArray(1))).toBeUndefined()
    expect(snapshotJsonValue(foreignExotics[0])).toBeUndefined()
    expect(snapshotJsonValue(foreignExotics[1])).toBeUndefined()
    expect(snapshotJsonValue(sparse)).toBeUndefined()
    expect(snapshotJsonValue(compensatedSparse)).toBeUndefined()
    expect(snapshotJsonValue(decorated)).toBeUndefined()
    expect(snapshotJsonValue(symbolDecorated)).toBeUndefined()
    expect(snapshotJsonValue(hiddenObject)).toBeUndefined()
    expect(snapshotJsonValue(symbolObject)).toBeUndefined()
    expect(snapshotJsonValue(customPrototypeObject)).toBeUndefined()
    expect(snapshotJsonValue(forgedIntrinsicObject)).toBeUndefined()
    expect(snapshotJsonValue(revokedIntrinsicObject)).toBeUndefined()
    expect(snapshotJsonValue(forgedArray)).toBeUndefined()
    expect(snapshotJsonValue(cyclic)).toBeUndefined()
    expect(snapshotJsonValue([undefined])).toBeUndefined()
    expect(snapshotJsonValue({ value: undefined })).toBeUndefined()
  })

  it('preserves a literal __proto__ JSON key without changing the snapshot prototype', () => {
    const source = Object.create(null) as Record<string, unknown>
    source.__proto__ = { safe: true }

    const snapshot = snapshotJsonValue(source)!

    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(snapshot, '__proto__')).toBe(true)
    expect(snapshot.__proto__).toEqual({ safe: true })
  })

  it('propagates a throwing getter after reading it once', () => {
    const failure = new Error('getter failed')
    let reads = 0
    const source = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1
        throw failure
      },
    })

    expect(() => snapshotJsonValue(source)).toThrow(failure)
    expect(reads).toBe(1)
  })
})

describe('isJsonValue', () => {
  it('recognizes supported scalars and rejects every lossy scalar case', () => {
    const unsupportedFunction = (): void => {}
    const unsupportedUndefined: unknown = undefined

    expect(isJsonValue(null)).toBe(true)
    expect(isJsonValue(false)).toBe(true)
    expect(isJsonValue('text')).toBe(true)
    expect(isJsonValue(1.25)).toBe(true)
    expect(isJsonValue(-0)).toBe(false)
    expect(isJsonValue(Number.NaN)).toBe(false)
    expect(isJsonValue(1n)).toBe(false)
    expect(isJsonValue(unsupportedFunction)).toBe(false)
    expect(isJsonValue(Symbol('value'))).toBe(false)
    expect(isJsonValue(unsupportedUndefined)).toBe(false)
  })

  it('accepts dense arrays and plain objects, including null-prototype records', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: true })

    expect(isJsonValue([1, { nested: null }, nullPrototype])).toBe(true)
    expect(isJsonValue({ value: [1, 2] })).toBe(true)
    expect(isJsonValue(nullPrototype)).toBe(true)
  })

  it('rejects sparse or decorated arrays, invalid children, exotic objects, and cycles', () => {
    class Exotic {
      readonly value = 1
    }
    class ExoticArray extends Array<number> {}
    const sparse = new Array<number>(1)
    const compensatedSparse = new Array<number>(1)
    Object.defineProperty(compensatedSparse, 'extra', { value: true })
    const decorated = Object.assign([1], { extra: true })
    const symbolDecorated = [1]
    Object.defineProperty(symbolDecorated, Symbol('extra'), { value: true })
    const hiddenObject = Object.defineProperty({}, 'hidden', { value: true })
    const symbolObject = { [Symbol('extra')]: true }
    const customPrototype = Object.create(null) as Record<string, unknown>
    const customPrototypeObject = Object.assign(Object.create(customPrototype) as Record<string, unknown>, { value: 1 })
    const forgedIntrinsicObject = objectWithForgedIntrinsicPrototype()
    const revokedIntrinsicObject = objectWithForgedIntrinsicPrototype(true)
    const forgedPrototype: unknown[] = []
    Object.setPrototypeOf(forgedPrototype, null)
    const forgedArray = [1]
    Object.setPrototypeOf(forgedArray, forgedPrototype)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(isJsonValue(sparse)).toBe(false)
    expect(isJsonValue(compensatedSparse)).toBe(false)
    expect(isJsonValue(decorated)).toBe(false)
    expect(isJsonValue(symbolDecorated)).toBe(false)
    expect(isJsonValue(hiddenObject)).toBe(false)
    expect(isJsonValue(symbolObject)).toBe(false)
    expect(isJsonValue(customPrototypeObject)).toBe(false)
    expect(isJsonValue(forgedIntrinsicObject)).toBe(false)
    expect(isJsonValue(revokedIntrinsicObject)).toBe(false)
    expect(isJsonValue(forgedArray)).toBe(false)
    expect(isJsonValue(new ExoticArray(1))).toBe(false)
    expect(isJsonValue([undefined])).toBe(false)
    expect(isJsonValue({ value: undefined })).toBe(false)
    expect(isJsonValue(new Exotic())).toBe(false)
    expect(isJsonValue(cyclic)).toBe(false)
  })
})
