import { describe, expect, it, vi } from 'vitest'
import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from '../src/output-json.ts'

describe('truncateJsonStringBytes', () => {
  it('returns a fitting string whole and rejects budgets without JSON quotes', () => {
    expect(truncateJsonStringBytes('fits', 6)).toBe('fits')
    expect(truncateJsonStringBytes('x', 1)).toBe('')
    expect(jsonStringBytesUpTo('fits', 6)).toBe(6)
    expect(jsonStringBytesUpTo('fits', 5)).toBeUndefined()
  })

  it('accounts every JSON escape and cuts only between complete code points', () => {
    const prefix = '"\\\b\t\n\f\r\u0000😀\ud800€a'
    const text = `${prefix}z`
    const budget = Buffer.byteLength(JSON.stringify(prefix), 'utf8')

    expect(truncateJsonStringBytes(text, budget)).toBe(prefix)
    expect(Buffer.byteLength(JSON.stringify(truncateJsonStringBytes(text, budget)), 'utf8')).toBe(budget)
  })

  it('bounds hostile strings without materializing their complete escaped form', () => {
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('must not stringify') })
    try {
      expect(jsonStringBytesUpTo('"'.repeat(10_000), 32)).toBeUndefined()
      expect(truncateJsonStringBytes('"'.repeat(10_000), 32)).toBe('"'.repeat(15))
    } finally {
      stringify.mockRestore()
    }
  })
})

describe('jsonValueBytesUpTo', () => {
  it('matches JSON serialization for every lossless value branch and stops at the cap', () => {
    const value = {
      empty: {},
      nil: null,
      yes: true,
      no: false,
      number: 1.5,
      text: '"\n😀',
      array: [1, 'x'],
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')

    expect(jsonValueBytesUpTo(value, bytes)).toBe(bytes)
    expect(jsonValueBytesUpTo(value, bytes - 1)).toBeUndefined()
    expect(jsonValueBytesUpTo({}, 1)).toBeUndefined()
    expect(jsonValueBytesUpTo([], 1)).toBeUndefined()
    expect(jsonValueBytesUpTo([], 2)).toBe(2)
    expect(jsonValueBytesUpTo(null, 3)).toBeUndefined()
    expect(jsonValueBytesUpTo(10, 1)).toBeUndefined()
    expect(jsonValueBytesUpTo(false, 4)).toBeUndefined()
    expect(jsonValueBytesUpTo(new Array<never>(1), 10)).toBeUndefined()
    expect(jsonValueBytesUpTo([null], 5)).toBeUndefined()
    expect(jsonValueBytesUpTo([0, 0], 3)).toBeUndefined()
    expect(jsonValueBytesUpTo({ a: null, b: null }, 10)).toBeUndefined()
    expect(jsonValueBytesUpTo({ long: null }, 2)).toBeUndefined()
    expect(jsonValueBytesUpTo({ '': null }, 4)).toBeUndefined()
    expect(jsonValueBytesUpTo({ a: null }, 9)).toBeUndefined()
    expect(jsonValueBytesUpTo({ a: undefined } as unknown as PtcJsonValue, 100)).toBeUndefined()
  })

  it('meters deeply nested arrays without recursive stack growth', () => {
    let value: PtcJsonValue = null
    for (let depth = 0; depth < 5_000; depth++) value = [value]

    expect(jsonValueBytesUpTo(value, 10_004)).toBe(10_004)
    expect(jsonValueBytesUpTo(value, 10_003)).toBeUndefined()
  })

  it('uses module-captured intrinsics after model-visible globals are mutated', () => {
    const value: PtcJsonValue = { payload: ['€', 42] }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    const arrayIsArrayDescriptor = Object.getOwnPropertyDescriptor(Array, 'isArray')!
    const arrayPopDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'pop')!
    const arrayPushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(Buffer, 'byteLength')!
    const objectKeysDescriptor = Object.getOwnPropertyDescriptor(Object, 'keys')!
    const charCodeAtDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!
    const codePointAtDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'codePointAt')!
    const sliceDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'slice')!
    let measured: number | undefined
    let prefix = ''
    try {
      Array.isArray = (_value: unknown): _value is never[] => false
      Array.prototype.pop = () => { throw new Error('mutated pop') }
      Array.prototype.push = () => { throw new Error('mutated push') }
      Buffer.byteLength = () => 0
      Object.keys = () => []
      String.prototype.charCodeAt = () => { throw new Error('mutated charCodeAt') }
      String.prototype.codePointAt = () => { throw new Error('mutated codePointAt') }
      String.prototype.slice = () => { throw new Error('mutated slice') }
      measured = jsonValueBytesUpTo(value, bytes)
      prefix = truncateJsonStringBytes('€x', 5)
    } finally {
      Object.defineProperty(Array, 'isArray', arrayIsArrayDescriptor)
      Object.defineProperty(Array.prototype, 'pop', arrayPopDescriptor)
      Object.defineProperty(Array.prototype, 'push', arrayPushDescriptor)
      Object.defineProperty(Buffer, 'byteLength', byteLengthDescriptor)
      Object.defineProperty(Object, 'keys', objectKeysDescriptor)
      Object.defineProperty(String.prototype, 'charCodeAt', charCodeAtDescriptor)
      Object.defineProperty(String.prototype, 'codePointAt', codePointAtDescriptor)
      Object.defineProperty(String.prototype, 'slice', sliceDescriptor)
    }
    expect(measured).toBe(bytes)
    expect(prefix).toBe('€')
  })
})
