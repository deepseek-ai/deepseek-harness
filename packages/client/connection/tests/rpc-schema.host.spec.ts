import { describe, expect, it } from 'vitest'
import { transportError } from '../src/rpc.ts'
import {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from '../src/rpc-schema.ts'
import { z } from 'zod'

describe('Connection RPC schema', () => {
  it('preserves string correlation ids and rejects non-strings', () => {
    expect(rpcIdSchema.parse('abc')).toBe('abc')
    expect(rpcIdSchema.parse('')).toBe('')
    expect(() => rpcIdSchema.parse(42)).toThrow()
  })

  it('folds transport exceptions into an internal failure', () => {
    expect(transportError(new Error('wire down'))).toEqual({
      ok: false,
      error: { code: 'gateway/internal', message: 'wire down', details: {} },
    })
    expect(transportError('raw')).toMatchObject({
      ok: false,
      error: { code: 'gateway/internal', message: 'raw' },
    })
  })

  it('validates generic failures and both result branches', () => {
    expect(rpcErrorSchema.parse({ code: 'domain-failure', message: 'failed', details: { id: 'x' } }))
      .toEqual({ code: 'domain-failure', message: 'failed', details: { id: 'x' } })
    expect(() => rpcErrorSchema.parse({ code: 1, message: 'failed', details: {} })).toThrow()
    expect(() => rpcErrorSchema.parse({ code: 'failed', message: 'failed', details: [] })).toThrow()

    const schema = rpcResultSchema(z.object({ n: z.number() }))
    expect(schema.parse({ ok: true, value: { n: 1 } })).toEqual({ ok: true, value: { n: 1 } })
    expect(schema.parse({ ok: false, error: { code: 'failed', message: 'x', details: {} } }))
      .toMatchObject({ ok: false })
    expect(() => schema.parse({ ok: true, error: {} })).toThrow()
  })

  it('validates both envelope directions and valueless success', () => {
    const request = { type: 'client-request', rpcId: 'r1', method: 'settings/describe', payload: { args: {} } }
    const response = { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 1 } }
    expect(clientRequestSchema.parse(request).method).toBe('settings/describe')
    expect(serverResponseSchema.parse(response).rpcId).toBe('r1')
    for (const message of [request, response]) expect(rpcMessageSchema.parse(message)).toBeTruthy()
    expect(() => rpcMessageSchema.parse({ type: 'other', rpcId: 'x' })).toThrow()
    expect(() => clientRequestSchema.parse({ type: 'client-request', rpcId: 'r1' })).toThrow()
    expect(() => serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1' })).toThrow()
    expect(() => serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1', result: {} })).toThrow()
    expect(serverResponseSchema.parse({
      type: 'server-response', rpcId: 'r1', result: { ok: true },
    }).rpcId).toBe('r1')
  })
})
