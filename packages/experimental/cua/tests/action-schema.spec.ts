/** Native action descriptions retain JSON metadata and remain usable by schema-aware consumers. */
import { expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { ActionSchemaResult } from '../src/protocol.ts'

function parameters(argument: JsonSchemaNode): ObjectJsonSchema {
  return { type: 'object', properties: { argument }, required: ['argument'], additionalProperties: false }
}

function pair(first: string, second: string): JsonSchemaNode {
  return { type: 'object', properties: { [first]: { type: 'number' }, [second]: { type: 'number' } },
    required: [first, second], additionalProperties: false }
}

const alternatives: JsonSchemaNode[] = [
  { type: 'string' }, { type: 'boolean' }, { type: 'number' },
  pair('x', 'y'), pair('width', 'height'), pair('location', 'length'),
]

it.each([
  'text', true, 1.5, { x: -1, y: 2 }, { width: 0, height: 1.5 }, { location: 0.5, length: -1 },
])('accepts exactly one macOS attribute type for %j', (argument) => {
  const raw = parameters({ oneOf: alternatives })
  const schema = ActionSchemaResult.parse(raw)
  expect(schema).toEqual(raw)
  expect(() => { assertObjectJsonSchema(schema) }).not.toThrow()
  expect(validateJsonSchemaValue(schema, { argument })).toEqual([])
  expect(alternatives.filter(branch => validateJsonSchemaValue(branch, argument).length === 0)).toHaveLength(1)
})

it.each([null, [], { x: 1 }, { x: 1, y: 2, width: 3, height: 4 }])('rejects values outside the attribute alternatives: %j', (argument) => {
  const schema = ActionSchemaResult.parse(parameters({ oneOf: alternatives }))
  expect(validateJsonSchemaValue(schema, { argument })).not.toEqual([])
})

it('preserves object and field descriptions without enforcing their numeric limits', () => {
  const raw = parameters({
    ...pair('width', 'height'), description: 'Window size in pixels.',
    properties: {
      width: { type: 'number', description: 'Finite number greater than zero.' },
      height: { type: 'number', description: 'Finite number greater than zero.' },
    },
  })
  const schema = ActionSchemaResult.parse(raw)
  expect(schema).toEqual(raw)
  expect(validateJsonSchemaValue(schema, { argument: { width: -1, height: 0 } })).toEqual([])
  expect(validateJsonSchemaValue(schema, { argument: { width: '1', height: 1 } })).not.toEqual([])
})

it.each([1.5, 'Other'])('preserves union descriptions without enforcing integer or enum prose: %j', (argument) => {
  const raw = parameters({
    description: 'The accepted value depends on the selected control.',
    oneOf: [
      { type: 'number', description: 'A nonnegative integer.' },
      { type: 'string', description: 'One of: Normal, Maximized, Minimized.' },
    ],
  })
  const schema = ActionSchemaResult.parse(raw)
  expect(schema).toEqual(raw)
  expect(validateJsonSchemaValue(schema, { argument })).toEqual([])
})

it('retains optional null arguments for parameter-free actions', () => {
  const schema = ActionSchemaResult.parse({ ...parameters({ type: 'null' }), required: [] })
  expect(validateJsonSchemaValue(schema, {})).toEqual([])
  expect(validateJsonSchemaValue(schema, { argument: null })).toEqual([])
  expect(validateJsonSchemaValue(schema, { argument: 0 })).not.toEqual([])
})

it.each([
  { anyOf: [{ type: 'string' }, { type: 'number' }] },
  { type: 'number', minimum: 0 },
])('preserves native schema keywords without enforcing a schema subset: %j', (argument) => {
  const response = { type: 'object', properties: { argument }, required: ['argument'], additionalProperties: false }
  expect(ActionSchemaResult.parse(response)).toEqual(response)
})

it.each([
  null, [], { type: undefined }, { type: 'number', default: Infinity }, { type: 'number', default: NaN },
])('rejects non-object or non-JSON argument descriptions: %j', (argument) => {
  expect(() => ActionSchemaResult.parse({ type: 'object', properties: { argument }, required: ['argument'], additionalProperties: false }))
    .toThrow()
})

it.each([
  {}, { type: 'string' },
  { ...parameters({ type: 'string' }), properties: { other: { type: 'string' } } },
  { ...parameters({ type: 'string' }), required: ['other'] },
  { ...parameters({ type: 'string' }), additionalProperties: true },
])('retains the CUA parameter envelope requirements: %j', (schema) => {
  expect(() => ActionSchemaResult.parse(schema)).toThrow()
})
