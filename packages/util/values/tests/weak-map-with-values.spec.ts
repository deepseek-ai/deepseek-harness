import { describe, expect, it } from 'vitest'
import { WeakMapWithValues } from '../src/index.ts'

describe('WeakMapWithValues', () => {
  it('looks up weak keys while iterating strongly retained values in insertion order', () => {
    const firstKey = {}
    const secondKey = {}
    const firstValue = { name: 'first' }
    const secondValue = { name: 'second' }
    const values = new WeakMapWithValues<object, { name: string }>()

    expect(values.get(firstKey)).toBeUndefined()
    expect(values.has(firstKey)).toBe(false)
    expect(values.set(firstKey, firstValue)).toBe(values)
    values.set(secondKey, secondValue)

    expect(values.get(firstKey)).toBe(firstValue)
    expect(values.has(secondKey)).toBe(true)
    expect([...values.values]).toEqual([firstValue, secondValue])
  })

  it('keeps an identical association and replaces its prior retained value', () => {
    const key = {}
    const firstValue = { name: 'first' }
    const replacement = { name: 'replacement' }
    const values = new WeakMapWithValues<object, { name: string }>()

    values.set(key, firstValue)
    values.set(key, firstValue)
    expect([...values.values]).toEqual([firstValue])

    values.set(key, replacement)
    expect(values.get(key)).toBe(replacement)
    expect([...values.values]).toEqual([replacement])
  })

  it('deletes one association and clears every lookup and retained value', () => {
    const firstKey = {}
    const secondKey = {}
    const values = new WeakMapWithValues<object, string>()
    values.set(firstKey, 'first').set(secondKey, 'second')

    expect(values.delete({})).toBe(false)
    expect(values.delete(firstKey)).toBe(true)
    expect(values.has(firstKey)).toBe(false)
    expect([...values.values]).toEqual(['second'])

    values.clear()
    expect(values.get(secondKey)).toBeUndefined()
    expect(values.has(secondKey)).toBe(false)
    expect([...values.values]).toEqual([])

    values.set(firstKey, 'again')
    expect(values.get(firstKey)).toBe('again')
    expect([...values.values]).toEqual(['again'])
  })
})
