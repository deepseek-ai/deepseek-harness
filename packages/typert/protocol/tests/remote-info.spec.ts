/** Factory regressions use static definitions without loading a Controller or a Remote runtime. */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTypertRemoteInfo, isTypertRemoteMethod } from '../src/remote-info.ts'
import type { TypertClientRemote, TypertRemoteCodecSpec, TypertRemoteMethodSpec } from '../src/types.ts'

const text: TypertRemoteCodecSpec = {
  mode: 'strict', typeSymbol: '@fixture/types#Text', create: () => z.string(), jsonSchema: { type: 'string' },
}

function definition(overrides: Partial<TypertRemoteMethodSpec> = {}): TypertRemoteMethodSpec {
  return {
    service: 'goals', invocation: { kind: 'direct' }, description: 'Create a goal.',
    parameters: [{ name: 'request', source: 'json', description: 'Goal name.', codec: text, strictCodec: text }],
    result: text,
    ...overrides,
  }
}

describe('lazy Remote info', () => {
  it('returns a class instance and defers its index, schemas, and projections independently', () => {
    let inventoryReads = 0
    let inputProjectionReads = 0
    let outputProjectionReads = 0
    const create = vi.fn(() => z.string())
    const input = { ...text, create, get jsonSchema() { inputProjectionReads++; return { type: 'string' } } }
    const output = { ...text, description: 'Created name.', get jsonSchema() { outputProjectionReads++; return { type: 'string' } } }
    const spec = {
      package: '@fixture/goals',
      get methods() { inventoryReads++; return { 'goals/create': definition({ parameters: [{ name: 'request', source: 'json', codec: input, strictCodec: input }], result: output }) } },
    }
    const runtime = { ...z }
    const strictObject = vi.spyOn(runtime, 'strictObject')
    const info = createTypertRemoteInfo(spec, runtime)
    expect(Object.getPrototypeOf(info)).not.toBe(Object.prototype)
    expect(info.package).toBe('@fixture/goals')
    expect(inventoryReads).toBe(0)
    expect(create).not.toHaveBeenCalled()

    const method = info.methods['goals/create']!
    expect(inventoryReads).toBe(1)
    expect(info.descriptors[0]).toBe(method)
    expect(info.methods).toBe(info.methods)
    expect(info.descriptors).toBe(info.descriptors)
    expect(inventoryReads).toBe(1)
    expect(inputProjectionReads + outputProjectionReads).toBe(0)
    expect(create).not.toHaveBeenCalled()
    expect(strictObject).not.toHaveBeenCalled()
    expect(method).not.toHaveProperty('metadata')
    expect(method).not.toHaveProperty('output')
    expect(method.mode).toBeUndefined()
    expect(isTypertRemoteMethod(method)).toBe(true)

    const inputView = method.input()
    expect(strictObject).not.toHaveBeenCalled()
    const parser = inputView.create()
    expect(method.input().create()).toBe(parser)
    expect(strictObject).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(parser.parse({ request: 'ship' })).toEqual({ request: 'ship' })
    expect(inputProjectionReads + outputProjectionReads).toBe(0)
    const projection = method.input().jsonSchema
    expect(projection).toEqual({ type: 'object', properties: { request: { type: 'string' } }, required: ['request'], additionalProperties: false })
    expect(method.input().jsonSchema).toBe(projection)
    const reads = inputProjectionReads
    expect(method.input().jsonSchemaError).toBeUndefined()
    expect(inputProjectionReads).toBe(reads)
    expect(outputProjectionReads).toBe(0)
    expect(method.result.create).toBe(output.create)
    const resultProjection = method.result.jsonSchema
    expect(resultProjection).toEqual({ type: 'string', description: 'Created name.' })
    expect(method.result.jsonSchema).toBe(resultProjection)
    expect(outputProjectionReads).toBe(1)
  })

  it('selects and caches independent parser/projection views without changing dispatch codecs', () => {
    const create = vi.fn(() => z.object({ title: z.string() }))
    const createStrict = vi.fn(() => z.strictObject({ title: z.string() }))
    const codec = { ...text, create, jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: true } }
    const strictCodec = { ...codec, create: createStrict, jsonSchema: { ...codec.jsonSchema, additionalProperties: false } }
    const info = createTypertRemoteInfo({ package: '@fixture/goals', methods: {
      'goals/create': definition({ parameters: [{ name: 'request', source: 'json', codec, strictCodec }] }),
    } }, z)
    const method = info.methods['goals/create']!
    const normal = method.input()
    const strict = method.input({ strict: true })
    expect(method.input({ strict: false })).toBe(normal)
    expect(method.input({})).toBe(normal)
    expect(method.input({ strict: true })).toBe(strict)
    expect(strict).not.toBe(normal)
    expect(create).not.toHaveBeenCalled()
    expect(createStrict).not.toHaveBeenCalled()
    expect(normal.jsonSchema).toMatchObject({ properties: { request: { additionalProperties: true } } })
    expect(strict.jsonSchema).toMatchObject({ properties: { request: { additionalProperties: false } } })
    expect(create).not.toHaveBeenCalled()
    expect(createStrict).not.toHaveBeenCalled()
    const extra = { request: { title: 'ship', ignored: true } }
    expect(normal.create().parse(extra)).toEqual({ request: { title: 'ship' } })
    expect(create).toHaveBeenCalledTimes(1)
    expect(createStrict).not.toHaveBeenCalled()
    expect(() => strict.create().parse(extra)).toThrow()
    expect(strict.create().parse({ request: { title: 'ship' } })).toEqual({ request: { title: 'ship' } })
    expect(createStrict).toHaveBeenCalledTimes(1)
    expect(method.parameters[0]?.codec).toBe(codec)
    expect(normal.create().parse(extra)).toEqual({ request: { title: 'ship' } })
  })

  it('preserves named omissions, lookup aliases, strict outer fields, and positional holes', () => {
    const info = createTypertRemoteInfo({ package: '@fixture/goals', methods: {
      'goals/create': definition({
        parameters: [
          { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', acceptsUndefined: true, description: 'Owning Agent.', codec: text, strictCodec: text },
          { name: 'label', source: 'json', acceptsUndefined: true, codec: text, strictCodec: text },
        ],
        cancellation: { parameter: 'signal' },
        scope: { context: 'agent', wire: 'agentId' },
      }),
    } }, z)
    const method = info.methods['goals/create']!
    const parser = method.input().create()
    expect(parser.parse({ agentId: 'agent' })).toEqual({ agentId: 'agent' })
    expect(parser.parse({ agentId: 'agent', label: undefined })).toEqual({ agentId: 'agent', label: undefined })
    for (const invalid of [null, [], {}, { agentId: undefined }, { agentId: 'agent', label: null }, { agentId: 'agent', extra: true }]) {
      expect(() => parser.parse(invalid)).toThrow()
    }
    expect(method.input().jsonSchema?.required).toEqual(['agentId'])
    expect(method.input().jsonSchema).toMatchObject({ properties: { agentId: { description: 'Owning Agent.' } } })
    const signal = new AbortController().signal
    const promise = Promise.resolve({ ok: true as const, value: 'created' })
    const create = vi.fn(function (this: object, ...args: unknown[]) {
      expect(this).toBe(namespace)
      expect(args).toEqual(['agent', undefined, signal])
      return promise
    })
    const namespace = { create }
    const remote: object = { goals: namespace }
    expect(method.invoke(remote as TypertClientRemote, { agentId: 'agent' }, signal)).toBe(promise)
    expect(method.scope).toEqual({ context: 'agent', wire: 'agentId' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('requires declared fields even when their parser accepts undefined and permits empty methods', () => {
    const unknown = { ...text, create: () => z.unknown(), jsonSchema: {} }
    const info = createTypertRemoteInfo({ package: '@fixture/goals', methods: {
      'goals/required': definition({ parameters: [{ name: 'value', source: 'json', codec: unknown, strictCodec: unknown }] }),
      'goals/empty': definition({ parameters: [] }),
    } }, z)
    expect(() => info.methods['goals/required']!.input().create().parse({})).toThrow()
    const empty = info.methods['goals/empty']!
    expect(empty.input().create().parse({})).toEqual({})
    expect(() => empty.input().create().parse({ extra: true })).toThrow()
    expect(empty.input().jsonSchema?.required).toEqual([])
    const call = vi.fn(() => Promise.resolve({ ok: true as const, value: 'empty' }))
    const remote: object = { goals: { empty: call } }
    void empty.invoke(remote as TypertClientRemote, {}, new AbortController().signal)
    expect(call).toHaveBeenCalledWith()
  })

  it('does not treat source or plain strict descriptors as generated named methods', () => {
    const base = {
      id: 'pkg#goals/read', namespace: 'goals', method: 'read', service: 'goals',
      invocation: { kind: 'direct' as const }, parameters: [], result: { mode: 'src-json' as const },
    }
    expect(isTypertRemoteMethod(base)).toBe(false)
    const strict = { ...base, result: text }
    expect(isTypertRemoteMethod(strict)).toBe(false)
    const legacy = { ...strict, input: { create: () => z.strictObject({}) } }
    expect(isTypertRemoteMethod(legacy)).toBe(false)
    const inputOnly = { ...strict, input: () => ({ create: () => z.strictObject({}) }) }
    expect(isTypertRemoteMethod(inputOnly)).toBe(false)
    const notCallable = { ...inputOnly, invoke: undefined }
    expect(isTypertRemoteMethod(notCallable)).toBe(false)
  })

  it('keeps Context-only descriptors without inventing a named direct caller', () => {
    const info = createTypertRemoteInfo({ package: '@fixture/goals', methods: {
      'goals/rename': definition({ invocation: { kind: 'context', context: 'agent', wire: 'agentId', codec: text }, implementation: 'renameCurrent' }),
    } }, z)
    expect(Object.keys(info.methods)).toEqual([])
    expect(info.descriptors[0]).toMatchObject({ id: '@fixture/goals#goals/rename', namespace: 'goals', method: 'rename', implementation: 'renameCurrent' })
    expect(info.descriptors[0]).not.toHaveProperty('input')
    expect(isTypertRemoteMethod(info.descriptors[0]!)).toBe(false)
  })

  it('returns the exact stream handle and looks up the current mounted method on each call', () => {
    const uplink = { codec: text }
    const info = createTypertRemoteInfo({ package: '@fixture/goals', methods: {
      'goals/watch': definition({ mode: 'stream', parameters: [], uplink }),
    } }, z)
    const handle = { async *[Symbol.asyncIterator]() { yield 'frame' }, send: vi.fn(), end: vi.fn(), dispose: vi.fn() }
    const namespace = { watch: () => handle }
    const remote: object = { goals: namespace }
    const method = info.methods['goals/watch']!
    expect(method.invoke(remote as TypertClientRemote, {})).toBe(handle)
    expect(method.uplink).toBe(uplink)
    namespace.watch = () => { throw new Error('method withdrawn') }
    expect(() => method.invoke(remote as TypertClientRemote, {})).toThrow('method withdrawn')
  })

  it('retains codecs and documentation when projection is unavailable, without masking parser failures', () => {
    const create = vi.fn(() => { throw new Error('invalid schema factory') })
    const unsupported = { ...text, create, jsonSchema: undefined, jsonSchemaError: 'Unsupported tool type.' }
    const decode = vi.fn((value: unknown) => value)
    const encode = vi.fn((value: unknown) => value)
    const info = createTypertRemoteInfo({ package: '@fixture/goals', methods: {
      'goals/create': definition({
        parameters: [{ name: 'request', source: 'json', description: 'Still documented.', codec: unsupported, strictCodec: unsupported }],
        result: { ...unsupported, description: 'Still a result.', decode, encode },
      }),
    } }, z)
    const method = info.methods['goals/create']!
    expect(method.input().jsonSchema).toBeUndefined()
    expect(method.input().jsonSchemaError).toBe('Unsupported tool type.')
    expect(method.result.jsonSchema).toBeUndefined()
    expect(method.result.jsonSchemaError).toBe('Unsupported tool type.')
    expect(method.result.description).toBe('Still a result.')
    expect(method.parameters[0]?.description).toBe('Still documented.')
    expect(method.result.decode).toBe(decode)
    expect(method.result.encode).toBe(encode)
    expect(create).not.toHaveBeenCalled()
    expect(() => method.input().create()).toThrow('invalid schema factory')
    expect(() => method.input().create()).toThrow('invalid schema factory')
    const unprojected = createTypertRemoteInfo({ package: '@fixture/goals', methods: {
      'goals/create': definition({ parameters: [{ name: 'request', source: 'json', codec: { ...text, jsonSchema: undefined }, strictCodec: text }] }),
    } }, z).methods['goals/create']!
    expect(unprojected.input().jsonSchemaError).toContain('request')
    expect(unprojected.input().create().parse({ request: 'valid' })).toEqual({ request: 'valid' })
  })
})
