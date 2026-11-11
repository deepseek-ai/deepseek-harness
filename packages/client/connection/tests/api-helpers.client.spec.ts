/**
 * Contract-layer helpers: transport-error folding and response unwrapping.
 * (The assistant block classifier half of the legacy spec lives in
 * runtime/tests — the classifier moved there.)
 */

import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { type RpcId, resultOf, transportError } from '../src/client/api.ts'

describe('transportError', () => {
  it('folds an Error to internal keeping the message, and stringifies non-Errors', () => {
    expect(transportError(new Error('线断了'))).toEqual({ ok: false, error: { code: 'gateway/internal', message: '线断了', details: {} } })
    expect(transportError('raw string')).toMatchObject({ ok: false, error: { message: 'raw string' } })
  })
})

describe('resultOf', () => {
  it('unwraps the result slot', () => {
    expect(resultOf({ rpcId: brandString<RpcId>('r'), result: { ok: true, value: 7 } })).toEqual({ ok: true, value: 7 })
  })
})
