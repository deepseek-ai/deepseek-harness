/** Realm-independent recognition of plain arrays and records. */

import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { hasPlainPrototype } from '@deepseek-ai/dsh-util-values'

describe('hasPlainPrototype', () => {
  it('accepts plain arrays and plain or null-prototype records from any realm without inspecting their contents', () => {
    const foreign = runInNewContext('[{ value: new Map() }, Object.create(null), [new Set()]]') as unknown[]
    for (const value of [{ agent: () => undefined }, Object.create(null) as object, [new Date(0)], ...foreign]) {
      expect(hasPlainPrototype(value)).toBe(true)
    }
  })

  it('rejects scalars, class instances, built-in objects, and array subclasses from any realm', () => {
    class Fixture {
      readonly value = 1
    }
    class List extends Array<number> {}
    const foreign = runInNewContext('[new (class Fixture {})(), new Map(), new (class List extends Array {})()]') as unknown[]
    for (const value of [null, undefined, 'record', 1, () => undefined, new Fixture(), new List(), new Map(), new Date(0), ...foreign]) {
      expect(hasPlainPrototype(value)).toBe(false)
    }
  })

  it('rejects records and arrays whose custom prototype could supply toJSON', () => {
    const toJSON = (): string => 'changed'
    const record: object = Object.assign(Object.create(Object.assign(Object.create(null) as object, { toJSON })) as object, { answer: 'original' })
    const array = Object.setPrototypeOf(['original'], Object.setPrototypeOf(Object.assign([], { toJSON }), Object.prototype) as object) as unknown[]
    expect([JSON.stringify(record), JSON.stringify(array)]).toEqual(['"changed"', '"changed"'])
    const borrowedConstructor = Object.create(Object.assign(Object.create(null) as object, { constructor: Object })) as object
    const foreign = runInNewContext(`[
      Object.create(Object.assign(Object.create(null), { toJSON: () => 'changed' })),
      Object.setPrototypeOf(['original'], Object.assign([], { toJSON: () => 'changed' })),
    ]`) as unknown[]
    for (const value of [
      record,
      array,
      Object.setPrototypeOf(['original'], Object.assign([], { toJSON })),
      Object.setPrototypeOf(['original'], null),
      borrowedConstructor,
      ...foreign,
    ]) {
      expect(hasPlainPrototype(value)).toBe(false)
    }
  })
})
