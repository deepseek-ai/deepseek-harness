/**
 * Worker end of the postMessage tunnel. It owns the dispatch lanes and the queue
 * that holds requests until the host tree is serving:
 *
 * - `GET /__boot__` answers from tunnel glue, never from the host API surface,
 *   because the page needs the boot payload before its Cordis tree exists.
 * - Privileged `/api` methods take that same direct entry. The method set is not
 *   restated here: a 401 or 403 from the route lane is retried on the direct
 *   lane because the page owns the worker and needs no network authentication.
 * - Everything else is fed into the real webserver route table through the
 *   request listener the app's fake `node:http` captured, keeping the trust
 *   fences, byte limits, and status semantics intact.
 *
 * A boot failure rejects the whole queue with 503 rather than leaving the page
 * waiting.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/transport/tunnel
 */
import {
  parseInboundFrame, type TunnelOutboundFrame, type TunnelRequestFrame, type TunnelRequestId,
  type TunnelStreamOpenFrame,
} from './frames.ts'
import {
  createSyntheticExchange, type RequestListener, type ResponseSink, type SyntheticExchange,
} from './synthetic-http.ts'

/** Prefix owning the API methods. */
export const API_PREFIX = '/api'

/** Host header the synthesized requests carry; the API trust fence requires one. */
export const SYNTHETIC_HOST = '127.0.0.1'

const encoder = new TextEncoder()

/**
 * Render a failure with everything nested inside it.
 *
 * A boot failure is usually an `AggregateError` of per-entry failures, each
 * wrapping the plugin's own error as `cause`; only the outermost message names
 * "loader entries failed to apply", which says nothing about which row broke.
 *
 * The page logs the rendered text verbatim for refusals; keep it stable for
 * anyone matching boot-failure output.
 * @param reason - Thrown value.
 * @returns One line per nested failure, indented by depth.
 */
export function describeFailure(reason: unknown): string {
  const seen = new Set<unknown>()
  const lines: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || seen.has(value) || depth > 6) return
    seen.add(value)
    const indent = '  '.repeat(depth)
    if (!(value instanceof Error)) {
      // A thrower may pass anything as a cause; JSON keeps an object readable
      // where the default stringification would print `[object Object]`.
      const rendered = typeof value === 'string' ? value : JSON.stringify(value) as string | undefined
      lines.push(`${indent}${rendered ?? typeof value}`)
      return
    }
    lines.push(`${indent}${value.name}: ${value.message}`)
    if (value instanceof AggregateError) for (const inner of value.errors) walk(inner, depth + 1)
    walk(value.cause, depth + 1)
  }
  walk(reason, 0)
  return lines.join('\n')
}

/**
 * Copy bytes into an exact-size ArrayBuffer so it can be transferred.
 *
 * Sliced on the ArrayBuffer, not the view: `Uint8Array.prototype.slice` copies,
 * but a Node-style Buffer overrides `slice()` with view semantics, and the fs
 * bridge hands VFS reads over as Buffer views into the whole mounted image —
 * `bytes.slice().buffer` would then post the entire image as the body.
 */
