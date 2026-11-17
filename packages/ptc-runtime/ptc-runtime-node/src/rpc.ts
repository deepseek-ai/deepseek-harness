/** birpc over newline-delimited JSON on the bounded private process channel. */
import { Buffer } from 'node:buffer'
import type { Duplex } from 'node:stream'
import { createBirpc, type BirpcReturn } from 'birpc'

const stringify = JSON.stringify
const parse = JSON.parse
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Connect typed methods over one control endpoint; execution owns all deadlines.
 * @param stream - Owned control endpoint; `$close()` destroys it and rejects outstanding remote calls.
 * @param maxMessageBytes - Maximum incoming JSON line and queued outgoing bytes.
 * @param functions - Only these own methods may be called by the peer.
 * @param eventNames - Remote methods sent as notifications without a response.
 * @param failure - Receives the first I/O error, peer closure or malformed-message failure after the endpoint closes.
 * @returns Typed remote calls and birpc lifetime controls.
 */
export function createProcessRpc<Remote extends object, Local extends object>(
  stream: Duplex,
  maxMessageBytes: number,
  functions: Local,
  eventNames: (keyof Remote)[],
  failure: (error: Error, kind: 'io' | 'closed' | 'protocol') => void,
): BirpcReturn<Remote, Local> {
  const fail = (error: unknown, kind: 'io' | 'closed' | 'protocol'): void => {
    if (rpc.$closed) return
    rpc.$close()
    // Streams, the JSON parser and the line checks fail only with Error objects.
    failure(error as Error, kind)
  }
  let receive: ((line: string) => void) | undefined
  const rpc = createBirpc<Remote, Local>(functions, {
    timeout: -1,
    eventNames,
    on: (listener) => { receive = listener },
    off: () => { receive = undefined; stream.destroy() },
    // JSON drops Error fields; the peer receives only the diagnostic.
    serialize: (message: { e?: unknown }) => `${stringify(message.e === undefined ? message : { ...message, e: { message: messageOf(message.e) } })}\n`,
    post: (line: string) => {
      // A binding can settle after the endpoint closes; the Writable owns already queued bytes.
      if (rpc.$closed) return
      if (stream.writableLength + Buffer.byteLength(line) > maxMessageBytes) fail(new Error(`control output exceeds ${maxMessageBytes} queued bytes`), 'protocol')
      else stream.write(line)
    },
    deserialize: (line: string) => {
      // A line that parses after the leading-brace check is a JSON object.
      const message = parse(line) as { e?: { message?: unknown } }
      if (message.e) message.e = new Error(String(message.e.message))
      return message
    },
    // Only own methods are callable, and none runs once the endpoint closes,
    // including calls that arrived in the same chunk as the closing message.
    resolver: (name, fn) => Object.hasOwn(functions, name)
      ? (...args: unknown[]) => rpc.$closed ? undefined : fn.apply(functions, args)
      : undefined,
  })
  let parts: Buffer[] = []
  let size = 0
  const buffer = (part: Buffer): void => {
    // Every message is a JSON object; another release's length-prefixed frame would otherwise wait for a newline.
    if (size === 0 && part.length > 0 && part[0] !== 0x7b) throw new Error('control message is not a JSON object; the Node bootstrap may be from another release')
    size += part.length
    if (size > maxMessageBytes) throw new Error(`RPC message exceeds ${maxMessageBytes} bytes`)
    parts.push(part)
  }
  stream.on('data', (chunk: Buffer) => {
    try {
      let start = 0
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        buffer(chunk.subarray(start, end))
        const line = Buffer.concat(parts, size).toString('utf8')
        parts = []
        size = 0
        start = end + 1
        void Promise.resolve(receive?.(line)).catch((error: unknown) => { fail(error, 'protocol') })
      }
      buffer(chunk.subarray(start))
    } catch (error: unknown) { fail(error, 'protocol') }
  })
  stream.on('end', () => {
    if (size === 0) fail(new Error('control channel ended before the program settled'), 'closed')
    else fail(new Error('incomplete RPC message'), 'protocol')
  })
  stream.on('error', (error: Error) => { fail(error, 'io') })
  stream.on('close', () => { fail(new Error('control channel closed'), 'closed') })
  return rpc
}
