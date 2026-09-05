/**
 * `IncomingMessage`/`ServerResponse` synthesis for tunnel requests. The app's
 * `node:http` proxy reports a successful bind and captures the webserver's
 * request listener; the tunnel feeds that listener these pairs, so the real
 * route table, its trust fences, and every handler run unchanged.
 *
 * Synthesized members are exactly the ones the route handlers read; anything
 * else is absent on purpose so a new consumer
 * fails loud instead of silently reading a stub.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/transport/synthetic-http
 */
import type { TunnelRequestFrame } from './frames.ts'

const encoder = new TextEncoder()

/** Where a synthesized response writes to. */
export interface ResponseSink {
  /** Head of a streaming response. */
  head(status: number, headers: Record<string, string>): void
  /** One body chunk after {@link ResponseSink.head}. */
  chunk(bytes: Uint8Array): void
  /** Completion; the payload is present only for unary answers. */
  end(payload?: { status: number; headers: Record<string, string>; body?: Uint8Array | undefined }): void
  /** Failure of the exchange. */
  fail(message: string): void
}

/** Request listener shape the app's `createServer` captured. */
export type RequestListener = (req: unknown, res: unknown) => void

/** The pair a route handler consumes, plus abort control for the tunnel. */
export interface SyntheticExchange {
  readonly req: unknown
  readonly res: unknown
  /** Whether the page abandoned the request before it finished. */
  readonly aborted: boolean
  /** Mark the page as gone: emits `close` and stops further frames. */
  abort(): void
}

/**
 * Build the request/response pair for one tunnel request.
 *
 * `res.end()` is the settle point: the captured listener returns void, so the
 * response object itself reports completion. `write()` always returns true,
 * which skips backpressure waiting the tunnel cannot observe anyway.
 * @param frame - Validated request frame.
 * @param sink - Frame emitter for the response.
 * @returns The pair handed to the captured request listener.
 */
export function createSyntheticExchange(frame: TunnelRequestFrame, sink: ResponseSink): SyntheticExchange {
  const listeners = new Map<string, Set<() => void>>()
  let status = 200
  let headers: Record<string, string> = {}
  let streaming = false
  let finished = false
  let aborted = false

  const emit = (event: string): void => {
    for (const callback of [...(listeners.get(event) ?? [])]) callback()
  }

  const req = {
    url: frame.url,
    method: frame.method,
    headers: frame.headers,
    destroy: (): void => { aborted = true },
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      if (frame.body === undefined) return
      if (frame.body instanceof Blob) {
        for await (const chunk of frame.body.stream()) {
          if (aborted) return
          if (chunk.byteLength > 0) yield chunk
        }
        return
      }
      if (frame.body instanceof ReadableStream) {
        for await (const chunk of frame.body) {
          if (aborted) return
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError('webworker tunnel: request stream produced a non-Uint8Array chunk')
          }
          if (chunk.byteLength > 0) yield chunk
        }
        return
      }
      if (aborted || frame.body.byteLength === 0) return
      yield new Uint8Array(frame.body)
    },
  }

  const res: Record<string, unknown> = {
    writeHead: (nextStatus: number, nextHeaders?: Record<string, string | number>): unknown => {
      status = nextStatus
      if (nextHeaders !== undefined) {
        headers = {}
        for (const [key, value] of Object.entries(nextHeaders)) headers[key.toLowerCase()] = String(value)
      }
      return res
    },
    write: (chunk: string | Uint8Array): boolean => {
      if (finished || aborted) return false
      if (!streaming) {
        streaming = true
        sink.head(status, headers)
      }
      sink.chunk(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      return true
    },
    end: (body?: string | Uint8Array): unknown => {
      if (finished) return res
      finished = true
      const bytes = body === undefined ? undefined : typeof body === 'string' ? encoder.encode(body) : body
      if (streaming) {
        if (bytes !== undefined) sink.chunk(bytes)
        sink.end()
      } else {
        sink.end({ status, headers, body: bytes })
      }
      emit('close')
      return res
    },
    destroy: (): void => {
      if (finished) return
      finished = true
      sink.fail(`response destroyed for ${frame.method} ${frame.url}`)
      emit('close')
    },
    on: (event: string, callback: () => void): unknown => {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(callback)
      listeners.set(event, set)
      return res
    },
    off: (event: string, callback: () => void): unknown => {
      listeners.get(event)?.delete(callback)
      return res
    },
  }
  res.once = res.on
  Object.defineProperty(res, 'headersSent', { get: () => streaming })
  Object.defineProperty(res, 'writableEnded', { get: () => finished })

  return {
    req,
    res,
    get aborted(): boolean {
      return aborted
    },
    abort: (): void => {
      if (finished) return
      aborted = true
      finished = true
      emit('aborted')
      emit('close')
    },
  }
}