function toTransferable(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Message channel the tunnel posts frames on. */
export interface TunnelPort {
  postMessage(message: TunnelOutboundFrame, transfer?: Transferable[]): void
}

/** What the tunnel gains once the host tree is up. */
export interface TunnelSeams {
  /**
   * Direct entry to the API fetch handler for privileged methods and any unary
   * call the route lane refused with 401 or 403.
   */
  readonly directFetch: (request: Request) => Promise<Response>
  /** Boot payload for `GET /__boot__`: the structured index injection table. */
  readonly bootPayload: () => unknown
  /** Open one decoded Gateway Remote stream without another network carrier; `uplink` carries the page's items. */
  readonly openStream: (
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<unknown>>
  /** Convert a Gateway stream failure to stable Client fields. */
  readonly streamFailure: (error: unknown) => {
    readonly code: string
    readonly message: string
    readonly details: object
  }
}

/** Construction inputs for {@link TunnelServer}. */
export interface TunnelServerOptions {
  /** Channel back to the page. */
  readonly port: TunnelPort
  /**
   * The webserver's request listener, captured by the app's fake `node:http`.
   * Awaited on first use, so requests may arrive before the server binds.
   */
  readonly requestListener: () => Promise<RequestListener>
  /**
   * Methods that skip the route lane outright. Supply the host's own privileged
   * set when it is reachable; omitting it leaves the 401/403 retry as the mechanism.
   */
  readonly privilegedMethods?: ReadonlySet<string>
  /**
   * Escape hatch for the unary `/api` lane. `route` (default) keeps every fence
   * and byte limit with a 401/403 retry on the direct lane; `direct` sends every
   * unary `/api` call straight to the fetch handler.
   */
  readonly unaryApiLane?: 'route' | 'direct'
}

interface InFlight {
  abort(): void
}

type QueuedFrame = TunnelRequestFrame | TunnelStreamOpenFrame

/** Recorded response frames, so a route-lane authentication refusal can be discarded. */
class BufferedSink {
  private readonly calls: Array<() => void> = []
  private target: ResponseSink | undefined
  private settle: ((outcome: { streamed: boolean; status: number }) => void) | undefined

  /** Resolves when the exchange either starts streaming or answers in one frame. */
  readonly settled = new Promise<{ streamed: boolean; status: number }>((resolve) => { this.settle = resolve })

  readonly sink: ResponseSink = {
    head: (status, headers) => {
      this.record(() => { this.target?.head(status, headers) })
      this.settle?.({ streamed: true, status })
    },
    chunk: (bytes) => { this.record(() => { this.target?.chunk(bytes) }) },
    end: (payload) => {
      this.record(() => { this.target?.end(payload) })
      this.settle?.({ streamed: payload === undefined, status: payload?.status ?? 200 })
    },
    fail: (message) => {
      this.record(() => { this.target?.fail(message) })
      this.settle?.({ streamed: true, status: 500 })
    },
  }

  private record(call: () => void): void {
    if (this.target === undefined) this.calls.push(call)
    else call()
  }

  /**
   * Send everything recorded so far to a real sink and pass later calls through.
   * @param target - Sink receiving the frames.
   */
  flushTo(target: ResponseSink): void {
    this.target = target
    for (const call of this.calls.splice(0)) call()
  }
}

/** Uplink items of one worker-local logical stream, read once by the Host method as its `uplink`. */
class TunnelUplink implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly items: unknown[] = []
  private ended = false
  private closed = false
  private wake: (() => void) | undefined

  push(value: unknown): void {
    if (this.ended || this.closed) return
    this.items.push(value)
    this.signal()
  }

  /** Page half-close or stream end; buffered items still drain. */
  end(): void {
    this.ended = true
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return { value: undefined, done: true }
      if (this.items.length > 0) return { value: this.items.shift(), done: false }
      if (this.ended) return { value: undefined, done: true }
      if (this.wake !== undefined) throw new Error('webworker tunnel: stream uplink has one pending read')
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /** The Host stopped reading: buffered and later items are dropped. */
  return(): Promise<IteratorResult<unknown>> {
    this.closed = true
    this.items.length = 0
    this.signal()
    return Promise.resolve({ value: undefined, done: true })
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** One tunnel per worker; wire {@link TunnelServer.handleMessage} to `onmessage` first. */
export class TunnelServer {
  private readonly port: TunnelPort
  private readonly requestListener: () => Promise<RequestListener>
  private readonly privilegedMethods: ReadonlySet<string> | undefined
  private readonly unaryApiLane: 'route' | 'direct'
  private readonly queue: QueuedFrame[] = []
  private readonly inFlight = new Map<TunnelRequestId, InFlight>()
  /** Uplinks of accepted `stream-open` frames, buffering items that arrive before or while the stream serves. */
  private readonly uplinks = new Map<TunnelRequestId, TunnelUplink>()
  private seams: TunnelSeams | undefined
  private failure: string | undefined
  private listener: RequestListener | undefined

  constructor(options: TunnelServerOptions) {
    this.port = options.port
    this.requestListener = options.requestListener
    this.privilegedMethods = options.privilegedMethods
    this.unaryApiLane = options.unaryApiLane ?? 'route'
  }

  /**
   * Accept one `postMessage` payload.
   * @param data - Message data from the page.
   */
  handleMessage(data: unknown): void {
    const frame = parseInboundFrame(data)
    if (frame.t === 'init') {
      // The worker entry consumes the opening init before this server exists;
      // one reaching a live server is a client double-connect.
      throw new Error('webworker tunnel: duplicate init frame; the tunnel is already open')
    }
    if (frame.t === 'stream-uplink-item') {
      this.uplinks.get(frame.id)?.push(frame.value)
      return
    }
    if (frame.t === 'stream-uplink-end') {
      this.uplinks.get(frame.id)?.end()
      return
    }
    if (frame.t === 'abort') {
      this.inFlight.get(frame.id)?.abort()
      this.inFlight.delete(frame.id)
      this.dropUplink(frame.id)
      // A request still parked in the boot queue must not run after its
      // caller gave up; serve() would otherwise execute it post-boot.
      const queued = this.queue.findIndex(request => request.id === frame.id)
      if (queued !== -1) this.queue.splice(queued, 1)
      return
    }
    if (this.failure !== undefined) {  this.refuse(frame, this.failure); return }
    if (frame.t === 'stream-open') this.uplinks.set(frame.id, new TunnelUplink())
    if (this.seams === undefined) {
      this.queue.push(frame)
      return
    }
    this.dispatchFrame(frame)
  }

  /**
   * Start serving: drains everything queued during boot.
   * @param seams - Faces that exist only after the host tree is up.
   */
  serve(seams: TunnelSeams): void {
    this.seams = seams
    console.info(`webworker tunnel: serving (unary /api lane=${this.unaryApiLane}${this.unaryApiLane === 'route' ? ' with 401/403 retry' : ''}, privileged set=${this.privilegedMethods === undefined ? 'none' : String(this.privilegedMethods.size)}, queued=${String(this.queue.length)})`)
    for (const frame of this.queue.splice(0)) this.dispatchFrame(frame)
  }

  /**
   * Refuse every queued and future request; the page renders this like a server
   * that failed to start.
   * @param reason - Boot failure to report.
   */
  fail(reason: unknown): void {
    const message = describeFailure(reason)
    this.failure = message
    for (const frame of this.queue.splice(0)) this.refuse(frame, message)
  }

  private send(frame: TunnelOutboundFrame, transfer?: Transferable[]): void {
    this.port.postMessage(frame, transfer)
  }

  private refuse(frame: QueuedFrame, message: string): void {
    if (frame.t === 'stream-open') {
      this.dropUplink(frame.id)
      this.send({
        t: 'stream-error',
        id: frame.id,
        failure: { kind: 'carrier', message },
      })
      return
    }
    const body = toTransferable(encoder.encode(message))
    this.send({
      t: 'res',
      id: frame.id,
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
      message,
    }, [body])
  }

  private dispatchFrame(frame: QueuedFrame): void {
    if (frame.t === 'stream-open') void this.serveStream(frame)
    else void this.serveRequest(frame)
  }

  private async serveStream(frame: TunnelStreamOpenFrame): Promise<void> {
    if (this.seams === undefined) {
      this.refuse(frame, 'webworker tunnel: Remote stream requested before the host tree is serving')
      return
    }
    const seams = this.seams
    const uplink = this.uplinks.get(frame.id) ?? new TunnelUplink()
    const controller = new AbortController()
    this.inFlight.set(frame.id, { abort: () => { controller.abort() } })
    try {
      const source = await seams.openStream(frame.endpoint, frame.payload, uplink, controller.signal)
      for await (const value of source) {
        if (controller.signal.aborted) return
        this.send({ t: 'stream-item', id: frame.id, value })
      }
      if (!controller.signal.aborted) this.send({ t: 'stream-end', id: frame.id })
    } catch (error) {
      if (!controller.signal.aborted) {
        const failure = seams.streamFailure(error)
        this.send({
          t: 'stream-error',
          id: frame.id,
          failure: { kind: 'remote', ...failure },
        })
      }
    } finally {
      this.inFlight.delete(frame.id)
      this.dropUplink(frame.id)
    }
  }

  /** The stream is over: settle any Host read still waiting on its uplink and stop buffering. */
  private dropUplink(id: TunnelRequestId): void {
    const uplink = this.uplinks.get(id)
    this.uplinks.delete(id)
    uplink?.end()
  }

  private sinkFor(id: TunnelRequestId): ResponseSink {
    const send = this.send.bind(this)
    const inFlight = this.inFlight
    return {
      head(status, headers) {
        send({ t: 'res-head', id, status, headers })
      },
      chunk(bytes) {
        const buffer = toTransferable(bytes)
        send({ t: 'res-chunk', id, chunk: buffer }, [buffer])
      },
      end(payload) {
        if (payload === undefined) {
          send({ t: 'res-end', id })
        } else {
          const body = payload.body === undefined ? undefined : toTransferable(payload.body)
          send({ t: 'res', id, status: payload.status, headers: payload.headers, body }, body === undefined ? undefined : [body])
        }
        inFlight.delete(id)
      },
      fail(message) {
        send({ t: 'res-err', id, message })
        inFlight.delete(id)
      },
    }
  }

  /** The page sends an absolute URL; route handlers read `req.url` as a path. */
  private pathFrame(frame: TunnelRequestFrame): { frame: TunnelRequestFrame; path: string } {
    const url = new URL(frame.url, `http://${SYNTHETIC_HOST}`)
    return {
      // The API trust fence reads `host`, which the page cannot set itself.
      frame: { ...frame, url: `${url.pathname}${url.search}`, headers: { ...frame.headers, host: SYNTHETIC_HOST } },
      path: url.pathname,
    }
  }

  private async serveRequest(frame: TunnelRequestFrame): Promise<void> {
    const sink = this.sinkFor(frame.id)
    try {
      const { frame: routed, path } = this.pathFrame(frame)
      if (path === '/__boot__') {  this.serveBoot(frame, sink); return }
      if (path.startsWith(`${API_PREFIX}/`)) {  await this.serveApi(frame, routed, path, sink); return }
      this.dispatch(routed, sink)
    } catch (reason) {
      sink.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /**
   * The listener is captured once and reused, so only requests that arrive
   * before the web server binds pay an await.
   * @returns The webserver request listener.
   */
  private async whenListener(): Promise<RequestListener> {
    this.listener ??= await this.requestListener()
    return this.listener
  }

  /** Feed the real route table through the captured listener. */
  private dispatch(frame: TunnelRequestFrame, sink: ResponseSink, into?: ResponseSink): SyntheticExchange {
    const exchange = createSyntheticExchange(frame, into ?? sink)
    this.inFlight.set(frame.id, exchange)
    const listener = this.listener
    if (listener !== undefined) {
      listener(exchange.req, exchange.res)
      return exchange
    }
    void this.whenListener().then((resolved) => {
      // A page that gave up while the server was still binding has nothing to answer.
      if (!exchange.aborted) resolved(exchange.req, exchange.res)
    }, (reason: unknown) => {
      sink.fail(reason instanceof Error ? reason.message : String(reason))
    })
    return exchange
  }

  /**
   * Unary `/api`: keep the route lane's fences, but fall back to the direct lane
   * when network authentication or trust rejects the worker-owning page.
   */
  private async serveApi(
    original: TunnelRequestFrame,
    routed: TunnelRequestFrame,
    path: string,
    sink: ResponseSink,
  ): Promise<void> {
    const method = path.slice(API_PREFIX.length + 1)
    if (this.unaryApiLane === 'direct' || this.privilegedMethods?.has(method) === true) {
      await this.serveDirect(original, sink)
      return
    }
    const buffered = new BufferedSink()
    const exchange = this.dispatch(routed, sink, buffered.sink)
    // An abort must release this wait too: an aborted exchange stops emitting
    // frames, so `settled` alone would never resolve when the handler had not
    // yet written a head.
    let settleAborted = (): void => {}
    const aborted = new Promise<'aborted'>((resolve) => { settleAborted = () => { resolve('aborted') } })
    this.inFlight.set(routed.id, { abort: () => { exchange.abort(); settleAborted() } })
    const outcome = await Promise.race([buffered.settled, aborted])
    if (outcome === 'aborted' || exchange.aborted) return
    // The decision happens at the first frame, before anything reaches the page:
    // the route lane streams its answers, so a refusal can carry a body too.
    if (outcome.status === 401 || outcome.status === 403) {
      console.debug(`webworker tunnel: route lane refused ${method} with ${String(outcome.status)}; answering on the direct lane`)
      await this.serveDirect(original, sink)
      return
    }
    buffered.flushTo(sink)
  }

  private serveBoot(frame: TunnelRequestFrame, sink: ResponseSink): void {
    if (this.seams === undefined) throw new Error('webworker tunnel: boot payload requested before the host tree is serving')
    if (frame.method !== 'GET') {
      sink.end({ status: 405, headers: { allow: 'GET' } })
      return
    }
    const body = encoder.encode(JSON.stringify(this.seams.bootPayload()))
    sink.end({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body,
    })
  }

  private async serveDirect(frame: TunnelRequestFrame, sink: ResponseSink): Promise<void> {
    if (this.seams === undefined) throw new Error('webworker tunnel: direct fetch requested before the host tree is serving')
    const controller = new AbortController()
    this.inFlight.set(frame.id, { abort: () => { controller.abort() } })
    const headers = new Headers()
    for (const [key, value] of Object.entries(frame.headers)) {
      // Forbidden header names throw on a guarded Headers instance.
      try {
        headers.set(key, value)
      } catch {
        // The fetch handler reads no forbidden header; the route lane owns those.
      }
    }
    const request = new Request(new URL(frame.url, `http://${SYNTHETIC_HOST}`), {
      method: frame.method,
      headers,
      body: frame.body === undefined || frame.method === 'GET' || frame.method === 'HEAD' ? null : frame.body,
      signal: controller.signal,
    })
    const response = await this.seams.directFetch(request)
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => { responseHeaders[key] = value })
    // Event streams are the only responses the page consumes incrementally;
    // everything else answers as one frame, as the route lane does.
    const streamed = response.body !== null && (responseHeaders['content-type'] ?? '').startsWith('text/event-stream')
    if (!streamed) {
      const buffer = await response.arrayBuffer()
      sink.end({
        status: response.status,
        headers: responseHeaders,
        body: buffer.byteLength === 0 ? undefined : new Uint8Array(buffer),
      })
      return
    }
    sink.head(response.status, responseHeaders)
    const reader = response.body.getReader()
    this.inFlight.set(frame.id, {
      abort: () => {
        controller.abort()
        void reader.cancel().catch(() => {
          // Cancelling an already-errored stream has nothing left to release.
        })
      },
    })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        sink.chunk(value)
      }
      sink.end()
    } catch (reason) {
      sink.fail(reason instanceof Error ? reason.message : String(reason))
    } finally {
      reader.releaseLock()
    }
  }
}
