/** Shared JSON and exact-field validation behavior. */

import { describe, expect, it } from 'vitest'
import { inspectorId } from '../src/shared/identity.ts'
import { isJsonValue, isPlainObject, jsonByteLength, requireJsonObject } from '../src/shared/json.ts'
import {
  exactKeys,
  exactObject,
  optionalBoolean,
  optionalNonNegativeNumber,
  optionalString,
  wireId,
} from '../src/shared/validation.ts'

describe('Inspector JSON values', () => {
  it('accepts every lossless JSON category and measures UTF-8 bytes', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: '好' })
    expect([null, 'text', true, 1, [1, 'two'], { nested: [false] }, nullPrototype].every(isJsonValue)).toBe(true)
    expect(jsonByteLength({ value: '好' })).toBe(Buffer.byteLength('{"value":"好"}'))
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(nullPrototype)).toBe(true)
    expect(requireJsonObject({ value: 1 }, 'payload')).toEqual({ value: 1 })
  })

  it('rejects lossy primitives, cycles, exotic arrays, and accessor objects', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const arrayWithField = [1]
    Reflect.set(arrayWithField, 'extra', true)
    const inheritedArray: unknown = Object.setPrototypeOf([1], null)
    const symbolObject = { [Symbol('field')]: true }
    const hidden = {}
    Object.defineProperty(hidden, 'value', { value: 1, enumerable: false })
    const accessor = {}
    Object.defineProperty(accessor, 'value', { get: () => 1, enumerable: true })
    const rejected = [
      undefined, () => undefined, Number.NaN, -0, cyclic, arrayWithField,
      inheritedArray, new Date(), symbolObject, hidden, accessor,
    ]
    for (const value of rejected) {
      expect(isJsonValue(value)).toBe(false)
    }
    expect(() => requireJsonObject([], 'payload')).toThrow('payload must be a JSON object')
    expect(() => requireJsonObject(cyclic, 'payload')).toThrow('payload must be a JSON object')
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject([])).toBe(false)
  })
})

describe('Inspector exact-field readers', () => {
  it('accepts declared fields and optional values', () => {
    const record = { text: 'value', enabled: true, timeout: 0 }
    expect(exactObject(record, ['text', 'enabled', 'timeout'], 'record')).toBe(record)
    expect(() => { exactKeys(record, ['text', 'enabled', 'timeout'], 'record') }).not.toThrow()
    expect(optionalString(record, 'text')).toEqual({ text: 'value' })
    expect(optionalBoolean(record, 'enabled')).toEqual({ enabled: true })
    expect(optionalNonNegativeNumber(record, 'timeout')).toEqual({ timeout: 0 })
    expect(optionalString({}, 'text')).toEqual({})
    expect(optionalBoolean({}, 'enabled')).toEqual({})
    expect(optionalNonNegativeNumber({}, 'timeout')).toEqual({})
    expect(wireId<'ProbeId'>('probe', 'probeId')).toBe('probe')
    expect(inspectorId<'ProbeId'>('probe', 'probeId')).toBe('probe')
  })

  it('rejects unknown, symbolic, and wrongly typed fields', () => {
    expect(() => exactObject([], [], 'record')).toThrow('record must be an object')
    expect(() => { exactKeys({ extra: true }, [], 'record') }).toThrow('unknown field')
    expect(() => { exactKeys({ [Symbol('extra')]: true }, [], 'record') }).toThrow('unknown field')
    expect(() => wireId<'ProbeId'>(1, 'probeId')).toThrow('probeId must be a string')
    expect(() => inspectorId<'ProbeId'>('', 'probeId')).toThrow('1 to 256 characters')
    expect(() => inspectorId<'ProbeId'>('x'.repeat(257), 'probeId')).toThrow('1 to 256 characters')
    expect(() => optionalString({ text: 1 }, 'text')).toThrow('text must be a string')
    expect(() => optionalBoolean({ enabled: 1 }, 'enabled')).toThrow('enabled must be a boolean')
    for (const timeout of ['1', Number.NaN, -1]) {
      expect(() => optionalNonNegativeNumber({ timeout }, 'timeout')).toThrow('non-negative finite number')
    }
  })
})
