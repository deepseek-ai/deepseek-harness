/**
 * Length-prefixed `node:v8` frames shared by the execution environment service and its daemon, and the hash that names
 * a run's definition on both sides. A message whose encoding exceeds the frame limit travels as `part` frames that the
 * receiver reassembles; parts of different messages may interleave, and the messages a peer sends as parts at one time
 * fit the message limit together.
 */

import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { types } from 'node:util'
import { deserialize, serialize } from 'node:v8'
import { z } from 'zod'
import type { EnvironmentRemoteFailure } from './types.ts'

/** Wire version checked by the `auth` request that opens every connection. */
export const ENVIRONMENT_PROTOCOL_VERSION = 3

/**
 * Smallest `maxFrameBytes` and `maxMessageBytes` a connection accepts, so that every `part` frame carries message bytes
 * and every handshake message fits.
 */
export const MIN_LIMIT_BYTES = 1024

/**
 * Bounds a daemon applies to a connection until its `auth` request sets the host's limits:
 * one small outstanding request.
 */
export const HANDSHAKE_LIMITS: RpcLimits = { maxFrameBytes: 64 * 1024, maxMessageBytes: 64 * 1024, maxPending: 1, cancelGraceMs: 10_000 }

/** What a `run` request names by hash and a daemon keeps per connection: a function source and its origin method names. */
export interface RunDefinition {
  /** Source text of the function. */
  readonly source: string
  /** Names of the `env.origin` methods its runs expose, in order. */
  readonly methods: readonly string[]
}

/**
 * Name a definition on a connection; the host and the daemon compute it alike.
 * @param definition - function source and origin method names.
 * @returns the SHA-256 hex digest of the JSON encoding of `[source, methods]`, which differs between definitions whose
 * source or method names differ.
 */
export function definitionHash(definition: RunDefinition): string {
  return createHash('sha256').update(JSON.stringify([definition.source, definition.methods])).digest('hex')
}

const positive = z.number().int().positive()
const failureSchema = z.object({ name: z.string(), message: z.string(), code: z.string().optional() }).strict()
const messages = [
  z.object({ type: z.literal('request'), id: positive, method: z.string(), params: z.unknown() }).strict(),
  z.object({ type: z.literal('result'), id: positive, value: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), id: positive, error: failureSchema }).strict(),
] as const
/** A request or its answer, sent as one frame or reassembled from `part` frames. */
const messageSchema = z.discriminatedUnion('type', messages)
const frameSchema = z.discriminatedUnion('type', [
  ...messages,
  z.object({ type: z.literal('cancel'), id: positive }).strict(),
  // One slice of a message encoding of `size` bytes; `reply` marks an answer to the receiver's request `id`.
  z.object({ type: z.literal('part'), id: positive, reply: z.boolean(), size: positive, data: z.instanceof(Uint8Array) }).strict(),
])
type Message = z.infer<typeof messageSchema>
type Frame = z.infer<typeof frameSchema>

let partOverhead: number | undefined

/**
 * Bytes of a `part` frame besides its data, for the largest id and size and a five-byte data length. Measured on first
 * use, so importing this module encodes nothing.
 * @returns the byte count.
 */
function partOverheadBytes(): number {
  partOverhead ??= serialize({ type: 'part', id: Number.MAX_SAFE_INTEGER, reply: false, size: Number.MAX_SAFE_INTEGER, data: new Uint8Array(0) }).length + 4
  return partOverhead
}

/**
 * Smallest data of a `part` frame other than the last part of its message. Senders fill each frame, which holds at
 * least {@link MIN_LIMIT_BYTES}, so a message travels in a bounded number of parts.
 * @returns the byte count.
 */
export function minPartBytes(): number {
  return MIN_LIMIT_BYTES - partOverheadBytes()
}

const CANCELLED = 'Execution environment request cancelled by its caller'

