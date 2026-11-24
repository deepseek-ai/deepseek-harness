/** Request fields and response-head classification of one speech synthesis call. */
import { expect, it } from 'vitest'
import { describeTransport, openSynthesis, type SynthesisCall } from '../src/request.ts'
import { audio, failed, json, raw, serviceDouble } from './service-double.ts'

const never = new AbortController().signal
const call = (endpoint: string): SynthesisCall => ({ endpoint, headers: { authorization: 'Bearer sk-key' }, text: '你好', voice: 'tide' })

it('requests raw PCM for plain text and returns the audio body of a success', async () => {
  const pcm = new Uint8Array([1, 2, 3, 4])
  const { endpoint, requests } = await serviceDouble(audio(pcm))
  const opened = await openSynthesis(call(endpoint), never)
  if (opened.kind !== 'audio') throw new Error(`expected audio, got ${opened.kind}`)
  const chunks: Uint8Array[] = []
  for await (const chunk of opened.body) chunks.push(chunk)
  expect(new Uint8Array(Buffer.concat(chunks))).toEqual(pcm)
  expect(requests[0]).toMatchObject({
    path: '/v1/tools/tts',
    headers: { 'authorization': 'Bearer sk-key', 'content-type': 'application/json' },
    body: { text: '你好', voice_id: 'tide', format: 'pcm', filter_markdown: false },
  })
})

it('classifies a rejected credential from the status alone', async () => {
  const { endpoint } = await serviceDouble(failed(401, 'Authentication Fails (invalid dsh token)'))
  expect(await openSynthesis(call(endpoint), never)).toEqual({ kind: 'credentials-rejected', diagnostic: 'HTTP 401' })
})

it('maps each documented error status to its failure class and keeps the service message', async () => {
  const classes = [[400, 'text-rejected'], [402, 'quota-exceeded'], [404, 'service-unavailable'], [408, 'timeout'], [413, 'text-rejected'],
    [429, 'rate-limited'], [503, 'rate-limited'], [504, 'timeout'], [500, 'service-error']] as const
  for (const [status, code] of classes) {
    const { endpoint } = await serviceDouble(failed(status, 'Content Exists Risk'))
    expect(await openSynthesis(call(endpoint), never)).toEqual({ kind: 'failed', code, diagnostic: `HTTP ${status}: Content Exists Risk` })
  }
})

it('reports a JSON body under status 200 as a failure and bounds what it keeps of an error body', async () => {
  const described = await serviceDouble(failed(200, 'x'.repeat(300)))
  expect(await openSynthesis(call(described.endpoint), never))
    .toEqual({ kind: 'failed', code: 'service-error', diagnostic: `HTTP 200: ${'x'.repeat(200)}` })
  const page = await serviceDouble(raw(502, '<html>bad gateway</html>'))
  expect(await openSynthesis(call(page.endpoint), never)).toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'HTTP 502' })
  const shapeless = await serviceDouble(json(503, { detail: 'busy' }))
  expect(await openSynthesis(call(shapeless.endpoint), never)).toEqual({ kind: 'failed', code: 'rate-limited', diagnostic: 'HTTP 503' })
  const bodiless = await serviceDouble((_request, response) => { response.writeHead(204).end() })
  expect(await openSynthesis(call(bodiless.endpoint), never)).toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'HTTP 204' })
  const huge = await serviceDouble(raw(500, 'y'.repeat(17 * 1024)))
  expect(await openSynthesis(call(huge.endpoint), never)).toEqual({ kind: 'failed', code: 'service-error', diagnostic: 'HTTP 500' })
})

it('rejects with the transport failure when the service cannot be reached', async () => {
  const { endpoint } = await serviceDouble((_request, response) => { response.socket?.destroy() })
  const failure: unknown = await openSynthesis(call(endpoint), never).catch((error: unknown) => error)
  expect(describeTransport(failure)).toMatch(/^fetch failed \(.+\)$/)
  expect(describeTransport(new Error('plain'))).toBe('plain')
  expect(describeTransport('text')).toBe('text')
})
