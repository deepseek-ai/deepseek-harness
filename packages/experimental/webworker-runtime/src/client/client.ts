/**
 * Page half of the postMessage tunnel. It
 * turns fetch-shaped calls into `req` frames and rebuilds Responses from the
 * worker's `res` / `res-head`+`res-chunk`+`res-end` frames, so every consumer
 * (boot payload, bundle transport, ApiClient, Typert RPC) speaks plain HTTP.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type {
  TunnelAbortFrame as AbortFrame,
  TunnelOutboundFrame as ResponseFrame,
  TunnelRequestFrame as RequestFrame,
  TunnelRequestId,
  TunnelStreamEndFrame,
  TunnelStreamErrorFrame,
  TunnelStreamUplinkEndFrame,
  TunnelStreamUplinkItemFrame,
  TunnelStreamItemFrame,
  TunnelStreamOpenFrame,
} from '../transport/frames.ts'

/** Boot payload of the tunnel bootstrap route. */
export interface BootPayload {
  /** Structured index injection table, executed by the page interpreter. */
  injections: IndexInjection[]
}

/** Fetch-shaped transport the client tree consumes. */
export type TunnelFetch = (input: URL | string, init?: RequestInit) => Promise<Response>

interface PendingUnary {
  resolve(response: Response): void
  reject(reason: Error): void
}

type LogicalStreamFrame = TunnelStreamItemFrame | TunnelStreamEndFrame | TunnelStreamErrorFrame

interface UplinkPump {
  /** Settles once the pump has stopped posting frames. */
  readonly done: Promise<void>
  /** Interrupt the pump, including a read blocked on the caller's iterator, and return that iterator at once. */
  stop(): void
}

/** One open logical stream: its downlink inbox and, once the open frame is posted, its uplink pump. */
interface LogicalStream {
  readonly inbox: LogicalStreamInbox
  pump: UplinkPump | undefined
}

interface TunnelStreamFailureMarker {
  readonly kind: 'remote' | 'carrier'
  readonly code?: string
  readonly details?: object
}

/** Error carrying stream semantics across independently bundled Client code. */
class TunnelLogicalStreamError extends Error {
  readonly dshRemoteStreamFailure: TunnelStreamFailureMarker

  constructor(failure: TunnelStreamErrorFrame['failure'], options?: ErrorOptions) {
    super(failure.message, options)
    this.name = 'TunnelLogicalStreamError'
    this.dshRemoteStreamFailure = failure.kind === 'remote'
      ? { kind: 'remote', code: failure.code, details: failure.details }
      : { kind: 'carrier' }
  }
}

class LogicalStreamInbox {
  private readonly frames: LogicalStreamFrame[] = []
  private wake: (() => void) | undefined
  private failed = false
  private failure: unknown

