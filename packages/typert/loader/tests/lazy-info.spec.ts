/** Loading a generated contribution must not request consumer-owned input views or projections. */

import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { validateTypertManifest } from '../src/index.ts'

it('validates invocation facts without selecting input policy or materializing schemas', () => {
  const create = vi.fn(() => z.string())
  const codec = { mode: 'strict' as const, typeSymbol: 'pkg#Text', create, jsonSchema: { type: 'string' } }
  const info = createTypertRemoteInfo({ package: 'pkg', methods: {
    'goals/create': {
      service: 'goals', invocation: { kind: 'direct' },
      parameters: [{ name: 'request', source: 'json', codec, strictCodec: codec }],
      result: { ...codec, description: 'Created goal.' },
    },
  } }, z)
  const method = info.methods['goals/create']!
  const normal = method.input()
  const strict = method.input({ strict: true })
  const select = vi.spyOn(method, 'input')
  const inputSchema = vi.spyOn(normal, 'jsonSchema', 'get')
  const strictSchema = vi.spyOn(strict, 'jsonSchema', 'get')
  const inputError = vi.spyOn(strict, 'jsonSchemaError', 'get')
  const outputSchema = vi.spyOn(method.result, 'jsonSchema', 'get')
  const manifest = { package: 'pkg', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: info.descriptors }
  expect(validateTypertManifest('pkg', manifest)).toBe(manifest)
  for (const operation of [create, select, inputSchema, strictSchema, inputError, outputSchema]) {
    expect(operation).not.toHaveBeenCalled()
  }
  expect(strict.jsonSchema).toMatchObject({ properties: { request: { type: 'string' } } })
  expect(method.result.jsonSchema).toEqual({ type: 'string', description: 'Created goal.' })
  expect(strict.create().parse({ request: 'ship' })).toEqual({ request: 'ship' })
  expect(create).toHaveBeenCalledTimes(1)
})