/**
 * Serve one request from the other peer.
 * @param method - requested operation name.
 * @param params - unvalidated parameters, as structured clone delivers them.
 * @param signal - aborts when the requester cancels or the connection closes.
 * @returns a value structured clone supports; `undefined` is preserved.
 */
export type RpcHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>

/** Bounds applied to every frame, every message and to concurrently served requests. */
export interface RpcLimits {
  /**
   * Largest frame payload, without its 4-byte length prefix, either peer may send or receive; at least
   * {@link MIN_LIMIT_BYTES} and at most `maxMessageBytes`.
   */
  readonly maxFrameBytes: number
  /**
   * Largest message encoding either peer may send, in one frame or as `part` frames, or reassemble, and largest total
   * of the encodings a peer sends as parts at one time; at least {@link MIN_LIMIT_BYTES}.
   */
  readonly maxMessageBytes: number
  /** Largest number of outstanding requests in each direction. */
  readonly maxPending: number
  /** Time the other peer has to answer a cancelled request before this peer closes the connection. */
  readonly cancelGraceMs: number
}

/**
 * The other peer reported a failure for one request. `name`, `message` and `code` are those of the error its handler
 * threw, so the requester sees that error's identity.
 */
export class RemoteRequestError extends Error {
  /** The remote error's string `code`, such as an errno name or a `HarnessError` code. */
  declare readonly code?: string

  /** @param failure - the remote error's name, message and optional code. */
  constructor(failure: z.infer<typeof failureSchema>) {
    super(failure.message)
    this.name = failure.name
    if (failure.code !== undefined) this.code = failure.code
  }
}

/** A request was refused because the peer had already closed; it was never sent. */
export class RpcNotSentError extends Error {
  override name = 'RpcNotSentError'
}

/** The other peer closed its stream at a frame boundary. */
export class RpcDisconnectedError extends Error {
  override name = 'RpcDisconnectedError'
  constructor() {
    super('Execution environment peer disconnected; the outcome of pending requests is unknown')
  }
}

/**
 * Normalize a rejection, including errors created in another realm such as a `node:vm` context.
 * @param error - any thrown value.
 * @returns the value itself when it is a native error, otherwise an Error with its text.
 */
export function asError(error: unknown): Error {
  return types.isNativeError(error) ? error : new Error(String(error))
}

/** Fields of a thrown error as code can set them: any value, not only the strings its type declares. */
export interface ThrownFields {
  readonly name: unknown
  readonly message: unknown
  readonly code?: unknown
}

/**
 * Describe a thrown value for an error frame. Handlers can throw any value, including one whose fields are not strings
 * or cannot be read, so describing never fails.
 * @param error - any thrown value, including errors created in another realm.
 * @returns its name and message as strings, and its `code` when that is a string.
 */
/** Bytes an error frame needs besides its name and message, with room to spare. */
const ERROR_FRAME_FIELDS = 128

function failureOf(error: unknown): EnvironmentRemoteFailure {
  try {
    const { name, message, code }: ThrownFields = asError(error)
    const failure = { name: String(name), message: String(message) }
    return typeof code === 'string' ? { ...failure, code } : failure
  } catch {
    return { name: 'Error', message: 'Execution environment request failed with a value that cannot be described' }
  }
}

/**
 * Copy byte ranges into memory of their own: decoded typed arrays view the memory they were decoded from, which must
 * hold nothing but this frame or message.
 * @param pieces - consecutive ranges.
 * @param size - their total length.
 * @returns a buffer outside Node's shared allocation pool.
 */
function join(pieces: readonly Uint8Array[], size: number): Buffer {
  const bytes = Buffer.allocUnsafeSlow(size)
  let offset = 0
  for (const piece of pieces) {
    bytes.set(piece, offset)
    offset += piece.length
  }
  return bytes
}

/**
 * Decode one frame or reassembled message.
 * @param bytes - the encoding, in memory of its own.
 * @returns the unvalidated value.
 */
