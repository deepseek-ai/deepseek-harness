/**
 * LSP base-protocol framing: `Content-Length`-delimited JSON-RPC over a byte stream. The encoder
 * produces one framed buffer; the decoder buffers incoming bytes and yields complete message bodies,
 * bounding the header and total message size so a hostile or broken server cannot exhaust memory.
 * @module @deepseek-ai/dsh-lsp-stdio/framing
 */

import { LspError } from '@deepseek-ai/dsh-lsp'

/** The header/body separator in the LSP base protocol. */
const HEADER_SEPARATOR = '\r\n\r\n'

/** Cap on the header section so a server that never sends the separator cannot grow the buffer forever. */
const MAX_HEADER_BYTES = 1 << 16

/**
 * Encode one JSON-RPC message as a framed LSP buffer (`Content-Length: N\r\n\r\n<utf-8 json>`).
 * @param message - the JSON-RPC message object to serialize.
 * @returns the framed bytes ready to write to the server's stdin.
 */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * A streaming decoder for `Content-Length`-framed JSON-RPC. Feed it stdout chunks; it returns any
 * whole message bodies that completed. It parses only the `Content-Length` header and ignores other
 * headers (e.g. `Content-Type`), matching the base protocol.
 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly maxMessageBytes: number

  /**
   * @param maxMessageBytes - reject any single framed body larger than this (guards memory).
   */
  constructor(maxMessageBytes: number) {
    this.maxMessageBytes = maxMessageBytes
  }

  /**
   * Append a chunk and return every message body that is now complete.
   * @param chunk - raw bytes from the server's stdout.
   * @returns the parsed JSON bodies, in arrival order (possibly empty).
   * @throws LspError `LSP_PROTOCOL_ERROR` when a header or body is malformed, or
   *   `LSP_MESSAGE_TOO_LARGE` when a body exceeds `maxMessageBytes`.
   */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      const step = this.next()
      if (!step.ready) break
      messages.push(step.message)
    }
    return messages
  }

  /** Parse and consume the next complete message, or report that more bytes are needed. */
  private next(): { ready: false } | { ready: true; message: unknown } {
    const separator = this.buffer.indexOf(HEADER_SEPARATOR)
    if (separator < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw protocolError(`LSP header exceeded ${MAX_HEADER_BYTES} bytes without a terminator`)
      }
      return { ready: false }
    }
    if (separator > MAX_HEADER_BYTES) {
      throw protocolError(`LSP header exceeded ${MAX_HEADER_BYTES} bytes`)
    }
    const headerText = this.buffer.toString('ascii', 0, separator)
    const contentLength = parseContentLength(headerText)
    if (contentLength > this.maxMessageBytes) {
      throw new LspError(
        `LSP message length ${contentLength} exceeds the ${this.maxMessageBytes}-byte limit`,
        'LSP_MESSAGE_TOO_LARGE',
      )
    }
    const bodyStart = separator + HEADER_SEPARATOR.length
    const bodyEnd = bodyStart + contentLength
    if (this.buffer.length < bodyEnd) return { ready: false }
    const body = this.buffer.toString('utf8', bodyStart, bodyEnd)
    this.buffer = this.buffer.subarray(bodyEnd)
    try {
      return { ready: true, message: JSON.parse(body) }
    } catch (error) {
      /* v8 ignore next -- JSON.parse throws a SyntaxError (an Error); the String() fallback is defensive. */
      throw protocolError(
        `LSP message body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}

/** Read the `Content-Length` header value (case-insensitive), rejecting a missing or non-numeric one. */
function parseContentLength(headerText: string): number {
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue
    const value = Number(line.slice(colon + 1).trim())
    if (!Number.isInteger(value) || value < 0) {
      throw protocolError(`invalid Content-Length header: ${JSON.stringify(line)}`)
    }
    return value
  }
  throw protocolError(`LSP header block missing Content-Length: ${JSON.stringify(headerText)}`)
}

/** A framing failure: the server's byte stream no longer follows the LSP base protocol. */
function protocolError(message: string, options?: ErrorOptions): LspError {
  return new LspError(message, 'LSP_PROTOCOL_ERROR', options)
}
