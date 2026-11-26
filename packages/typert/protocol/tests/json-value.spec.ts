import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { isRemoteJsonValue, isRemoteUplinkItem } from '@deepseek-ai/dsh-typert-protocol'

/** Evaluate an expression in a fresh realm, as an isolated Client plugin's iframe builds its values. */
function otherRealm(expression: string): unknown {
  return runInNewContext(`(${expression})`)
}

describe('Remote JSON values from another realm', () => {
  it('accepts plain records, arrays, and parsed JSON built by another realm', () => {
    const value = otherRealm('{ answer: { selected: ["a", "b"], notes: Object.assign(Object.create(null), { text: "ok" }) } }')
    expect(Object.getPrototypeOf(value)).not.toBe(Object.prototype)
    expect(isRemoteJsonValue(value)).toBe(true)
    expect(isRemoteJsonValue(otherRealm('JSON.parse(\'{"list":[1,{"x":null}]}\')'))).toBe(true)
    expect(isRemoteJsonValue(otherRealm('[[], {}]'))).toBe(true)
    expect(isRemoteUplinkItem(otherRealm('{ item: [true] }'))).toBe(true)
  })

  it('rejects another realm\'s class instances, built-in objects, and array subclasses', () => {
    expect(isRemoteJsonValue(otherRealm('new (class Fixture { value = 1 })()'))).toBe(false)
    expect(isRemoteJsonValue(otherRealm('new Map([[1, 1]])'))).toBe(false)
    expect(isRemoteJsonValue(otherRealm('new Date(0)'))).toBe(false)
    expect(isRemoteJsonValue(otherRealm('new (class List extends Array {})()'))).toBe(false)
    expect(isRemoteJsonValue(otherRealm('{ nested: new Set() }'))).toBe(false)
    expect(isRemoteJsonValue(otherRealm('[undefined]'))).toBe(false)
  })
})

describe('Remote JSON values that inherit a custom prototype', () => {
  const toJSON = (): string => 'changed'

  it('rejects a record whose null-prototype parent supplies toJSON', () => {
    const prototype: object = Object.assign(Object.create(null) as object, { toJSON })
    const value: object = Object.assign(Object.create(prototype) as object, { answer: 'original' })
    expect(JSON.stringify(value)).toBe('"changed"')
    expect(isRemoteJsonValue(value)).toBe(false)
    expect(isRemoteJsonValue({ nested: value })).toBe(false)
    expect(isRemoteJsonValue(otherRealm('Object.create(Object.assign(Object.create(null), { toJSON: () => "changed" }))'))).toBe(false)
  })

  it('rejects arrays whose prototype chain is not a realm\'s intrinsic Array.prototype and Object.prototype', () => {
    const overArray = Object.setPrototypeOf(['original'], Object.assign([], { toJSON })) as unknown[]
    expect(JSON.stringify(overArray)).toBe('"changed"')
    for (const value of [
      overArray,
      Object.setPrototypeOf(['original'], Object.setPrototypeOf([], { toJSON }) as object),
      Object.setPrototypeOf(['original'], Object.setPrototypeOf(Object.assign([], { toJSON }), Object.prototype) as object),
      Object.setPrototypeOf(['original'], null),
      otherRealm('Object.setPrototypeOf(["original"], Object.setPrototypeOf(Object.assign([], { toJSON: () => "changed" }), Object.prototype))'),
    ]) {
      expect(isRemoteJsonValue(value)).toBe(false)
    }
  })
})
