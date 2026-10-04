/** Type-specific row previews preserve the original payload data. */

import { expect, it } from 'vitest'
import { inspectorPreview } from '../src/client/views/format.ts'

it('shows only tool-call argument deltas without mutating the raw chunk', () => {
  const chunk = Object.freeze({ type: 'tool-call-delta', index: 3, id: 'call-1', name: 'bash', argumentsDelta: '{"command":' })
  expect(inspectorPreview(chunk)).toBe('{"command":')
  expect(chunk).toEqual({ type: 'tool-call-delta', index: 3, id: 'call-1', name: 'bash', argumentsDelta: '{"command":' })
})

it('hides the reasoning index without changing other delta types', () => {
  expect(inspectorPreview({ type: 'reasoning-delta', index: 7, text: 'thinking' })).toBe('thinking')
  expect(inspectorPreview({ type: 'text-delta', index: 7, text: 'answer' })).toBe('index: 7 · text: answer')
})

it('applies delta field selection to nested data while hiding generic type and sequence fields', () => {
  expect(inspectorPreview({ type: 'event', seq: 1, sequence: 2,
    data: { type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '}' },
  })).toBe('}')
})

it.each([
  [{ role: 'assistant' }, 'assistant'],
  [{ count: 0 }, '0'],
  [{ enabled: false }, 'false'],
  [{ value: null }, 'null'],
  [{ text: '' }, ''],
])('omits the field name from a single-field object %j', (value, expected) => {
  expect(inspectorPreview(value)).toBe(expected)
})

it('keeps field names when more than one field remains', () => {
  expect(inspectorPreview({ type: 'message', role: 'assistant', content: 'answer' }))
    .toBe('role: assistant · content: answer')
})

it('hides top-level time without removing nested time values', () => {
  expect(inspectorPreview({ time: 123, text: 'message' })).toBe('message')
  expect(inspectorPreview({ Time: 123, role: 'assistant' })).toBe('assistant')
  expect(inspectorPreview({ time: 123, data: { time: 456, text: 'nested' } }))
    .toBe('time: 456 · text: nested')
})

it('omits Chat identity columns from previews without hiding nested business keys', () => {
  const node = { key: 'assistant:1', kind: 'assistant', data: { key: 'payload-key', kind: 'payload-kind' } }
  expect(inspectorPreview(node, ['key', 'kind'])).toBe('key: payload-key · kind: payload-kind')
  expect(inspectorPreview({ key: 'log-key', kind: 'log-kind' })).toBe('key: log-key · kind: log-kind')
  expect(node.key).toBe('assistant:1')
  expect(node.kind).toBe('assistant')
})

it('bounds nested arrays by their length instead of enumerating their elements', () => {
  expect(inspectorPreview({ data: { values: [1, 2, 3] } })).toBe('[3]')
})
