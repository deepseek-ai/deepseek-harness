/** Native artifact generation rejects unsupported declarations instead of emitting permissive admission data. */
import type { JSONSchema } from 'zod/v4/core'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeProtocol } from '../src/native-schema.ts'
import { NativeOnlyOperations, Request } from '../src/protocol.ts'

const replacements = vi.hoisted(() => ({ values: new Map<number, JSONSchema.JSONSchema>(), calls: 0 }))
vi.mock('zod', async (original) => {
  const module = await original<typeof import('zod')>()
  return { ...module, z: { ...module.z, toJSONSchema: (...args: Parameters<typeof module.z.toJSONSchema>) =>
    replacements.values.get(replacements.calls++) ?? module.z.toJSONSchema(...args) } }
})
afterEach(() => { replacements.calls = 0; replacements.values.clear() })

it.each([
  [{ properties: { method: false } }, 'object schema'],
  [{ properties: { method: { const: 1 } } }, 'string literal'],
  [{ properties: { method: { const: 'getState' }, params: { type: 'string' } } }, 'object parameters'],
] satisfies Array<[JSONSchema.JSONSchema, string]>)('rejects an unsupported native declaration %j', (schema, message) => {
  replacements.values.set(0, schema)
  expect(() => nativeProtocol()).toThrow(message)
})

it('retains optional resource fields and tuple-valued parameters without inventing required fields', () => {
  replacements.values.set(Request.options.findIndex(schema => schema.shape.method.value === 'getState'), { properties: { method: { const: 'getState' }, params: { type: 'object', properties: {
    tuple: { type: 'array', items: [{ type: 'string' }] }, choice: { enum: ['one', 2] },
  } } } })
  replacements.values.set(Request.options.length + NativeOnlyOperations.length,
    { type: 'object', properties: { optionalLimit: { type: 'number' } } })
  const generated = nativeProtocol()
  expect(generated.fields.get('getState')).toContain('tuple')
  expect(generated.enums.get('getState')?.get('choice')).toEqual(new Set(['one']))
})

it('admits only locator fields for default invocation', () => {
  expect(nativeProtocol().fields.get('invoke')).toEqual(new Set(['appHandle', 'snapshotId', 'elementId']))
})

it('accepts a parameter-free object schema without a properties dictionary', () => {
  replacements.values.set(0, { properties: { method: { const: 'getCapabilities' }, params: { type: 'object' } } })
  expect(nativeProtocol().fields.get('getCapabilities')).toEqual(new Set())
})
