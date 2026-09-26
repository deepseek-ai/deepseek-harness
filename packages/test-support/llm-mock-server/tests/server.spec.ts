import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { MockLlmBehavior, MockLlmServer, MockLlmServerEvent } from '../src/index.ts'
import { startMockLlmServer } from '../src/index.ts'

const running: MockLlmServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

async function start(
  sequence: readonly MockLlmBehavior[],
  options: Omit<Parameters<typeof startMockLlmServer>[0], 'sequence'> = {},
): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence, ...options })
  running.push(server)
  return server
}

function messages(
  server: MockLlmServer,
  options: { path?: string; key?: string; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${server.baseURL}${options.path ?? '/v1/messages'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...options.key === undefined ? {} : { 'x-api-key': options.key },
    },
    body: options.body ?? JSON.stringify({ model: 'mock', messages: [], stream: true }),
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
}

function rawMessages(server: MockLlmServer, chunks: readonly Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${server.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      response.once('error', reject)
      response.once('end', resolve)
      response.resume()
    })
    outgoing.once('error', reject)
    for (const chunk of chunks) outgoing.write(chunk)
    outgoing.end()
  })
}

describe('mock LLM server wire behaviors', () => {
  it('streams a complete text response and captures the request', async () => {
    const events: MockLlmServerEvent[] = []
    const server = await start(['success'], {
      apiKey: 'mock-key',
      successText: 'recovered',
      chunkSize: 3,
      onEvent: (event) => { events.push(event) },
    })

    const response = await messages(server, { key: 'mock-key' })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(body).toContain('"text":"rec"')
    expect(body).toContain('"text":"ove"')
    expect(body).toContain('"text":"red"')
    expect(body).toContain('"stop_reason":"end_turn"')
    expect(body).toContain('"type":"message_stop"')
    expect(server.requests).toEqual([expect.objectContaining({
      attempt: 1,
      behavior: 'success',
      path: '/v1/messages',
      body: { model: 'mock', messages: [], stream: true },
      chunksSent: 8,
      outcome: 'completed',
    })])
    expect(events).toEqual([
      {
        type: 'request',
        attempt: 1,
        scriptBehavior: 'success',
        behavior: 'success',
        path: '/v1/messages',
      },
      {
        type: 'result',
        attempt: 1,
        scriptBehavior: 'success',
        behavior: 'success',
        outcome: 'completed',
        chunksSent: 8,
      },
    ])
  })

  it('supports gateway prefixes and intentionally ignores telemetry observer failures', async () => {
    const server = await start(['empty'], {
      onEvent() {
        throw new Error('observer failed')
      },
    })
    const response = await messages(server, { path: '/anthropic/v1/messages' })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"message_stop"')
    expect(server.requests[0]).toMatchObject({ path: '/anthropic/v1/messages', outcome: 'completed' })
  })

  it.each([
    ['empty_body', 0, ''] as const,
    ['stream_eof', 1, '"role":"assistant"'] as const,
    ['partial_eof', 3, 'discarded partial response'] as const,
    ['malformed_json', 2, 'data: {not-json'] as const,
    ['malformed_event', 2, '"content_block":null'] as const,
  ])('serves %s without inventing a terminal completion', async (behavior, chunks, marker) => {
    const server = await start([behavior], { chunkSize: 100 })
    const response = await messages(server)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain(marker)
    if (behavior !== 'malformed_json' && behavior !== 'malformed_event') {
      expect(body).not.toContain('message_stop')
    }
    expect(server.requests[0]).toMatchObject({ behavior, chunksSent: chunks, outcome: 'completed' })
  })

  it.each([
    ['connection_reset', false] as const,
    ['stream_disconnect', true] as const,
    ['partial_disconnect', true] as const,
  ])('forces the %s transport boundary', async (behavior, receivesHeaders) => {
    const server = await start([behavior], { disconnectDelayMs: 20, partialText: 'half' })

    let headersReceived = false
    await expect((async () => {
      const response = await messages(server)
      headersReceived = true
      await response.text()
    })()).rejects.toThrow()

    expect(headersReceived).toBe(receivesHeaders)
    expect(server.requests[0]).toMatchObject({
      behavior,
      chunksSent: behavior === 'partial_disconnect' ? 3 : 0,
      outcome: 'reset',
    })
  })

  it('holds a stalled stream until the client aborts and server close remains idempotent', async () => {
    const server = await start(['stall'])
    const controller = new AbortController()
    const response = await messages(server, { signal: controller.signal })

    expect(response.status).toBe(200)
    expect(server.requests[0]).toMatchObject({ behavior: 'stall', outcome: 'stalled' })
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    await server.close()
    await server.close()
  })

  it.each([
    ['slow_success', 100] as const,
    ['stream_disconnect', 100] as const,
    ['partial_disconnect', 100] as const,
  ])('records a client that closes during %s', async (behavior, delayMs) => {
    const events: MockLlmServerEvent[] = []
    const result = Promise.withResolvers<Extract<MockLlmServerEvent, { type: 'result' }>>()
    const server = await start([behavior], {
      chunkDelayMs: delayMs,
      disconnectDelayMs: delayMs,
      chunkSize: 1,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'result') result.resolve(event)
      },
    })
    const controller = new AbortController()
    const response = await messages(server, { signal: controller.signal })
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    await result.promise

    expect(server.requests[0]).toMatchObject({ behavior, outcome: 'client_closed' })
    expect(events.filter(event => event.type === 'result')).toEqual([
      expect.objectContaining({ behavior, outcome: 'client_closed' }),
    ])
  })

  it('preserves UTF-8 code points split across request chunks', async () => {
    const server = await start(['success'])
    const encoded = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }))
    const characterOffset = encoded.indexOf(Buffer.from('你'))
    expect(characterOffset).toBeGreaterThanOrEqual(0)

    await rawMessages(server, [
      encoded.subarray(0, characterOffset + 1),
      encoded.subarray(characterOffset + 1),
    ])

    expect(server.requests[0]?.body).toEqual({ messages: [{ role: 'user', content: '你好' }] })
  })

  it('formats an IPv6 listener as a valid base URL', async () => {
    const server = await start(['success'], { host: '::1' })

    expect(server.baseURL).toMatch(/^http:\/\/\[::1\]:\d+$/)
    expect((await messages(server)).status).toBe(200)
  })

  it('emits reasoning, tool calls, max-token finishes, slow chunks, and a wrong content type', async () => {
    const server = await start([
      'reasoning_success',
      'tool_call_success',
      'max_tokens',
      'slow_success',
      'wrong_content_type',
    ], {
      successText: 'answer',
      reasoningText: 'think',
      toolName: 'lookup',
      toolArguments: '{"id":7}',
      chunkDelayMs: 1,
      chunkSize: 2,
    })

    const bodies: string[] = []
    const contentTypes: Array<string | null> = []
    for (let index = 0; index < 5; index += 1) {
      const response = await messages(server)
      contentTypes.push(response.headers.get('content-type'))
      bodies.push(await response.text())
    }

    expect(bodies[0]).toContain('"thinking":"th"')
    expect(bodies[1]).toContain('"name":"lookup"')
    expect(bodies[1]).toContain('"partial_json":"{\\"id"')
    expect(bodies[1]).toContain('"stop_reason":"tool_use"')
    expect(bodies[2]).toContain('"stop_reason":"max_tokens"')
    expect(bodies[3]).toContain('"stop_reason":"end_turn"')
    expect(contentTypes[4]).toBe('application/json')
    expect(server.requests).toHaveLength(5)
    expect(server.requests.every(record => record.outcome === 'completed')).toBe(true)
  })

  it.each([
    ['rate_limit', 429, 'mock rate limit'] as const,
    ['server_error', 500, 'mock server error'] as const,
    ['service_unavailable', 503, 'mock service unavailable'] as const,
    ['auth_error', 401, 'mock authentication failed'] as const,
    ['invalid_request', 400, 'mock invalid request'] as const,
    ['context_overflow', 400, 'context_length_exceeded'] as const,
    ['quota_exceeded', 429, 'insufficient_quota'] as const,
  ])('serves %s as a structured HTTP error', async (behavior, status, marker) => {
    const server = await start([behavior], { retryAfterMs: 1_001, requestId: 'mock-request-1' })
    const response = await messages(server)
    const body = await response.text()

    expect(response.status).toBe(status)
    expect(body).toContain(marker)
    expect(response.headers.get('x-request-id')).toBe('mock-request-1')
    if (behavior === 'rate_limit') expect(response.headers.get('retry-after')).toBe('2')
    else expect(response.headers.get('retry-after')).toBeNull()
    expect(server.requests[0]?.outcome).toBe('completed')
  })

  it('fails loud on script exhaustion and can explicitly repeat the final behavior', async () => {
    const exhausted = await start(['success'], { successText: 'once' })
    await (await messages(exhausted)).text()
    const exhaustedResponse = await messages(exhausted)
    expect(exhaustedResponse.status).toBe(500)
    expect(await exhaustedResponse.text()).toContain('mock script exhausted')
    expect(exhausted.requests.map(record => record.behavior)).toEqual(['success', 'script_exhausted'])

    const repeating = await start(['empty'], { repeatLast: true })
    await (await messages(repeating)).text()
    await (await messages(repeating)).text()
    expect(repeating.requests.map(record => record.behavior)).toEqual(['empty', 'empty'])
  })

  it('selects weighted random behaviors reproducibly and reports the concrete choice', async () => {
    const options = {
      sequence: ['random'] as const,
      repeatLast: true,
      randomSeed: 42,
      randomWeights: { success: 1, empty: 1 },
      successText: 'random success',
    }
    const first = await startMockLlmServer(options)
    const second = await startMockLlmServer(options)
    running.push(first, second)

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await (await messages(first)).text()
      await (await messages(second)).text()
    }

    const firstChoices = first.requests.map(record => record.behavior)
    expect(first.randomSeed).toBe(42)
    expect(second.randomSeed).toBe(42)
    expect(firstChoices).toEqual(second.requests.map(record => record.behavior))
    expect(new Set(firstChoices)).toEqual(new Set(['success', 'empty']))
    expect(first.requests.every(record => record.scriptBehavior === 'random')).toBe(true)
  })

  it('rejects invalid method, route, API key, and JSON without consuming the script', async () => {
    const server = await start(['success'], { apiKey: 'expected' })
    const method = await fetch(`${server.baseURL}/v1/messages`)
    const route = await fetch(`${server.baseURL}/chat/completions`, { method: 'POST', body: '{}' })
    const auth = await messages(server, { key: 'wrong' })
    const json = await messages(server, { key: 'expected', body: '{' })

    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('POST')
    expect(route.status).toBe(404)
    expect(auth.status).toBe(401)
    expect(json.status).toBe(400)
    expect(server.requests).toHaveLength(0)

    const emptyRequest = await fetch(`${server.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'expected' },
    })
    expect(emptyRequest.status).toBe(200)
    expect(server.requests[0]?.behavior).toBe('success')
    expect(server.requests[0]?.body).toBeUndefined()
  })
})

describe('mock LLM server option validation', () => {
  it.each([
    [{ sequence: [] }, /sequence/],
    [{ sequence: ['success'], host: '' }, /host/],
    [{ sequence: ['success'], port: -1 }, /port/],
    [{ sequence: ['success'], port: 65_536 }, /port/],
    [{ sequence: ['success'], apiKey: '' }, /apiKey/],
    [{ sequence: ['success'], successText: '' }, /successText/],
    [{ sequence: ['success'], partialText: '' }, /partialText/],
    [{ sequence: ['success'], reasoningText: '' }, /reasoningText/],
    [{ sequence: ['success'], chunkSize: 0 }, /chunkSize/],
    [{ sequence: ['success'], chunkDelayMs: -1 }, /chunkDelayMs/],
    [{ sequence: ['success'], disconnectDelayMs: Number.POSITIVE_INFINITY }, /disconnectDelayMs/],
    [{ sequence: ['success'], retryAfterMs: 0 }, /retryAfterMs/],
    [{ sequence: ['success'], requestId: '' }, /requestId/],
    [{ sequence: ['success'], toolName: '' }, /toolName/],
    [{ sequence: ['success'], toolArguments: '{' }, /toolArguments/],
    [{ sequence: ['random'], randomSeed: -1 }, /randomSeed/],
    [{ sequence: ['random'], randomWeights: { random: 1 } }, /unknown concrete behavior/],
    [{ sequence: ['random'], randomWeights: { success: -1 } }, /non-negative/],
    [{ sequence: ['random'], randomWeights: { success: 0 } }, /positive weight/],
  ] as const)('rejects invalid options %#', async (options, expected) => {
    await expect(startMockLlmServer(options as Parameters<typeof startMockLlmServer>[0]))
      .rejects.toThrow(expected)
  })
})
