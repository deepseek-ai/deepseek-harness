/** Shallow object inspection preserves native values and never executes getters. */

import { expect, it, onTestFinished, vi } from 'vitest'
import { InspectorObjectValue } from '../src/client/views/object-value.ts'

it('labels opaque scalar objects without exposing enumerable internals', () => {
  for (const [value, label] of [
    [new Date(0), 'Date(1970-01-01T00:00:00.000Z)'],
    [new Date(NaN), 'Date(Invalid)'],
    [/pattern/gi, '/pattern/gi'],
    [new WeakMap(), 'WeakMap'],
    [new WeakSet(), 'WeakSet'],
  ] as const) {
    const inspected = new InspectorObjectValue(value)
    expect(inspected.label).toBe(label)
    expect(inspected.expandable).toBe(false)
  }
  expect([...new InspectorObjectValue(null).entries()]).toEqual([])
  expect([...new InspectorObjectValue('value').entries()]).toEqual([])
})

it('keeps byte offsets for buffers and DataViews', () => {
  const bytes = Uint8Array.of(10, 20, 30, 40)
  const buffer = new InspectorObjectValue(bytes.buffer)
  expect(buffer.label).toBe('ArrayBuffer(4)')
  expect([...buffer.entries()]).toEqual([{ key: 'bytes', name: 'bytes', value: bytes }])
  expect([...new InspectorObjectValue(new DataView(bytes.buffer, 1, 2)).entries()])
    .toEqual([{ key: 'bytes', name: 'bytes', value: Uint8Array.of(20, 30) }])
})

it('supports null prototypes, symbol fields, accessors, and disappearing Proxy properties', () => {
  const getter = vi.fn(() => 'not read')
  const token = Symbol('token')
  const value = { [token]: 'symbol value' }
  Object.setPrototypeOf(value, null)
  Object.defineProperty(value, 'field', { get: getter, enumerable: true })
  const inspected = new InspectorObjectValue(value)
  expect(inspected.label).toBe('Object')
  expect([...inspected.entries()]).toEqual([
    { key: 'field', name: 'field', value: undefined, accessor: true },
    { key: 'symbol:1', name: 'Symbol(token)', value: 'symbol value' },
  ])
  expect(getter).not.toHaveBeenCalled()
  const changing = new Proxy({}, { ownKeys: () => ['removed'], getOwnPropertyDescriptor: () => undefined })
  expect([...new InspectorObjectValue(changing).entries()]).toEqual([])
  expect(new InspectorObjectValue(Object.create({ constructor: 1 })).label).toBe('Object')
})

it.each([Array.from({ length: 100_000 }, (_, index) => index), new Uint8Array(100_000)])(
  'reads only the first page of indexed values without listing all keys', (value) => {
    const keys = vi.spyOn(Reflect, 'ownKeys')
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptor')
    onTestFinished(() => { keys.mockRestore(); descriptors.mockRestore() })
    const entries = []
    for (const entry of new InspectorObjectValue(value).entries()) {
      entries.push(entry)
      if (entries.length === 51) break
    }
    expect(keys.mock.calls.length).toBe(0)
    expect(descriptors.mock.calls.filter(([object]) => object === value)).toHaveLength(50)
    expect(entries[0]?.properties).toBe(true)
    expect(entries.at(-1)?.name).toBe('49')
  },
)

it('keeps sparse slots, custom properties, and accessors separate without executing getters', () => {
  const array = new Array<unknown>(1_000_000)
  const read = vi.fn()
  Object.defineProperty(array, '0', { get: read })
  Object.defineProperty(array, 'note', { value: 'kept', enumerable: false })
  const symbol = Symbol('metadata')
  Object.defineProperty(array, symbol, { value: 7 })
  const iterator = new InspectorObjectValue(array).entries()
  const first = iterator.next()
  if (first.done) throw new Error('Missing collection properties')
  const properties = first.value
  expect(iterator.next().value).toMatchObject({ key: '0', accessor: true })
  expect(iterator.next().value).toMatchObject({ key: '1', absent: true })
  expect(read).not.toHaveBeenCalled()
  expect([...new InspectorObjectValue(properties.value).entries()]).toEqual([
    { key: 'note', name: 'note', value: 'kept' }, { key: 'symbol:3', name: 'Symbol(metadata)', value: 7 },
  ])
})

it('uses intrinsic TypedArray length even when an own getter shadows it', () => {
  const value = Uint8Array.of(3, 4)
  const read = vi.fn(() => { throw new Error('must not execute') })
  Object.defineProperty(value, 'length', { get: read })
  const entries = [...new InspectorObjectValue(value).entries()]
  expect(entries.slice(1).map(entry => entry.value)).toEqual([3, 4])
  expect([...new InspectorObjectValue(entries[0]!.value).entries()]).toEqual([
    { key: 'length', name: 'length', value: undefined, accessor: true },
  ])
  expect(read).not.toHaveBeenCalled()
})