function decode(bytes: Buffer): unknown {
  try {
    return deserialize(bytes)
  } catch (error) {
    throw new Error(`Execution environment peer sent an undecodable frame: ${asError(error).message}`, { cause: error })
  }
}

/** A message whose `part` frames are still arriving. */
interface Incoming {
  readonly size: number
  received: number
  /**
   * Slices received so far; dropped once the reply's request is cancelled, after which later slices are only counted
   * and the message no longer counts toward the bytes this peer keeps.
   */
  pieces: Uint8Array[] | undefined
}

/** A message waiting until the messages its peer sends as parts leave room for it. */
interface Queued {
  readonly size: number
  readonly turn: PromiseWithResolvers<void>
}

/**
 * One symmetric request peer. A closed peer rejects every pending request and
 * aborts every served request; it never reconnects or replays a request.
 */
export class RpcPeer {
  private readonly input: Readable
  private readonly output: Writable
  private limits: RpcLimits
  private readonly handler: RpcHandler | undefined
  private readonly pending = new Map<number, PromiseWithResolvers<unknown>>()
  private readonly cancelDeadlines = new Map<number, NodeJS.Timeout>()
  /** Requests whose handler runs or whose answer is being queued; a cancellation aborts either. */
  private readonly served = new Map<number, AbortController>()
  /** The other peer's requests, and answers to this peer's requests, whose parts are still arriving. */
  private readonly partial = { request: new Map<number, Incoming>(), reply: new Map<number, Incoming>() }
  /** Total size of the partially received messages whose parts this peer keeps; at most `maxMessageBytes`. */
  private retained = 0
  /** Total size of the messages this peer is sending as parts; at most `maxMessageBytes`, which the receiver enforces. */
  private splitting = 0
  /** Messages to send as parts once `splitting` leaves room, in the order they were sent. */
  private readonly queued: Queued[] = []
  private nextId = 1
  private writeTail = Promise.resolve()
  private failure: Error | undefined
  private readonly closedWith = Promise.withResolvers<Error>()

  /** Resolves with the close reason once the peer fails or is closed. */
  readonly closed: Promise<Error> = this.closedWith.promise

  /**
   * Start reading frames from `input`.
   * @param input - frames from the other peer, as bytes.
   * @param output - frames to the other peer.
   * @param limits - frame, message and concurrency bounds.
   * @param handler - serves inbound requests; absent rejects every inbound request.
   */
  constructor(input: Readable, output: Writable, limits: RpcLimits, handler?: RpcHandler) {
    this.input = input
    this.output = output
    this.limits = limits
    this.handler = handler
    input.on('error', (error) => { this.close(error) })
    output.on('error', (error) => { this.close(error) })
    void this.read().then(
      () => { this.close(new RpcDisconnectedError()) },
      (error: unknown) => { this.close(asError(error)) },
    )
  }

  /** Whether the peer has closed; every later request rejects. */
  get failed(): boolean {
    return this.failure !== undefined
  }

  /**
   * Replace the bounds for later frames and requests, as a daemon does once `auth` has set the host's limits.
   * @param limits - the new bounds.
   */
  setLimits(limits: RpcLimits): void {
    this.limits = limits
  }

