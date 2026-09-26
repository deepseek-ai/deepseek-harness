/**
 * `node:stream` compatibility backed by readable-stream's browser build.
 *
 * readable-stream is the userland copy of Node's stream implementation. The
 * worker owns only platform adapters such as VFS file streams; stream state,
 * backpressure, async iteration, abort handling, and event ordering stay in
 * that maintained implementation.
 */
import Stream from 'readable-stream'

type StreamRuntime = typeof import('node:stream') & {
  compose(...streams: unknown[]): unknown
  destroy(stream: unknown, error?: Error): void
  isDisturbed(stream: unknown): boolean
}

type StreamStatics = typeof import('node:stream').Stream & {
  getDefaultHighWaterMark(objectMode: boolean): number
  isDestroyed(stream: unknown): boolean | null
  isWritable(stream: unknown): boolean | null
  setDefaultHighWaterMark(objectMode: boolean, value: number): void
}

const nodeStream = Stream as unknown as StreamRuntime

/* oxlint-disable typescript/unbound-method -- readable-stream's namespace statics do not read `this`. */
const {
  Duplex, PassThrough, Readable, Stream: StreamBase, Transform, Writable,
  addAbortSignal, compose, destroy, finished, isDisturbed, isErrored, isReadable, pipeline, promises,
} = nodeStream
const streamStatics = StreamBase as StreamStatics
const {
  getDefaultHighWaterMark, isDestroyed, isWritable, setDefaultHighWaterMark,
} = streamStatics
/* oxlint-enable typescript/unbound-method */

// readable-stream tracks Node 18's 16 KiB byte default; this repository runs
// Node 22+, whose generic and file streams use 64 KiB.
if (getDefaultHighWaterMark(false) !== 64 * 1024) setDefaultHighWaterMark(false, 64 * 1024)

/**
 * Test whether a value is an ArrayBuffer view.
 * @param value - Candidate value.
 * @returns Whether the value is a typed-array or DataView instance.
 */
const _isArrayBufferView = (value: unknown): value is ArrayBufferView => ArrayBuffer.isView(value)

/** Default-import namespace carrying Node's stream class and static helpers. */
const streamDefault = Object.assign(StreamBase, {
  _isArrayBufferView,
  getDefaultHighWaterMark,
  isDestroyed,
  isWritable,
  setDefaultHighWaterMark,
})

export {
  Duplex,
  PassThrough,
  Readable,
  StreamBase as Stream,
  Transform,
  Writable,
  addAbortSignal,
  compose,
  destroy,
  finished,
  getDefaultHighWaterMark,
  _isArrayBufferView,
  isDestroyed,
  isDisturbed,
  isErrored,
  isReadable,
  isWritable,
  pipeline,
  promises,
  setDefaultHighWaterMark,
}

/** CommonJS interop marker consumed by the worker module loader. */
export const __esModule = true

/** CommonJS-compatible namespace for default imports. */
export default streamDefault
