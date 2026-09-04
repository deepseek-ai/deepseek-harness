import { describe, expect, it } from 'vitest'
import {
  inspectSessionFormatVersion,
  sessionFormatCount,
  sessionFormatSafeInteger,
  snapshotSessionFormatArtifact,
  snapshotSessionFormatHeader,
  snapshotSessionFormatJson,
} from '../src/index.ts'

describe('lossless Session format JSON snapshots', () => {
  it.each([
    ['negative zero', -0],
    ['non-finite number', Number.POSITIVE_INFINITY],
    ['undefined member', { value: undefined }],
    ['sparse array', Array(1)],
    ['symbol member', { [Symbol('hidden')]: true }],
    ['non-enumerable member', Object.defineProperty({}, 'hidden', { value: true })],
    ['array property', Object.assign([], { extra: true })],
  ])('refuses %s that JSON cannot preserve', (_name, value) => {
    expect(() => snapshotSessionFormatJson(value, 'payload')).toThrow('payload is not lossless JSON')
  })

  it('detaches, freezes, and retains repeated non-cyclic values and __proto__ keys', () => {
    const shared = { value: 1 }
    const source = JSON.parse('{"__proto__":{"safe":true}}') as Record<string, unknown>
    source['values'] = [shared, shared]

    const snapshot = snapshotSessionFormatJson(source) as Record<string, unknown>

    expect(snapshot).toEqual(source)
    expect(snapshot).not.toBe(source)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot['values'])).toBe(true)
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
  })

  it('refuses invalid scalar coordinates, cycles, and custom prototypes', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    class RecordValue { value = 1 }
    class ArrayValue extends Array<number> {}

    expect(() => sessionFormatCount(-1, 'count')).toThrow(/non-negative/)
    expect(() => sessionFormatSafeInteger(1.5, 'integer')).toThrow(/safe integer/)
    expect(() => inspectSessionFormatVersion([])).toThrow(/header/)
    expect(() => snapshotSessionFormatJson(cyclic)).toThrow(/not lossless JSON/)
    expect(() => snapshotSessionFormatJson(new RecordValue())).toThrow(/not lossless JSON/)
    expect(() => snapshotSessionFormatJson(new ArrayValue(1))).toThrow(/not lossless JSON/)
  })

  it.each([
    ['non-object header', { header: null, inheritedEventCount: 0, events: [] }],
    ['non-array events', { header: { version: 1 }, inheritedEventCount: 0, events: null }],
    ['non-object event', { header: { version: 1 }, inheritedEventCount: 0, events: [null] }],
    ['non-dense seq', { header: { version: 1 }, inheritedEventCount: 0, events: [{ type: 'x', seq: 1, time: 1, data: {} }] }],
    ['empty type', { header: { version: 1 }, inheritedEventCount: 0, events: [{ type: '', seq: 0, time: 1, data: {} }] }],
    ['invalid time', { header: { version: 1 }, inheritedEventCount: 0, events: [{ type: 'x', seq: 0, time: 1.5, data: {} }] }],
    ['missing data', { header: { version: 1 }, inheritedEventCount: 0, events: [{ type: 'x', seq: 0, time: 1 }] }],
    ['oversized cut', { header: { version: 1 }, inheritedEventCount: 1, events: [] }],
  ])('refuses an artifact with %s', (_name, artifact) => {
    expect(() => snapshotSessionFormatArtifact(artifact as never)).toThrow()
  })

  it('refuses a non-object header snapshot', () => {
    expect(() => snapshotSessionFormatHeader(null as never)).toThrow(/header|object/)
    expect(() => snapshotSessionFormatHeader({
      version: 1, id: 'missing-seeded', createdAt: 1, delegationDepth: 0,
    } as never)).toThrow(/isSeeded/)
  })
})