  push(frame: LogicalStreamFrame): void {
    if (this.failed) return
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  fail(reason: unknown): void {
    if (this.failed) return
    this.failed = true
    this.failure = reason
    this.frames.length = 0
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<LogicalStreamFrame> {
    while (this.frames.length === 0) {
      if (this.failed) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    return this.frames.shift() as LogicalStreamFrame
  }
}

/**
 * Statuses the worker only produces when the host refused the exchange rather than
 * answered it; a route's own 4xx is the tree talking and stays silent here.
 */
const REFUSAL_STATUS = 500

const encoder = new TextEncoder()
const SOURCE_MAP_TRAILER = /\/\/# sourceMappingURL=([^\r\n]+)\s*$/
const BASE64_CHUNK_BYTES = 32 * 1024

/** Encode UTF-8 text for an inline data URL without a call-stack-sized spread. */
function base64(value: string): string {
  const bytes = encoder.encode(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  }
  return btoa(binary)
}

/** Replace a tunnel-only map reference with a self-contained Base64 data URL. */
async function localizeSourceMap(source: string, bundleUrl: string, fetch: TunnelFetch): Promise<string> {
  const match = SOURCE_MAP_TRAILER.exec(source)
  if (match?.[1] === undefined) return source
  try {
    const response = await fetch(new URL(match[1], new URL(bundleUrl, globalThis.location.origin)))
    if (!response.ok) return source.replace(SOURCE_MAP_TRAILER, '')
    const dataUrl = `data:application/json;charset=utf-8;base64,${base64(await response.text())}`
    return source.replace(SOURCE_MAP_TRAILER, `//# sourceMappingURL=${dataUrl}`)
  } catch {
    // A source map is diagnostic-only; its transport failure must not prevent
    // the plugin factory from registering.
    return source.replace(SOURCE_MAP_TRAILER, '')
  }
}

/** Keep opaque Blobs and transferable streams intact; normalize other bodies to bytes. */
function toTunnelBody(
  body: RequestInit['body'],
): ArrayBuffer | Blob | ReadableStream<Uint8Array> | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return encoder.encode(body).buffer
  if (body instanceof Blob) return body
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>
  if (body instanceof ArrayBuffer) return body
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
  throw new Error(`web-preview tunnel: unsupported request body ${Object.prototype.toString.call(body)}`)
}

/** Statuses whose Response must carry a null body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

/** The page half of the tunnel: one `fetch`-shaped face over `postMessage`. */
export class WorkerTunnel {
  private readonly worker: Worker
  private nextId = 1
  private readonly unary = new Map<TunnelRequestId, PendingUnary>()
  private readonly bodyStreams = new Map<TunnelRequestId, ReadableStreamDefaultController<Uint8Array>>()
  private readonly logicalStreams = new Map<TunnelRequestId, LogicalStream>()
  /**
   * In-flight request descriptions, so a refusal names what was refused.
   *
   * A tunnel failure and a failure inside the host tree look identical from the
   * page — both surface as one rejected fetch — and the acceptance run keeps the
   * page console but not the frames. Warning here separates the two without
   * recording anything on the normal path, where no refusal frame ever arrives.
   */
  private readonly inFlight = new Map<TunnelRequestId, string>()

  /** Body-phase abort listeners, released when their stream settles. */
  private readonly releases = new Map<TunnelRequestId, () => void>()

  /**
   * Attach to a spawned worker and start consuming response frames.
   * @param worker - the host worker.
   */
  constructor(worker: Worker) {
    this.worker = worker
    worker.addEventListener('message', (event: MessageEvent<ResponseFrame>) => {
      this.receive(event.data)
    })
    worker.addEventListener('error', (event) => {
      const reason = new Error(`web-preview tunnel: worker failed: ${event.message}`)
      for (const id of this.inFlight.keys()) this.warnRefusal(id, `worker failed: ${event.message}`)
      this.inFlight.clear()
      for (const pending of this.unary.values()) pending.reject(reason)
      this.unary.clear()
      for (const controller of this.bodyStreams.values()) controller.error(reason)
      this.bodyStreams.clear()
      const failure = new TunnelLogicalStreamError({
        kind: 'carrier',
        message: `web-preview tunnel: worker failed: ${event.message}`,
      }, { cause: reason })
      for (const { inbox } of this.logicalStreams.values()) inbox.fail(failure)
      this.logicalStreams.clear()
      for (const release of this.releases.values()) release()
      this.releases.clear()
    })
  }

  /**
   * Open the tunnel: the worker assembles its host from this frame.
   * @param image - VFS image URL the worker fetches.
   * @param overlays - Ordered data overlay URLs applied before boot.
   */
  init(image: string, overlays: readonly string[] = []): void {
    this.worker.postMessage({ t: 'init', image, overlays })
  }

  /** Fetch-shaped entry: one request frame, one Response (streamed when the worker streams). */
  readonly fetch: TunnelFetch = async (input, init) => {
    const signal = init?.signal
    // Checked before any frame leaves: a request the caller already abandoned
    // must not reach the worker, where a write-shaped route would still run.
    if (signal?.aborted === true) throw new DOMException('The operation was aborted.', 'AbortError')
    const id = this.nextId++
    const body = init?.body === undefined || init.body === null ? undefined : toTunnelBody(init.body)
    const frame: RequestFrame = {
      t: 'req',
      id,
      method: init?.method ?? 'GET',
      url: new URL(input, globalThis.location.origin).toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(body === undefined ? {} : { body }),
    }
    const response = new Promise<Response>((resolve, reject) => {
      this.unary.set(id, { resolve, reject })
    })
    this.inFlight.set(id, `${frame.method} ${frame.url}`)
    if (body instanceof ReadableStream) this.worker.postMessage(frame, [body])
    else this.worker.postMessage(frame)
    if (signal === undefined || signal === null) return await response
    const raced = this.rejectOnAbort(id, signal)
    try {
      const settled = await Promise.race([response, raced.rejected])
      // A streaming response outlives its head: hand the signal to the body
      // phase, so a later stop still ends the stream and reaches the worker.
      if (this.bodyStreams.has(id)) this.observeStreamAbort(id, signal)
      return settled
    } finally {
      raced.release()
    }
  }

  /**
   * Open one decoded Gateway Remote stream over the worker-local carrier.
   * @param endpoint - canonical Gateway Remote endpoint.
   * @param payload - decoded endpoint payload.
   * @param signal - logical-stream cancellation.
   * @param uplink - the stream's uplink, posted as `stream-uplink-item` frames and closed with `stream-uplink-end`.
   * @returns decoded stream values from the worker Host.
   */
  async *open(endpoint: string, payload: unknown, signal: AbortSignal, uplink?: AsyncIterable<unknown>): AsyncGenerator {
    signal.throwIfAborted()
    const id = this.nextId++
    const inbox = new LogicalStreamInbox()
    const stream: LogicalStream = { inbox, pump: undefined }
    let opened = false
    let terminal = false
    const onAbort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    this.logicalStreams.set(id, stream)
    this.inFlight.set(id, `STREAM ${endpoint}`)
    try {
      const frame: TunnelStreamOpenFrame = { t: 'stream-open', id, endpoint, payload }
      try {
        this.worker.postMessage(frame)
        opened = true
      } catch (cause) {
        throw new TunnelLogicalStreamError({
          kind: 'carrier',
          message: `web-preview tunnel: failed to open Remote stream ${endpoint}`,
        }, { cause })
      }
      if (uplink !== undefined) stream.pump = this.pumpUplink(id, uplink, signal, inbox)
      while (true) {
        const response = await inbox.next()
        signal.throwIfAborted()
        if (response.t === 'stream-item') {
          yield response.value
          continue
        }
        terminal = true
        if (response.t === 'stream-error') throw new TunnelLogicalStreamError(response.failure)
        return
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.logicalStreams.delete(id)
      this.inFlight.delete(id)
      stream.pump?.stop()
      if (opened && !terminal) this.abortWorkerOperation(id)
      if (stream.pump !== undefined) await stream.pump.done
    }
  }

  /**
   * Post the caller's uplink items for one logical stream. A failing uplink
   * fails the downlink, and the enclosing `open` then aborts the worker side.
   * `stop()` interrupts a pump blocked on `uplink.next()` and returns the
   * caller's iterator at once, so a handle's queue closes and `send()` throws
   * from then on; a generator blocked in `next()` completes that return only
   * once it yields, so it is not awaited.
   */
  private pumpUplink(
    id: TunnelRequestId,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
    inbox: LogicalStreamInbox,
  ): UplinkPump {
    const interrupt = Promise.withResolvers<IteratorReturnResult<undefined>>()
    const iterator = uplink[Symbol.asyncIterator]()
    const state = { active: true, released: false }
    const release = (): void => {
      if (state.released) return
      state.released = true
      void Promise.resolve(iterator.return?.()).catch(() => undefined)
    }
    const done = this.forwardUplink(id, iterator, interrupt.promise, () => state.active && !signal.aborted)
      .then((exhausted) => { state.released ||= exhausted }, (error: unknown) => { inbox.fail(error) })
      .then(release)
    return {
      done,
      stop: () => {
        state.active = false
        interrupt.resolve({ value: undefined, done: true })
        release()
      },
    }
  }

  /**
   * Post items until the caller's iterator ends, the pump is stopped, or the page aborts the stream.
   * @returns whether the caller's iterator was exhausted and the uplink end posted.
   */
  private async forwardUplink(
    id: TunnelRequestId,
    iterator: AsyncIterator<unknown>,
    interrupt: Promise<IteratorReturnResult<undefined>>,
    isActive: () => boolean,
  ): Promise<boolean> {
    for (;;) {
      const next = await Promise.race([iterator.next(), interrupt])
      if (!isActive()) return false
      if (next.done === true) break
      this.worker.postMessage({ t: 'stream-uplink-item', id, value: next.value } satisfies TunnelStreamUplinkItemFrame)
    }
    this.worker.postMessage({ t: 'stream-uplink-end', id } satisfies TunnelStreamUplinkEndFrame)
    return true
  }

  /**
   * Read the pre-cordis boot payload (the injection table).
   * @returns The payload the page applies before the client tree loads.
   */
  async bootPayload(): Promise<BootPayload> {
    const response = await this.fetch('/__boot__')
    if (!response.ok) {
      throw new Error(`web-preview tunnel: boot payload failed with HTTP ${String(response.status)}: ${await response.text()}`)
    }
    return await response.json() as BootPayload
  }

  /**
   * `loadBundle` seam: take one client bundle through the tunnel and execute it
   * as a classic script, exactly like the shell's same-origin `<script src>`.
   * The image packs each bundle with a trailing `sourceURL` naming its image
   * path, so the blob shows under that name in the debugger instead of as an
   * anonymous blob entry.
   * @param url - Graph combo reference (`plugins/??<id>/client.js&rev=...`), which
   * this tunnel resolves against the page origin it maps from.
   */
  async loadBundle(url: string): Promise<void> {
    const response = await this.fetch(url)
    if (!response.ok) {
      throw new Error(`web-preview tunnel: bundle ${url} failed with HTTP ${String(response.status)}`)
    }
    const source = await localizeSourceMap(await response.text(), url, this.fetch)
    const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      await new Promise<void>((resolve, reject) => {
        const el = document.createElement('script')
        el.src = blob
        el.addEventListener('load', () => {
          el.remove()
          resolve()
        }, { once: true })
        el.addEventListener('error', () => {
          el.remove()
          reject(new Error(`web-preview tunnel: bundle ${url} failed to execute`))
        }, { once: true })
        document.head.append(el)
      })
    } finally {
      URL.revokeObjectURL(blob)
    }
  }

  private rejectOnAbort(id: TunnelRequestId, signal: AbortSignal): { rejected: Promise<never>; release: () => void } {
    let release = (): void => {}
    const rejected = new Promise<never>((_resolve, reject) => {
      const fail = (): void => { reject(this.abortRequest(id)) }
      if (signal.aborted) {
        fail()
        return
      }
      signal.addEventListener('abort', fail, { once: true })
      // A completed request must not leave its listener on a long-lived
      // signal, where every further request would pile another one on.
      release = () => { signal.removeEventListener('abort', fail) }
    })
    return { rejected, release }
  }

  /**
   * Tear down one request the page abandoned: the maps forget it, the worker
   * is told, and a live body stream errors for its reader.
   * @param id - request id being abandoned.
   * @returns The abort error the caller surfaces.
   */
  private abortRequest(id: TunnelRequestId): DOMException {
    this.unary.delete(id)
    const controller = this.bodyStreams.get(id)
    this.bodyStreams.delete(id)
    this.inFlight.delete(id)
    this.releases.delete(id)
    this.abortWorkerOperation(id)
    const reason = new DOMException('The operation was aborted.', 'AbortError')
    controller?.error(reason)
    return reason
  }

  /**
   * Hold the caller's signal over the body phase: the head settled, so
   * {@link rejectOnAbort}'s listener is about to go, but a stop must still
   * end the stream. Released when the stream settles.
   * @param id - request id whose body is still crossing.
   * @param signal - the caller's signal.
   */
  private observeStreamAbort(id: TunnelRequestId, signal: AbortSignal): void {
    const onAbort = (): void => { this.abortRequest(id) }
    signal.addEventListener('abort', onAbort, { once: true })
    this.releases.set(id, () => { signal.removeEventListener('abort', onAbort) })
  }

  /** Release a body-phase abort listener a settled stream no longer needs. */
  private releaseSignal(id: TunnelRequestId): void {
    const release = this.releases.get(id)
    this.releases.delete(id)
    release?.()
  }

  /** Cancel a stream the consumer stopped reading (the head already resolved). */
  private cancelStream(id: TunnelRequestId): void {
    this.releaseSignal(id)
    this.bodyStreams.delete(id)
    this.inFlight.delete(id)
    this.abortWorkerOperation(id)
  }

  /** Best-effort cancellation: a failed worker cannot receive the frame anyway. */
  private abortWorkerOperation(id: TunnelRequestId): void {
    const abort: AbortFrame = { t: 'abort', id }
    try {
      this.worker.postMessage(abort)
    } catch {
      // The operation is already locally terminal; worker failure is reported by its owning path.
    }
  }

  /**
   * Report a refusal on the page console, where the acceptance run already keeps it.
   *
   * The prefix names the reporter, not the culprit: a 5xx can equally come from a
   * handler inside the host tree. The message text decides — the worker expands
   * nested causes into it, and its deepest layer is where the failure was thrown.
   * @param id - request id the frame answers.
   * @param outcome - what came back instead of a reply.
   */
  private warnRefusal(id: TunnelRequestId, outcome: string): void {
    console.warn(`web-preview tunnel: request ${String(id)} ${this.inFlight.get(id) ?? '(unknown request)'} → ${outcome}`)
  }

  private receive(frame: ResponseFrame): void {
    switch (frame.t) {
      case 'res': {
        const pending = this.unary.get(frame.id)
        if (pending === undefined) return
        if (frame.status >= REFUSAL_STATUS) {
          this.warnRefusal(frame.id, `HTTP ${String(frame.status)}${frame.message === undefined ? '' : `: ${frame.message}`}`)
        }
        this.unary.delete(frame.id)
        this.inFlight.delete(frame.id)
        const body = NULL_BODY_STATUS.has(frame.status)
          ? null
          : frame.body ?? frame.message ?? null
        pending.resolve(new Response(body, { status: frame.status, headers: frame.headers }))
        return
      }
      case 'res-head': {
        const pending = this.unary.get(frame.id)
        if (pending === undefined) return
        this.unary.delete(frame.id)
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.bodyStreams.set(frame.id, controller)
          },
          cancel: () => {
            this.cancelStream(frame.id)
          },
        })
        pending.resolve(new Response(stream, { status: frame.status, headers: frame.headers }))
        return
      }
      case 'res-chunk': {
        this.bodyStreams.get(frame.id)?.enqueue(new Uint8Array(frame.chunk))
        return
      }
      case 'res-end': {
        const controller = this.bodyStreams.get(frame.id)
        if (controller === undefined) return
        this.bodyStreams.delete(frame.id)
        this.inFlight.delete(frame.id)
        this.releaseSignal(frame.id)
        controller.close()
        return
      }
      case 'res-err': {
        const reason = new Error(`web-preview tunnel: ${frame.message}`)
        this.warnRefusal(frame.id, `res-err: ${frame.message}`)
        const pending = this.unary.get(frame.id)
        this.inFlight.delete(frame.id)
        if (pending !== undefined) {
          this.unary.delete(frame.id)
          pending.reject(reason)
          return
        }
        const controller = this.bodyStreams.get(frame.id)
        if (controller === undefined) return
        this.bodyStreams.delete(frame.id)
        this.releaseSignal(frame.id)
        controller.error(reason)
        return
      }
      case 'stream-item':
      case 'stream-end':
      case 'stream-error': {
        const stream = this.logicalStreams.get(frame.id)
        if (stream === undefined) return
        stream.inbox.push(frame)
        // A terminal frame ends the uplink now, not on the consumer's next read.
        if (frame.t !== 'stream-item') stream.pump?.stop()
        return
      }
      default: {
        const unknown: never = frame
        throw new Error(`web-preview tunnel: unknown frame ${JSON.stringify(unknown)}`)
      }
    }
  }
}
