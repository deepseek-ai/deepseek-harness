/**
 * `node:buffer` for the worker, backed by the `buffer` npm package (feross), and
 * the matching `globalThis.Buffer` install. Node code treats Buffer as ambient,
 * so the global must exist before any host module evaluates.
 *
 * Loading this module replaces `Buffer.from`, `Buffer.prototype.toString`, and
 * `toLocaleString` on the package's class, so every Buffer user in the Worker,
 * including bundled third-party code, gets the same conversions. Whole-buffer
 * UTF-8 conversions use `TextEncoder` and `TextDecoder` with Node's U+FFFD
 * replacement and BOM retention; other encodings and ranged `toString` calls
 * keep the package's implementation.
 */
import { Buffer, kMaxLength } from 'buffer'

const encoder = new TextEncoder()
// Node keeps a leading byte order mark in the decoded string.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
const UTF8 = /^utf-?8$/i
const packageFrom = Buffer.from.bind(Buffer) as (value: unknown, encodingOrOffset?: unknown, length?: unknown) => Buffer
const bufferPrototype = Buffer.prototype as Buffer
// oxlint-disable-next-line typescript/unbound-method -- Called with .call and a Buffer receiver.
const packageToString = bufferPrototype.toString

/** Whether an omitted or string encoding argument names UTF-8. */
function isUtf8(encoding: unknown): boolean {
  return encoding === undefined || (typeof encoding === 'string' && UTF8.test(encoding))
}

Buffer.from = function from(value: unknown, encodingOrOffset?: unknown, length?: unknown): Buffer {
  if (typeof value === 'string' && isUtf8(encodingOrOffset)) {
    const bytes = encoder.encode(value)
    return packageFrom(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return packageFrom(value, encodingOrOffset, length)
} as typeof Buffer.from

bufferPrototype.toString = function toString(this: Buffer, encoding?: BufferEncoding, start?: number, end?: number): string {
  if (start === undefined && end === undefined && isUtf8(encoding)) return decoder.decode(this)
  return packageToString.call(this, encoding, start, end)
}
// oxlint-disable-next-line typescript/unbound-method -- Installed as a Buffer method; callers supply the receiver.
Reflect.set(bufferPrototype, 'toLocaleString', bufferPrototype.toString)

Object.defineProperty(globalThis, 'Buffer', { value: Buffer, writable: true, configurable: true })

export { Buffer, kMaxLength }

/**
 * Size limits, as `node:buffer` publishes them. The npm package exposes only
 * `kMaxLength`, so the string bound is Node's own value for a 64-bit build.
 */
export const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: 536_870_888,
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** The `node:buffer` declarations this module stands in for. */
type NodeFace = Partial<typeof import('node:buffer')>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { Buffer, constants, kMaxLength } satisfies NodeFace
