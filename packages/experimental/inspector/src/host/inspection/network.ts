/** Full `globalThis.fetch` capture that publishes without delaying response delivery. */

import type { InspectorJsonValue } from '../../shared/json.ts'
import type { InspectorPublisher } from '../../shared/bridge/publisher.ts'
import { FETCH_TOPICS } from '../../shared/bridge/messages/network.ts'

/** Observation topics published by the Host network adapter. */
export const NETWORK_TOPICS: readonly string[] = FETCH_TOPICS

/** Byte limits for request and response clone capture. */
export interface FetchCaptureOptions {
  readonly maxRequestBodyBytes: number
  readonly maxResponseBodyBytes: number
  readonly maxChunkBytes: number
}

/**
 * Keeps each wrapper-created Request reachable while the caller's response body stream is reachable.
 * Node's fetch forwards the caller's abort signal only while that Request is reachable. The capture
 * clone shares one source with the caller's body stream and keeps that stream reachable while capture
 * reads. Entries are set after `response.clone()`, which replaces `response.body`. The map is
 * module-level so that responses obtained before `stop()` keep their Request reachable afterwards.
 */
const requestsByBody = new WeakMap<ReadableStream<Uint8Array>, Request>()

interface CaptureOutcome {
  readonly capturedBytes: number
  readonly truncated: boolean
  readonly captureError?: string
}

/** Active global fetch wrapper. */
export interface FetchObserver {
  /** Restore the prior fetch implementation, cancel clone readers, and await their settlement. */
  stop(): Promise<void>
}

/**
 * Install full fetch capture for every later call through `globalThis.fetch`.
 * @param publisher - Host source that receives fetch lifecycle records.
 * @param options - Per-body capture limits.
 * @returns The owner that stops capture and awaits pending body readers.
 */
export function installFetchObserver(
  publisher: InspectorPublisher,
  options: FetchCaptureOptions,
): FetchObserver {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const original = globalThis.fetch
  if (typeof original !== 'function') throw new Error('inspector: globalThis.fetch is unavailable')
  if (descriptor !== undefined && !('value' in descriptor)) {
    throw new Error('inspector: globalThis.fetch is an accessor and cannot be observed safely')
  }

  const controller = new AbortController()
  const pending = new Set<Promise<void>>()
  let nextRequestId = 0

  const track = (promise: Promise<void>): void => {
    pending.add(promise)
    void promise.then(
      () => { pending.delete(promise) },
      () => { pending.delete(promise) },
    )
  }

  const observedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const requestId = `fetch-${++nextRequestId}`
    publisher.publish('fetch/start', {
      requestId,
      url: request.url,
      method: request.method,
      headers: headerEntries(request.headers),
      hasBody: request.body !== null,
      wallTimeMs: Date.now(),
    })

    let requestClone: Request | undefined
    try {
      requestClone = request.clone()
    } catch (error) {
      publisher.publish('fetch/request-body-end', {
        requestId,
        capturedBytes: 0,
        truncated: false,
        captureError: renderError(error),
      })
    }
    if (requestClone !== undefined) {
      track(captureBody(
        requestClone.body,
        options.maxRequestBodyBytes,
        options.maxChunkBytes,
        controller.signal,
        (data) => { publisher.publish('fetch/request-body-chunk', { requestId, data }) },
      ).then((outcome) => {
        publisher.publish('fetch/request-body-end', compactOutcome(requestId, outcome))
      }))
    }

    let response: Response
    try {
      response = await Reflect.apply(original, globalThis, [request])
    } catch (error) {
      publisher.publish('fetch/error', {
        requestId,
        message: renderError(error),
        canceled: request.signal.aborted || isAbortError(error),
      })
      throw error
    }

    publisher.publish('fetch/response', {
      requestId,
      url: response.url || request.url,
      status: response.status,
      statusText: response.statusText,
      headers: headerEntries(response.headers),
      mimeType: response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '',
    })

    try {
      const responseClone = response.clone()
      track(captureBody(
        responseClone.body,
        options.maxResponseBodyBytes,
        options.maxChunkBytes,
        controller.signal,
        (data) => { publisher.publish('fetch/response-body-chunk', { requestId, data }) },
      ).then((outcome) => {
        publisher.publish('fetch/end', {
          requestId,
          capturedBytes: outcome.capturedBytes,
          responseBodyTruncated: outcome.truncated,
          ...(outcome.captureError === undefined ? {} : { responseCaptureError: outcome.captureError }),
        })
      }))
    } catch (error) {
      publisher.publish('fetch/end', {
        requestId,
        capturedBytes: 0,
        responseBodyTruncated: false,
        responseCaptureError: renderError(error),
      })
    }
    if (response.body !== null) requestsByBody.set(response.body, request)
    return response
  }

  Object.defineProperty(observedFetch, 'name', { value: original.name, configurable: true })
  Object.defineProperty(observedFetch, 'length', { value: original.length, configurable: true })
  Object.defineProperty(globalThis, 'fetch', descriptor === undefined
    ? { value: observedFetch, writable: true, configurable: true }
    : { ...descriptor, value: observedFetch })

  let stopped: Promise<void> | undefined
  return {
    stop(): Promise<void> {
      if (stopped !== undefined) return stopped
      stopped = (async () => {
        const current = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
        if (current !== undefined && 'value' in current && current.value === observedFetch) {
          if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
          else Object.defineProperty(globalThis, 'fetch', descriptor)
        }
        controller.abort()
        await Promise.allSettled([...pending])
      })()
      return stopped
    },
  }
}

async function captureBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  chunkLimit: number,
  signal: AbortSignal,
  emit: (base64: string) => void,
): Promise<CaptureOutcome> {
  if (body === null) return { capturedBytes: 0, truncated: false }
  const reader = body.getReader()
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  let capturedBytes = 0
  let truncated = false
  try {
    while (!signal.aborted) {
      const item = await reader.read()
      if (item.done) break
      let offset = 0
      while (offset < item.value.byteLength) {
        const remaining = limit - capturedBytes
        if (remaining <= 0) {
          truncated = true
          void reader.cancel('inspector body capture limit reached').catch(() => undefined)
          return { capturedBytes, truncated }
        }
        const size = Math.min(chunkLimit, remaining, item.value.byteLength - offset)
        const chunk = item.value.subarray(offset, offset + size)
        emit(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'))
        capturedBytes += size
        offset += size
      }
    }
    if (signal.aborted) {
      void reader.cancel(signal.reason).catch(() => undefined)
      return { capturedBytes, truncated, captureError: 'inspector stopped during body capture' }
    }
    return { capturedBytes, truncated }
  } catch (error) {
    return { capturedBytes, truncated: true, captureError: renderError(error) }
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function compactOutcome(requestId: string, outcome: CaptureOutcome): InspectorJsonValue {
  return {
    requestId,
    capturedBytes: outcome.capturedBytes,
    truncated: outcome.truncated,
    ...(outcome.captureError === undefined ? {} : { captureError: outcome.captureError }),
  }
}

function headerEntries(headers: Headers): [string, string][] {
  return [...headers.entries()]
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function renderError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return String(error)
  } catch {
    return 'unrenderable fetch error'
  }
}
