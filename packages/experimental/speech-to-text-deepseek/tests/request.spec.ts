/** One attempt's HTTP and envelope classification, bounds, timeouts, and caller cancellation. */
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { attemptTranscription, type AttemptRequest } from '../src/request.ts'
import { json, recognized, refused, serviceDouble, silent, type Reply } from './service-double.ts'

const body = new Uint8Array(new ArrayBuffer(4))
function request(endpoint: string, overrides: Partial<AttemptRequest> = {}): AttemptRequest {
  return { endpoint: new URL(endpoint), body, contentType: 'application/octet-stream', headers: { 'x-dsh-auth-token': 't' },
    timeoutMs: 2000, maxResponseBytes: 64 * 1024, ...overrides }
}
async function outcome(reply: Reply, overrides: Partial<AttemptRequest> = {}) {
  const { endpoint } = await serviceDouble(reply)
  return await attemptTranscription(request(endpoint, overrides), new AbortController().signal)
}
const raw = (status: number, text: string): Reply => (_request, response) => { response.writeHead(status).end(text) }

describe('attempt classification', () => {
  it('returns recognized text and treats no-speech codes as empty text', async () => {
    expect(await outcome(recognized('你好'))).toEqual({ kind: 'text', text: '你好' })
    expect(await outcome(refused(6))).toEqual({ kind: 'text', text: '' })
    expect(await outcome(refused(10))).toEqual({ kind: 'text', text: '' })
  })

  it('maps classified recognition failures', async () => {
    for (const [code, failure] of [[1, 'service-unavailable'], [2, 'rate-limited'], [3, 'service-error'], [4, 'invalid-audio'],
      [5, 'service-error'], [7, 'timeout'], [8, 'timeout'], [11, 'quota-exceeded'], [99, 'service-error']] as const) {
      expect(await outcome(refused(code))).toEqual({ kind: 'failed', code: failure, diagnostic: `biz_code 2, code ${code}` })
    }
  })

  it('distinguishes credential rejection, rate limits, and retryable service failures', async () => {
    expect(await outcome(json(401, { error: { code: 'UNAUTHENTICATED' } }))).toEqual({ kind: 'credentials-rejected', diagnostic: 'HTTP 401' })
    expect(await outcome(json(200, { code: 40003, msg: 'INVALID_TOKEN', data: null }))).toEqual({ kind: 'credentials-rejected', diagnostic: 'code 40003' })
    expect(await outcome(json(200, { code: 40002, msg: 'Missing Token', data: null }))).toMatchObject({ kind: 'credentials-rejected' })
    expect(await outcome(raw(429, ''))).toEqual({ kind: 'failed', code: 'rate-limited', diagnostic: 'HTTP 429' })
    expect(await outcome(raw(503, ''))).toEqual({ kind: 'retryable', code: 'service-error', diagnostic: 'HTTP 503' })
    expect(await outcome(json(200, { code: 0, data: { biz_code: 3, biz_data: null } }))).toEqual({ kind: 'retryable', code: 'service-error', diagnostic: 'biz_code 3' })
  })

  it('rejects unexpected statuses and malformed envelopes without echoing the body', async () => {
    const failed = (diagnostic: string) => ({ kind: 'failed', code: 'service-error', diagnostic })
    expect(await outcome(raw(404, '<html>'))).toEqual(failed('HTTP 404'))
    expect(await outcome(raw(204, ''))).toEqual(failed('HTTP 204'))
    expect(await outcome(raw(200, '<html>secret</html>'))).toEqual(failed('response is not JSON'))
    expect(await outcome(json(200, { data: {} }))).toEqual(failed('response envelope is invalid'))
    expect(await outcome(json(200, { code: 5, data: null }))).toEqual(failed('code 5'))
    expect(await outcome(json(200, { code: 0 }))).toEqual(failed('code 0'))
    expect(await outcome(json(200, { code: 0, data: { biz_code: 0, biz_data: { text: 1 } } }))).toEqual(failed('recognition result is invalid'))
    expect(await outcome(json(200, { code: 0, data: { biz_code: 2, biz_data: null } }))).toEqual(failed('biz_code 2'))
    expect(await outcome(json(200, { code: 0, data: { biz_code: 7, biz_data: null } }))).toEqual(failed('biz_code 7'))
  })

  it('bounds the response body', async () => {
    expect(await outcome(recognized('x'.repeat(200)), { maxResponseBytes: 100 }))
      .toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'response exceeds 100 bytes' })
  })

  it('turns deadlines and transport failures into retryable outcomes', async () => {
    expect(await outcome(silent, { timeoutMs: 50 })).toEqual({ kind: 'retryable', code: 'timeout', diagnostic: 'no response within 50 ms' })
    const closed = createServer()
    await new Promise<void>((resolve) => { closed.listen(0, '127.0.0.1', resolve) })
    const address = closed.address()
    await new Promise<void>((resolve) => { closed.close(() => { resolve() }) })
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const refused = await attemptTranscription(request(`http://127.0.0.1:${port}/asr`), new AbortController().signal)
    expect(refused).toMatchObject({ kind: 'retryable', code: 'service-error' })
    expect('diagnostic' in refused && refused.diagnostic).toMatch(/^request failed: TypeError: /)
  })

  it('propagates caller cancellation instead of classifying it', async () => {
    const { endpoint } = await serviceDouble(silent)
    const caller = new AbortController()
    const pending = attemptTranscription(request(endpoint), caller.signal)
    caller.abort(new Error('dictation cancelled'))
    await expect(pending).rejects.toThrow('dictation cancelled')
  })
})
