/** Raw details retain shared values while terminating cyclic live object references. */

import { expect, it } from 'vitest'
import { inspectorJson } from '../src/client/views/raw-json.ts'
import { chatNodeWithLocation } from './chat-node-fixture.client.ts'

it('serializes a real Chat Node after its Location source has been materialized', () => {
  const node = chatNodeWithLocation()
  const detail = inspectorJson(node)
  expect(detail.failed).toBe(false)
  expect(detail.text).toContain('"text": "node content"')
  expect(detail.text).toContain('"store": "[Circular]"')
  expect(detail.text).toContain('"key": "assistant:long-node-identity"')
  expect(detail.text).toContain('"kind": "assistant"')
})

it('marks self-referencing objects, maps, and sets without modifying them', () => {
  const object: Record<string, unknown> = {}
  object.self = object
  const map = new Map<string, unknown>()
  map.set('self', map)
  const set = new Set<unknown>()
  set.add(set)
  expect(inspectorJson({ object, map, set })).toEqual({ failed: false, text: JSON.stringify({
    object: { self: '[Circular]' }, map: { self: '[Circular]' }, set: ['[Circular]'],
  }, null, 2) })
  expect(object.self).toBe(object)
  expect(map.get('self')).toBe(map)
  expect(set.has(set)).toBe(true)
})

it('expands shared non-circular values separately in each branch', () => {
  const shared = { value: 1 }
  const map = new Map([['value', shared]])
  expect(inspectorJson({ left: shared, right: shared, first: map, second: map })).toEqual({
    failed: false, text: JSON.stringify({ left: shared, right: shared,
      first: { value: shared }, second: { value: shared } }, null, 2),
  })
})

it('keeps bigint values readable and contains serialization errors', () => {
  expect(inspectorJson({ count: 123n })).toEqual({ text: '{\n  "count": "123n"\n}', failed: false })
  expect(inspectorJson(undefined)).toEqual({ text: '', failed: false })
  expect(inspectorJson({ toJSON() { throw new Error('unavailable value') } }))
    .toEqual({ text: 'unavailable value', failed: true })
  expect(inspectorJson({ toJSON() { throw 'unavailable text' } }))
    .toEqual({ text: 'unavailable text', failed: true })
})
