/** Framed request and response bytes for the Electron Desktop Host transport. */

/** Protocol version shared with the Electron shell. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 3 as const

/** Child descriptor that receives Electron request frames. */
export const DESKTOP_REQUEST_PIPE_FD = 3

/** Child descriptor that emits Host response frames. */
export const DESKTOP_RESPONSE_PIPE_FD = 4

/** Maximum raw body bytes carried by one data frame. */
export const DESKTOP_PIPE_CHUNK_BYTES = 64 * 1024

const FRAME_MAGIC = 0x44534833
const FRAME_HEADER_BYTES = 13
const MAX_CONTROL_PAYLOAD_BYTES = 1024 * 1024

const REQUEST_FRAME_START = 1
const REQUEST_FRAME_DATA = 2
const REQUEST_FRAME_END = 3
const REQUEST_FRAME_CANCEL = 4

const RESPONSE_FRAME_START = 1
const RESPONSE_FRAME_DATA = 2
const RESPONSE_FRAME_END = 3
const RESPONSE_FRAME_ERROR = 4
type ResponseFrameType = typeof RESPONSE_FRAME_START | typeof RESPONSE_FRAME_DATA
  | typeof RESPONSE_FRAME_END | typeof RESPONSE_FRAME_ERROR

/** One validated request-pipe frame. */
export type DesktopHostRequestFrame = {
  readonly type: 'start'
  readonly streamId: number
  readonly url: string
  readonly method: string
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
} | {
  readonly type: 'data'
  readonly streamId: number
  readonly data: Buffer
} | {
  readonly type: 'end' | 'cancel'
  readonly streamId: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHeaders(value: unknown): value is readonly [string, string][] {
  return Array.isArray(value) && value.every(header => Array.isArray(header) && header.length === 2
    && typeof header[0] === 'string' && typeof header[1] === 'string')
}

function assertStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffff_ffff) {
    throw new Error(`dsh desktop: invalid pipe stream id ${String(streamId)}`)
  }
}

function encodeFrame(type: ResponseFrameType, streamId: number, payload: Buffer): Buffer {
  assertStreamId(streamId)
  const limit = type === RESPONSE_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
  if (payload.byteLength > limit) {
    throw new Error(`dsh desktop: response pipe frame exceeds the ${String(limit)}-byte limit`)
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(FRAME_MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(streamId, 5)
  frame.writeUInt32BE(payload.byteLength, 9)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

function encodeJsonFrame(type: ResponseFrameType, streamId: number, value: unknown): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(value), 'utf8'))
}

/** Encode response metadata before any body frames. */
export function encodeDesktopResponseStart(
  streamId: number,
  response: {
    readonly status: number
    readonly headers: readonly [string, string][]
    readonly hasBody: boolean
  },
): Buffer {
  return encodeJsonFrame(RESPONSE_FRAME_START, streamId, response)
}

/** Encode one bounded raw response-body chunk. */
export function encodeDesktopResponseData(streamId: number, data: Uint8Array): Buffer {
  return encodeFrame(RESPONSE_FRAME_DATA, streamId, Buffer.from(data))
}

/** Encode normal response completion. */
export function encodeDesktopResponseEnd(streamId: number): Buffer {
  return encodeFrame(RESPONSE_FRAME_END, streamId, Buffer.alloc(0))
}

/** Encode one response failure without exposing an Error object across processes. */
export function encodeDesktopResponseError(streamId: number, message: string): Buffer {
  return encodeJsonFrame(RESPONSE_FRAME_ERROR, streamId, { message })
}

/** Incrementally decode validated request frames from the Electron byte pipe. */
export class DesktopHostRequestDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * Append bytes and return every complete request frame.
   * @param chunk - next bytes read from the Electron request pipe.
   * @returns complete frames in pipe order.
   */
  push(chunk: Buffer): DesktopHostRequestFrame[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: DesktopHostRequestFrame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === undefined) return frames
      frames.push(frame)
    }
  }

  /** Reject EOF that splits a frame. */
  finish(): void {
    if (this.buffer.byteLength !== 0) throw new Error('dsh desktop: Electron request pipe ended inside a frame')
  }

  private next(): DesktopHostRequestFrame | undefined {
    if (this.buffer.byteLength < FRAME_HEADER_BYTES) return undefined
    if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('dsh desktop: invalid Electron request frame marker')
    const rawType = this.buffer.readUInt8(4)
    const streamId = this.buffer.readUInt32BE(5)
    const payloadLength = this.buffer.readUInt32BE(9)
    assertStreamId(streamId)
    const limit = rawType === REQUEST_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
    if (payloadLength > limit) {
      throw new Error(`dsh desktop: Electron request frame exceeds the ${String(limit)}-byte limit`)
    }
    const frameLength = FRAME_HEADER_BYTES + payloadLength
    if (this.buffer.byteLength < frameLength) return undefined
    const payload = this.buffer.subarray(FRAME_HEADER_BYTES, frameLength)
    this.buffer = this.buffer.subarray(frameLength)
    switch (rawType) {
      case REQUEST_FRAME_START:
        return this.parseStart(streamId, payload)
      case REQUEST_FRAME_DATA:
        return { type: 'data', streamId, data: payload }
      case REQUEST_FRAME_END:
        if (payloadLength !== 0) throw new Error('dsh desktop: Electron request end frame carried a payload')
        return { type: 'end', streamId }
      case REQUEST_FRAME_CANCEL:
        if (payloadLength !== 0) throw new Error('dsh desktop: Electron request cancel frame carried a payload')
        return { type: 'cancel', streamId }
      default:
        throw new Error(`dsh desktop: unknown Electron request frame type ${String(rawType)}`)
    }
  }

  private parseStart(streamId: number, payload: Buffer): DesktopHostRequestFrame {
    let value: unknown
    try {
      value = JSON.parse(payload.toString('utf8')) as unknown
    } catch (error) {
      throw new Error(`dsh desktop: Electron request start payload is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(value) || typeof value.url !== 'string' || typeof value.method !== 'string'
      || !isHeaders(value.headers) || typeof value.hasBody !== 'boolean') {
      throw new Error('dsh desktop: invalid Electron request start payload')
    }
    return {
      type: 'start',
      streamId,
      url: value.url,
      method: value.method,
      headers: value.headers,
      hasBody: value.hasBody,
    }
  }
}
