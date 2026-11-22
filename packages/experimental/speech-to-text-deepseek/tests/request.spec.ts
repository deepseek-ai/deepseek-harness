/** One request's status classification, bounds, timeouts, credential withdrawal, and caller cancellation. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { attemptTranscription, type AttemptRequest } from '../src/request.ts'
import { dropped, failed, json, raw, recognized, serviceDouble, silent, type Reply } from './service-double.ts'

const body = new Uint8Array(new ArrayBuffer(4))
function request(endpoint: string, overrides: Partial<AttemptRequest> = {}): AttemptRequest {
  return { endpoint, body, contentType: 'application/octet-stream', headers: { 'x-dsh-auth-token': 't' },
    timeoutMs: 2000, maxResponseBytes: 64 * 1024, ...overrides }
}
async function outcome(reply: Reply, overrides: Partial<AttemptRequest> = {}) {
  const { endpoint } = await serviceDouble(reply)
  return await attemptTranscription(request(endpoint, overrides), new AbortController().signal)
}

describe('attempt classification', () => {
  it('returns recognized text with the duration the service measured', async () => {
    expect(await outcome(recognized('你好', 3200))).toEqual({ kind: 'text', text: '你好', durationMs: 3200 })
    expect(await outcome(recognized(''))).toEqual({ kind: 'text', text: '', durationMs: undefined })
  })

  it('maps the documented error statuses and keeps the service message in the diagnostic', async () => {
    for (const [status, code] of [[400, 'invalid-audio'], [402, 'quota-exceeded'], [404, 'service-unavailable'], [408, 'timeout'],
      [413, 'invalid-audio'], [429, 'rate-limited'], [503, 'rate-limited'], [504, 'timeout'], [500, 'service-error'],
      [418, 'service-error']] as const) {
      expect(await outcome(failed(status, `failure ${status}`))).toEqual({ kind: 'failed', code, diagnostic: `HTTP ${status}: failure ${status}` })
    }
    expect(await outcome(failed(400, 'x'.repeat(300)))).toEqual({ kind: 'failed', code: 'invalid-audio', diagnostic: `HTTP 400: ${'x'.repeat(200)}` })
  })

  it('omits bodies that are not the service error format', async () => {
    expect(await outcome(raw(404, '<html>secret</html>'))).toEqual({ kind: 'failed', code: 'service-unavailable', diagnostic: 'HTTP 404' })
    expect(await outcome(json(500, { message: 'other' }))).toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'HTTP 500' })
    expect(await outcome(raw(204, ''))).toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'HTTP 204' })
    expect(await outcome(raw(200, '<html>secret</html>'))).toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'recognition result is invalid' })
    expect(await outcome(json(200, { text: 1 }))).toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'recognition result is invalid' })
  })

  it('classifies HTTP 401 from the status before reading a body of any size', async () => {
    expect(await outcome(raw(401, 'x'.repeat(4096)), { maxResponseBytes: 100 })).toEqual({ kind: 'credentials-rejected', diagnostic: 'HTTP 401' })
    expect(await outcome((_request, response) => { response.writeHead(401).end() })).toEqual({ kind: 'credentials-rejected', diagnostic: 'HTTP 401' })
  })

  it('bounds the response body and stops reading at the limit', async () => {
    expect(await outcome(recognized('x'.repeat(200)), { maxResponseBytes: 100 }))
      .toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'response exceeds 100 bytes' })
  })

  it('reports deadlines, dropped connections, and broken bodies without retrying', async () => {
    expect(await outcome(silent, { timeoutMs: 50 })).toEqual({ kind: 'failed', code: 'timeout', diagnostic: 'no response within 50 ms' })
    const { endpoint, requests } = await serviceDouble(dropped)
    const closed = await attemptTranscription(request(endpoint), new AbortController().signal)
    expect(closed).toMatchObject({ kind: 'failed', code: 'service-unavailable' })
    expect('diagnostic' in closed && closed.diagnostic).toMatch(/^request failed: fetch failed \(/)
    expect(requests).toHaveLength(1)
    const broken = await outcome((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' }).write('{"text"')
      setImmediate(() => { response.socket?.destroy() })
    })
    expect(broken).toMatchObject({ kind: 'failed', code: 'service-unavailable' })
  })

  it('reports a transport failure that carries no cause by its message', async () => {
    const { endpoint } = await serviceDouble(silent)
    const fetched = vi.spyOn(globalThis, 'fetch')
    onTestFinished(() => { fetched.mockRestore() })
    fetched.mockRejectedValueOnce(new Error('socket hang up'))
    expect(await attemptTranscription(request(endpoint), new AbortController().signal))
      .toEqual({ kind: 'failed', code: 'service-unavailable', diagnostic: 'request failed: socket hang up' })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers fetch rejecting with a non-Error reason
    fetched.mockImplementationOnce(() => Promise.reject('offline'))
    expect(await attemptTranscription(request(endpoint), new AbortController().signal))
      .toEqual({ kind: 'failed', code: 'service-unavailable', diagnostic: 'request failed: offline' })
  })

  it('ends with the withdrawn credential when its owner revokes it mid-request', async () => {
    const { endpoint } = await serviceDouble(silent)
    const revoked = new AbortController()
    const pending = attemptTranscription(request(endpoint), new AbortController().signal, revoked.signal)
    revoked.abort()
    expect(await pending).toEqual({ kind: 'revoked' })
  })

  it('propagates caller cancellation instead of classifying it', async () => {
    const { endpoint } = await serviceDouble(silent)
    const caller = new AbortController()
    const pending = attemptTranscription(request(endpoint), caller.signal, new AbortController().signal)
    caller.abort(new Error('dictation cancelled'))
    await expect(pending).rejects.toThrow('dictation cancelled')
  })
})