  /**
   * Send one request. Parameters that structured clone cannot copy, or whose message exceeds `maxMessageBytes`,
   * reject before the request is sent or takes a pending slot. A request cancelled while it waits to be sent as parts
   * frees its slot at once; once sent, a cancelled request keeps its slot until the other peer answers.
   * @param method - operation name served by the other peer.
   * @param params - parameters, copied by structured clone.
   * @param signal - cancellation; a cancelled request is not rolled back on the other peer.
   * @returns the unvalidated result.
   */
  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (this.failure !== undefined) throw new RpcNotSentError(this.failure.message, { cause: this.failure })
    if (this.pending.size >= this.limits.maxPending) throw new Error('Execution environment pending request limit reached')
    const id = this.nextId++
    const message: Message = { type: 'request', id, method, params }
    const payload = this.encode(message)
    const result = Promise.withResolvers<unknown>()
    this.pending.set(id, result)
    // Stops queueing the remaining parts of a cancelled request.
    const sending = new AbortController()
    let sent = false
    /* jscpd:ignore-start -- the same cancellation bookkeeping as the SSH helper peer, which owns SSH-specific
       framing, request classes and diagnostics; a shared peer package is deferred until a third consumer exists. */
    // A cancelled id keeps its slot until the other peer settles it, so both peers count the same requests.
    const abort = (event: Event): void => {
      // A reply can arrive between settlement and listener removal; only an outstanding request is cancelled.
      /* v8 ignore next -- needs an abort between reply delivery and the request's own continuation. */
      if (this.pending.get(id) !== result) return
      result.reject(asError((event.target as AbortSignal).reason))
      sending.abort()
      if (!sent) {
        // The other peer has received no frame of this request, so it holds no slot for it.
        this.pending.delete(id)
        return
      }
      // Parts of the answer received so far are dropped; its remaining parts are only counted.
      const reply = this.partial.reply.get(id)
      if (reply !== undefined) this.discard(reply)
      // A peer that keeps running cancelled work would hold this slot forever; closing frees every slot.
      this.cancelDeadlines.set(id, setTimeout(() => {
        this.close(new Error(`Execution environment peer did not stop a cancelled request within ${this.limits.cancelGraceMs} ms`))
      }, this.limits.cancelGraceMs))
      this.post({ type: 'cancel', id })
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      void this.transmit(message, payload, sending.signal, () => { sent = true }).catch(() => {
        // The request was cancelled, which frees or keeps its slot as `abort` decided, or the peer closed and rejected it.
      })
      return await result.promise
    } finally {
      signal?.removeEventListener('abort', abort)
      /* jscpd:ignore-end */
    }
  }

  /**
   * Reject pending requests, abort served requests, drop partially received messages and destroy both streams. Idempotent.
   * @param error - the reason reported to every pending request.
   */
  close(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const deadline of this.cancelDeadlines.values()) clearTimeout(deadline)
    this.cancelDeadlines.clear()
    for (const controller of this.served.values()) controller.abort(error)
    this.served.clear()
    this.partial.request.clear()
    this.partial.reply.clear()
    this.retained = 0
    for (const { turn } of this.queued.splice(0)) turn.reject(error)
    this.input.destroy()
    this.output.destroy()
    this.closedWith.resolve(error)
  }

  /**
   * Encode a request or answer.
   * @param message - the message.
   * @returns its encoding; throws when structured clone cannot copy a value or the encoding exceeds `maxMessageBytes`.
   */
  private encode(message: Message): Buffer {
    let payload: Buffer
    try {
      payload = serialize(message)
    } catch (error) {
      throw new Error(`Execution environment cannot send a value that structured clone does not support: ${asError(error).message}`, { cause: error })
    }
    const { maxMessageBytes } = this.limits
    if (payload.length > maxMessageBytes) throw new Error(`Execution environment message of ${payload.length} bytes exceeds maxMessageBytes (${maxMessageBytes})`)
    return payload
  }

  /**
   * Queue an encoded message as one frame, or as `part` frames when it exceeds `maxFrameBytes`. A message sent as parts
   * first waits until the messages this peer is sending as parts leave room for it within `maxMessageBytes`.
   * @param message - the message, for the id and direction of its parts.
   * @param payload - its encoding.
   * @param signal - stops waiting and queueing further parts.
   * @param started - called as the message's first frame is queued.
   * @returns settles once the last frame is queued; rejects when the signal or the closing peer stops it first.
   */
  private async transmit(message: Message, payload: Buffer, signal: AbortSignal, started?: () => void): Promise<void> {
    const { maxFrameBytes } = this.limits
    if (payload.length <= maxFrameBytes) {
      started?.()
      void this.write(payload)
      return
    }
    signal.throwIfAborted()
    const waiting = this.reserve(payload.length, signal)
    if (waiting !== undefined) await waiting
    try {
      const part = { type: 'part', id: message.id, reply: message.type !== 'request', size: payload.length } as const
      // Limits below MIN_LIMIT_BYTES yield parts the receiver refuses rather than an endless loop.
      const room = Math.max(1, maxFrameBytes - partOverheadBytes())
      for (let offset = 0; offset < payload.length; offset += room) {
        signal.throwIfAborted()
        if (this.failure !== undefined) throw this.failure
        if (offset === 0) started?.()
        const written = this.write(serialize({ ...part, data: payload.subarray(offset, offset + room) }))
        // Waiting for each part lets frames of other messages in between and follows the stream's backpressure.
        if (offset + room < payload.length) await written
      }
    } finally {
      // A stopped message's cancellation is queued already; a stopped answer is no longer kept by its receiver.
      this.splitting -= payload.length
      this.admitQueued()
    }
  }

  /**
   * Take room for a message to send as parts, in the order messages arrive.
   * @param size - the message's encoding size.
   * @param signal - stops waiting.
   * @returns undefined when the room is taken at once, otherwise settles once it is taken; rejects when the signal or
   * the closing peer stops the wait.
   */
  private reserve(size: number, signal: AbortSignal): Promise<void> | undefined {
    if (this.queued.length === 0 && this.splitting + size <= this.limits.maxMessageBytes) {
      this.splitting += size
      return undefined
    }
    const entry: Queued = { size, turn: Promise.withResolvers<void>() }
    this.queued.push(entry)
    const abort = (): void => {
      const index = this.queued.indexOf(entry)
      // The room was taken just before the abort; the sender stops at its first part and returns it.
      /* v8 ignore next -- needs an abort between taking the room and the waiting sender's continuation. */
      if (index === -1) return
      this.queued.splice(index, 1)
      entry.turn.reject(asError(signal.reason))
      this.admitQueued()
    }
    signal.addEventListener('abort', abort, { once: true })
    return entry.turn.promise.finally(() => { signal.removeEventListener('abort', abort) })
  }

  /** Give room to the waiting messages that fit, in order. */
  private admitQueued(): void {
    const { maxMessageBytes } = this.limits
    for (let next = this.queued[0]; next !== undefined && this.splitting + next.size <= maxMessageBytes; next = this.queued[0]) {
      this.queued.shift()
      this.splitting += next.size
      next.turn.resolve()
    }
  }

  /**
   * Queue a frame that must fit in one: a cancellation, or an error answering a request. These errors come from this
   * peer and carry no code; one whose name or message would not fit keeps its start and ends with an ellipsis.
   */
  private post(frame: Frame): void {
    const payload = serialize(frame)
    if (frame.type !== 'error' || payload.length <= this.limits.maxFrameBytes) {
      void this.write(payload)
      return
    }
    // Each text takes at most two bytes per UTF-16 code unit; ERROR_FRAME_FIELDS bytes hold the rest of the frame.
    const room = Math.floor((this.limits.maxFrameBytes - ERROR_FRAME_FIELDS) / 4)
    const cut = (text: string): string => text.length <= room ? text : `${text.slice(0, room - 1)}…`
    const error = { ...frame.error, name: cut(frame.error.name), message: cut(frame.error.message) }
    void this.write(serialize({ ...frame, error }))
  }

  /**
   * Queue one frame behind earlier frames; a failed write closes the peer.
   * @param payload - the frame's encoding.
   * @returns settles once the frame is written, dropped by a closed peer, or its failure has closed the peer.
   */
  private write(payload: Buffer): Promise<void> {
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(payload.length)
    const written = this.writeTail.then(() => new Promise<void>((resolve, reject) => {
      if (this.failure !== undefined) {
        resolve()
        return
      }
      this.output.cork()
      this.output.write(header)
      this.output.write(payload, (error) => {
        if (error == null) resolve()
        else reject(error)
      })
      this.output.uncork()
    }))
    this.writeTail = written.catch((error: unknown) => { this.close(asError(error)) })
    return this.writeTail
  }

  private async read(): Promise<void> {
    const header = Buffer.alloc(4)
    let headerBytes = 0
    let size = 0
    let pieces: Uint8Array[] = []
    let received = 0
    let frames = 0
    for await (const chunk of this.input as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) throw new Error('Execution environment channel delivered text; frames need a byte stream without an encoding')
      let offset = 0
      while (offset < chunk.length) {
        if (headerBytes < 4) {
          const count = Math.min(4 - headerBytes, chunk.length - offset)
          header.set(chunk.subarray(offset, offset + count), headerBytes)
          headerBytes += count
          offset += count
          if (headerBytes === 4) size = this.frameSize(header, frames)
        } else {
          const count = Math.min(size - received, chunk.length - offset)
          pieces.push(chunk.subarray(offset, offset + count))
          received += count
          offset += count
          if (received === size) {
            const frame = frameSchema.parse(decode(join(pieces, size)))
            pieces = []
            received = 0
            headerBytes = 0
            frames++
            const { maxMessageBytes } = this.limits
            if (frame.type !== 'part' && size > maxMessageBytes) {
              throw new Error(`Execution environment peer sent a message of ${size} bytes, over maxMessageBytes (${maxMessageBytes})`)
            }
            this.receive(frame)
          }
        }
      }
    }
    if (headerBytes > 0) throw new Error('Execution environment peer disconnected during a frame; the outcome of pending requests is unknown')
  }

  /**
   * Read a frame's length.
   * @param header - its 4-byte big-endian length prefix.
   * @param frames - frames read before it on this connection.
   * @returns the payload length; throws for an empty or oversized frame, and for a peer of protocol 2 or earlier.
   */
  private frameSize(header: Buffer, frames: number): number {
    // Every frame of protocol 2 and earlier was a JSON object on one line.
    if (frames === 0 && header[0] === 0x7b) {
      throw new Error(`Execution environment peer sent newline-delimited JSON, which protocol 2 and earlier use; this peer speaks protocol ${ENVIRONMENT_PROTOCOL_VERSION}`)
    }
    const size = header.readUInt32BE(0)
    const { maxFrameBytes } = this.limits
    if (size === 0 || size > maxFrameBytes) throw new Error(`Execution environment peer sent a frame of ${size} bytes; frames hold 1 to ${maxFrameBytes} bytes`)
    return size
  }

  private receive(frame: Frame): void {
    switch (frame.type) {
      case 'part':
        this.assemble(frame)
        return
      case 'result':
      case 'error': {
        // An error also ends an answer whose remaining parts its sender stopped sending.
        this.drop(this.partial.reply, frame.id)
        const pending = this.settle(frame.id)
        if (pending === undefined) return
        if (frame.type === 'result') pending.resolve(frame.value)
        else pending.reject(new RemoteRequestError(frame.error))
        return
      }
      case 'cancel':
        // A requester that stops sending a request keeps its slot until the request is answered.
        if (this.drop(this.partial.request, frame.id)) this.post({ type: 'error', id: frame.id, error: { name: 'Error', message: CANCELLED } })
        else this.served.get(frame.id)?.abort(new Error(CANCELLED))
        return
      case 'request':
        this.serve(frame.id, frame.method, frame.params)
    }
  }

  /** Collect one `part` frame; a completed message is validated and received like a single frame. */
  private assemble({ id, reply, size, data }: Extract<Frame, { type: 'part' }>): void {
    const partial = reply ? this.partial.reply : this.partial.request
    const { maxMessageBytes } = this.limits
    let incoming = partial.get(id)
    if (incoming === undefined && size > maxMessageBytes) {
      throw new Error(`Execution environment peer sent a message of ${size} bytes, over maxMessageBytes (${maxMessageBytes})`)
    }
    const received = (incoming?.received ?? 0) + data.length
    if ((incoming !== undefined && size !== incoming.size) || received > size) throw new Error('Execution environment peer sent inconsistent message parts')
    if (received < size && data.length < minPartBytes()) {
      throw new Error(`Execution environment peer sent a part of ${data.length} bytes before the last part of its message; such parts carry at least ${minPartBytes()} bytes`)
    }
    if (incoming === undefined) {
      if (reply) {
        // Answers to no outstanding request are ignored, as their single frames are.
        if (!this.pending.has(id)) return
      } else this.admit(id)
      const kept = !reply || !this.cancelDeadlines.has(id)
      if (kept && this.retained + size > maxMessageBytes) {
        throw new Error(`Execution environment peer sent parts of messages totalling ${this.retained + size} bytes at once, over maxMessageBytes (${maxMessageBytes})`)
      }
      if (kept) this.retained += size
      incoming = { size, received: 0, pieces: kept ? [] : undefined }
      partial.set(id, incoming)
    }
    incoming.received = received
    incoming.pieces?.push(data)
    if (received < size) return
    const { pieces } = incoming
    this.drop(partial, id)
    if (pieces === undefined) {
      // The dropped answer of a cancelled request still frees its slot.
      this.settle(id)
      return
    }
    const message = messageSchema.parse(decode(join(pieces, size)))
    if (message.id !== id || (message.type !== 'request') !== reply) throw new Error('Execution environment peer sent inconsistent message parts')
    this.receive(message)
  }

  /**
   * Stop receiving a partially received message.
   * @param partial - the requests or the answers whose parts are arriving.
   * @param id - the message's request id.
   * @returns whether the message was arriving.
   */
  private drop(partial: Map<number, Incoming>, id: number): boolean {
    const incoming = partial.get(id)
    if (incoming === undefined) return false
    partial.delete(id)
    this.discard(incoming)
    return true
  }

  /** Stop keeping the parts of a partially received message; its later parts are only counted. */
  private discard(incoming: Incoming): void {
    if (incoming.pieces !== undefined) this.retained -= incoming.size
    incoming.pieces = undefined
  }

  /**
   * Release the slot and cancellation deadline of a request the other peer has answered.
   * @param id - the request.
   * @returns its resolvers, or undefined when it is not outstanding.
   */
  private settle(id: number): PromiseWithResolvers<unknown> | undefined {
    const pending = this.pending.get(id)
    if (pending === undefined) return undefined
    this.pending.delete(id)
    clearTimeout(this.cancelDeadlines.get(id))
    this.cancelDeadlines.delete(id)
    return pending
  }

  /**
   * Admit a request the other peer starts, as one frame or by its first part.
   * @param id - the request.
   * @returns the handler serving it; throws when no handler serves requests, the id is in use or the slots are full.
   */
  private admit(id: number): RpcHandler {
    const { handler, served, partial: { request } } = this
    if (handler === undefined || served.has(id) || request.has(id) || served.size + request.size >= this.limits.maxPending) {
      throw new Error('Execution environment peer sent an unexpected or excessive request')
    }
    return handler
  }

  private serve(id: number, method: string, params: unknown): void {
    const handler = this.admit(id)
    const controller = new AbortController()
    this.served.set(id, controller)
    void (async () => {
      let answer: Message
      try {
        answer = { type: 'result', id, value: await handler(method, params, controller.signal) }
      } catch (error) {
        answer = { type: 'error', id, error: failureOf(error) }
      }
      try {
        await this.transmit(answer, this.encode(answer), controller.signal)
      } catch (error) {
        // The answer cannot be cloned, exceeds maxMessageBytes, or was cancelled while its parts were queued; report that instead.
        this.post({ type: 'error', id, error: failureOf(error) })
      } finally {
        this.served.delete(id)
      }
    })()
  }
}
