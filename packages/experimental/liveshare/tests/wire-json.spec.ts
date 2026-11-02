/** The owner's JSON wire helpers: the body read answers a parsed value or nothing at all. */

import { describe, expect, it } from 'vitest'
import { isRecord, json, readJsonBody } from '../src/host/wire-json.ts'

const request = (body: string): Request => new Request('http://owner.invalid/api', { method: 'POST', body })

describe('owner wire JSON', () => {
  it('answers a payload as JSON with its own status', async () => {
    const response = json({ ok: true }, 201)

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.json()).toEqual({ ok: true })
  })

  it('reads a request body that is JSON, and answers nothing for one that is not', async () => {
    expect(await readJsonBody(request('{"shareId":"share"}'))).toEqual({ shareId: 'share' })
    // A route reads a malformed or absent body as no input, never as a rejection the page cannot see.
    expect(await readJsonBody(request('{"shareId":'))).toBeUndefined()
    expect(await readJsonBody(request(''))).toBeUndefined()
  })

  it('reads a wire payload as a record only when it is a non-array object', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ op: 'asset' })).toBe(true)
    for (const refused of [null, [], ['asset'], 'asset', 0, undefined]) {
      expect(isRecord(refused), String(refused)).toBe(false)
    }
  })
})
