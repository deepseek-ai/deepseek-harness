/** Host fetch observation behavior. */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFetchObserver, type FetchObserver } from '../src/host/inspection/network.ts'
import type { InspectorRecordInput } from '../src/shared/bridge/messages/observation.ts'
import type { InspectorJsonValue } from '../src/shared/json.ts'

describe('full fetch observer', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let observer: FetchObserver | undefined

  afterEach(async () => {
    await observer?.stop()
    observer = undefined
    vi.restoreAllMocks()
    if (originalDescriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
    else Object.defineProperty(globalThis, 'fetch', originalDescriptor)
  })

  it('captures complete URL, headers, request body, response headers, and response body', async () => {
    const records: InspectorRecordInput[] = []
    const native = vi.fn(async (request: Request) => {
      expect(await request.clone().text()).toBe('secret request body')
      return new Response('complete response body', {
        status: 201,
        statusText: 'Created',
        headers: { authorization: 'response secret', 'content-type': 'text/plain' },
      })
    })
    Object.defineProperty(globalThis, 'fetch', { value: native, writable: true, configurable: true })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    const response = await fetch('https://example.test/path?token=visible', {
      method: 'POST',
      headers: { authorization: 'Bearer visible' },
      body: 'secret request body',
    })
    expect(await response.text()).toBe('complete response body')
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })

    const start = payload(records, 'fetch/start')
    expect(start).toMatchObject({
      url: 'https://example.test/path?token=visible',
      method: 'POST',
    })
    expect(start.headers).toEqual(expect.arrayContaining([['authorization', 'Bearer visible']]))
    expect(decodeChunks(records, 'fetch/request-body-chunk')).toBe('secret request body')
    const responseRecord = payload(records, 'fetch/response')
    expect(responseRecord.status).toBe(201)
    expect(responseRecord.headers).toEqual(expect.arrayContaining([['authorization', 'response secret']]))
    expect(decodeChunks(records, 'fetch/response-body-chunk')).toBe('complete response body')
    expect(payload(records, 'fetch/request-body-end')).toMatchObject({ truncated: false })
    expect(payload(records, 'fetch/end')).toMatchObject({ responseBodyTruncated: false })
  })

  it('marks bodies truncated without changing the caller response', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.resolve(new Response('response-long'))),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 4, maxResponseBodyBytes: 4, maxChunkBytes: 2 })

    const response = await fetch('https://example.test/', { method: 'POST', body: 'request-long' })
    expect(await response.text()).toBe('response-long')
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })

    expect(decodeChunks(records, 'fetch/request-body-chunk')).toBe('requ')
    expect(payload(records, 'fetch/request-body-end')).toMatchObject({ capturedBytes: 4, truncated: true })
    expect(decodeChunks(records, 'fetch/response-body-chunk')).toBe('resp')
    expect(payload(records, 'fetch/end')).toMatchObject({ capturedBytes: 4, responseBodyTruncated: true })
  })

  it('finishes response capture when the caller aborts after response headers', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (request: Request) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('first'))
          request.signal.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      }))),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })
    const abort = new AbortController()

    const response = await fetch('https://example.test/cancel-body', { signal: abort.signal })
    abort.abort()
    await expect(response.text()).rejects.toThrow()
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })

    expect(decodeChunks(records, 'fetch/response-body-chunk')).toBe('first')
    expect(payload(records, 'fetch/end')).toMatchObject({
      capturedBytes: 5,
      responseBodyTruncated: true,
      responseCaptureError: 'AbortError: aborted',
    })
    expect(records.some(record => record.topic === 'fetch/error')).toBe(false)
  })

  it.each([
    { label: 'while capture is still reading the clone', maxResponseBodyBytes: 1_024, captureTruncated: false },
    { label: 'after capture has stopped at its byte limit', maxResponseBodyBytes: 4, captureTruncated: true },
  ])('forwards a caller abort to native fetch after the wrapper Request is unreferenced $label', async ({
    maxResponseBodyBytes,
    captureTruncated,
  }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    try {
      const records: InspectorRecordInput[] = []
      observer = installFetchObserver({
        publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
          records.push({ topic, payload, monotonicMs })
        },
      }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes, maxChunkBytes: 1_024 })
      const abort = new AbortController()
      const { port } = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${String(port)}/open-stream`, { signal: abort.signal })
      const reader = response.body!.getReader()
      await reader.read()
      if (captureTruncated) {
        await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })
      }
      // Node's fetch follows the caller signal only while the wrapper-created Request is reachable.
      await collectGarbage()

      abort.abort()
      await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })
      const end = payload(records, 'fetch/end')
      expect(end.responseBodyTruncated).toBe(true)
      if (captureTruncated) expect(end.responseCaptureError).toBeUndefined()
      else expect(String(end.responseCaptureError)).toContain('AbortError')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('reports a fetch rejected before response headers as a canceled request', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (request: Request) => await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })
    const abort = new AbortController()

    const pending = fetch('https://example.test/cancel-before-response', { signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toThrow()

    expect(payload(records, 'fetch/error')).toMatchObject({ canceled: true })
    expect(records.some(record => record.topic === 'fetch/response')).toBe(false)
    expect(records.some(record => record.topic === 'fetch/end')).toBe(false)
  })

  it('reports non-cancellation fetch failures without manufacturing a canceled flag', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.reject(new Error('connection failed'))),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    await expect(fetch('https://example.test/failure')).rejects.toThrow('connection failed')
    expect(payload(records, 'fetch/error')).toMatchObject({ message: 'Error: connection failed', canceled: false })
  })

  it('records request and response clone failures without replacing the caller response', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.resolve(new Response('response'))),
      writable: true,
      configurable: true,
    })
    const requestClone = vi.spyOn(Request.prototype, 'clone').mockImplementationOnce(() => {
      throw new Error('request clone failed')
    })
    const responseClone = vi.spyOn(Response.prototype, 'clone').mockImplementationOnce(() => {
      throw new Error('response clone failed')
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    const response = await fetch('https://example.test/clone-failure', { method: 'POST', body: 'request' })
    expect(await response.text()).toBe('response')
    expect(payload(records, 'fetch/request-body-end')).toMatchObject({ captureError: 'Error: request clone failed' })
    expect(payload(records, 'fetch/end')).toMatchObject({ responseCaptureError: 'Error: response clone failed' })
    requestClone.mockRestore()
    responseClone.mockRestore()
  })

  it('handles responses without bodies and keeps stop idempotent when fetch is replaced', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })
    const replacement = vi.fn<typeof fetch>()

    await fetch('https://example.test/no-content')
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })
    Object.defineProperty(globalThis, 'fetch', { value: replacement, writable: true, configurable: true })
    const firstStop = observer.stop()
    expect(observer.stop()).toBe(firstStop)
    await firstStop
    expect(globalThis.fetch).toBe(replacement)
  })

  it('rejects installation without a callable global fetch', () => {
    Object.defineProperty(globalThis, 'fetch', { value: undefined, writable: true, configurable: true })
    expect(() => installFetchObserver({ publish: vi.fn() }, {
      maxRequestBodyBytes: 1,
      maxResponseBodyBytes: 1,
      maxChunkBytes: 1,
    })).toThrow('globalThis.fetch is unavailable')
  })

  it('rejects an accessor fetch property', () => {
    const nativeFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get: () => nativeFetch,
    })
    expect(() => installFetchObserver({ publish: vi.fn() }, {
      maxRequestBodyBytes: 1,
      maxResponseBodyBytes: 1,
      maxChunkBytes: 1,
    })).toThrow('globalThis.fetch is an accessor')
  })

  it('contains publisher failures from asynchronous body completion', async () => {
    let endAttempted = false
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.resolve(new Response('response'))),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string): void {
        if (topic !== 'fetch/end') return
        endAttempted = true
        throw new Error('publisher closed')
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    await fetch('https://example.test/publisher-failure')
    await vi.waitFor(() => { expect(endAttempted).toBe(true) })
    await expect(observer.stop()).resolves.toBeUndefined()
  })

  it('cancels an active clone reader when the observer stops', async () => {
    const records: InspectorRecordInput[] = []
    let settleRead: ((value: ReadableStreamReadResult<Uint8Array>) => void) | undefined
    const reader = {
      read: vi.fn(async () => await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        settleRead = resolve
      })),
      cancel: vi.fn(() => {
        settleRead?.({ done: true, value: undefined })
        return Promise.reject(new Error('cancel already observed'))
      }),
      releaseLock: vi.fn(),
    }
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.resolve(new Response('caller response'))),
      writable: true,
      configurable: true,
    })
    vi.spyOn(Response.prototype, 'clone').mockReturnValueOnce({
      body: { getReader: () => reader },
    } as unknown as Response)
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    await fetch('https://example.test/pending-body')
    await observer.stop()
    expect(reader.cancel).toHaveBeenCalled()
    expect(payload(records, 'fetch/end')).toMatchObject({
      responseCaptureError: 'inspector stopped during body capture',
    })
  })

  it('contains a rejected reader cancellation after reaching the body limit', async () => {
    const records: InspectorRecordInput[] = []
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from('oversized') })
        .mockResolvedValue({ done: true, value: undefined }),
      cancel: vi.fn(() => Promise.reject(new Error('cancel failed'))),
      releaseLock: vi.fn(),
    }
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.resolve(new Response('caller response'))),
      writable: true,
      configurable: true,
    })
    vi.spyOn(Response.prototype, 'clone').mockReturnValueOnce({
      body: { getReader: () => reader },
    } as unknown as Response)
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1, maxChunkBytes: 1 })

    await fetch('https://example.test/body-limit')
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })
    expect(payload(records, 'fetch/end')).toMatchObject({ capturedBytes: 1, responseBodyTruncated: true })
    expect(reader.cancel).toHaveBeenCalledWith('inspector body capture limit reached')
  })

  it('renders non-Error rejection values without allowing hostile coercion to escape', async () => {
    const records: InspectorRecordInput[] = []
    const plainFailure: unknown = 'plain failure'
    const unrenderable = { toString: () => { throw new Error('cannot stringify') } }
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn()
        .mockImplementationOnce(async () => { throw plainFailure })
        .mockImplementationOnce(async () => { throw unrenderable }),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    await expect(fetch('https://example.test/plain-failure')).rejects.toBe('plain failure')
    await expect(fetch('https://example.test/unrenderable-failure')).rejects.toBe(unrenderable)
    expect(records.filter(record => record.topic === 'fetch/error').map(record => record.payload))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'plain failure', canceled: false }),
        expect.objectContaining({ message: 'unrenderable fetch error', canceled: false }),
      ]))
  })

  it('restores an inherited fetch without leaving an own property', async () => {
    const prototype = Object.getPrototypeOf(globalThis) as object
    const inheritedDescriptor = Object.getOwnPropertyDescriptor(prototype, 'fetch')
    const nativeFetch = originalDescriptor?.value as typeof fetch
    Reflect.deleteProperty(globalThis, 'fetch')
    Object.defineProperty(prototype, 'fetch', { value: nativeFetch, writable: true, configurable: true })
    try {
      observer = installFetchObserver({ publish: vi.fn() }, {
        maxRequestBodyBytes: 1_024,
        maxResponseBodyBytes: 1_024,
        maxChunkBytes: 4,
      })
      await observer.stop()
      expect(Object.hasOwn(globalThis, 'fetch')).toBe(false)
    } finally {
      if (inheritedDescriptor === undefined) Reflect.deleteProperty(prototype, 'fetch')
      else Object.defineProperty(prototype, 'fetch', inheritedDescriptor)
    }
  })

  it('reports request clone read errors and non-abort DOM failures', async () => {
    const records: InspectorRecordInput[] = []
    const requestReadFailure: unknown = 'request read failed'
    const reader = {
      read: vi.fn(async () => { throw requestReadFailure }),
      cancel: vi.fn(() => Promise.resolve()),
      releaseLock: vi.fn(),
    }
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockRejectedValueOnce(new DOMException('network failed', 'NetworkError')),
      writable: true,
      configurable: true,
    })
    vi.spyOn(Request.prototype, 'clone').mockReturnValueOnce({
      body: { getReader: () => reader },
    } as unknown as Request)
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    await fetch('https://example.test/request-read-failure')
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/request-body-end')).toBe(true) })
    expect(payload(records, 'fetch/request-body-end')).toMatchObject({ captureError: 'request read failed' })
    await expect(fetch('https://example.test/network-failure')).rejects.toThrow('network failed')
    expect(records.filter(record => record.topic === 'fetch/error').at(-1)?.payload)
      .toMatchObject({ canceled: false })
  })
})

/**
 * Run several full collections. `--expose-gc` stays enabled for the rest of this forked Vitest worker
 * process; only new vm contexts can obtain `gc`, so other specs in the worker may observe it there.
 */
async function collectGarbage(): Promise<void> {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  for (let pass = 0; pass < 5; pass += 1) {
    gc()
    await new Promise((resolve) => { setImmediate(resolve) })
  }
}

function payload(records: readonly InspectorRecordInput[], topic: string): Record<string, unknown> {
  const record = records.find(candidate => candidate.topic === topic)
  expect(record).toBeDefined()
  return record!.payload as Record<string, unknown>
}

function decodeChunks(records: readonly InspectorRecordInput[], topic: string): string {
  return Buffer.concat(records
    .filter(record => record.topic === topic)
    .map(record => Buffer.from(String((record.payload as Record<string, unknown>).data), 'base64')))
    .toString('utf8')
}
