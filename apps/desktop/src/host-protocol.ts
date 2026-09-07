/** Versioned control messages and framed byte transport for the Desktop Host child. */

/** Protocol version implemented by the Electron shell and installed dsh Host. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 3 as const

/** Child descriptor Electron writes request frames to. */
export const DESKTOP_REQUEST_PIPE_FD = 3

/** Child descriptor Electron reads response frames from. */
export const DESKTOP_RESPONSE_PIPE_FD = 4

/** Child descriptor reserved for Node's lifecycle IPC channel. */
export const DESKTOP_CONTROL_IPC_FD = 5

/** Maximum raw body bytes carried by one data frame. */
export const DESKTOP_PIPE_CHUNK_BYTES = 64 * 1024

const FRAME_MAGIC = 0x44534833
const FRAME_HEADER_BYTES = 13
const MAX_CONTROL_PAYLOAD_BYTES = 1024 * 1024

const REQUEST_FRAME_START = 1
const REQUEST_FRAME_DATA = 2
const REQUEST_FRAME_END = 3
const REQUEST_FRAME_CANCEL = 4
type RequestFrameType = typeof REQUEST_FRAME_START | typeof REQUEST_FRAME_DATA
  | typeof REQUEST_FRAME_END | typeof REQUEST_FRAME_CANCEL

const RESPONSE_FRAME_START = 1
const RESPONSE_FRAME_DATA = 2
const RESPONSE_FRAME_END = 3
const RESPONSE_FRAME_ERROR = 4

/** Metadata that precedes one optional request body on the request pipe. */
export interface DesktopHostRequestStart {
  readonly url: string
  readonly method: string
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
}

/** Commands retained on Node IPC because they do not carry Fetch payload bytes. */
export type DesktopHostCommand = {
  readonly type: 'shutdown'
}

/** Lifecycle events retained on Node IPC. */
export type DesktopHostEvent = {
  readonly type: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
} | {
  readonly type: 'fatal'
  readonly message: string
}

/** One decoded response-pipe frame. */
export type DesktopHostResponseFrame = {
  readonly type: 'start'
  readonly streamId: number
  readonly status: number
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
} | {
  readonly type: 'data'
  readonly streamId: number
  readonly data: Buffer
} | {
  readonly type: 'end'
  readonly streamId: number
} | {
  readonly type: 'error'
  readonly streamId: number
  readonly message: string
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

function encodeFrame(type: RequestFrameType, streamId: number, payload: Buffer): Buffer {
  assertStreamId(streamId)
  const limit = type === REQUEST_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
  if (payload.byteLength > limit) {
    throw new Error(`dsh desktop: request pipe frame exceeds the ${String(limit)}-byte limit`)
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(FRAME_MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(streamId, 5)
  frame.writeUInt32BE(payload.byteLength, 9)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

function encodeJsonFrame(type: RequestFrameType, streamId: number, value: unknown): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(value), 'utf8'))
}

/** Encode the metadata opening one request stream. */
export function encodeDesktopRequestStart(streamId: number, request: DesktopHostRequestStart): Buffer {
  return encodeJsonFrame(REQUEST_FRAME_START, streamId, request)
}

/** Encode one bounded raw request-body chunk. */
export function encodeDesktopRequestData(streamId: number, data: Uint8Array): Buffer {
  return encodeFrame(REQUEST_FRAME_DATA, streamId, Buffer.from(data))
}

/** Encode normal request-body completion. */
export function encodeDesktopRequestEnd(streamId: number): Buffer {
  return encodeFrame(REQUEST_FRAME_END, streamId, Buffer.alloc(0))
}

/** Encode cancellation of one request and its response. */
export function encodeDesktopRequestCancel(streamId: number): Buffer {
  return encodeFrame(REQUEST_FRAME_CANCEL, streamId, Buffer.alloc(0))
}

/** Incrementally decode validated response frames from the Host byte pipe. */
export class DesktopHostResponseDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * Append bytes and return every complete response frame.
   * @param chunk - next bytes read from the Host response pipe.
   * @returns complete frames in pipe order.
   */
  push(chunk: Buffer): DesktopHostResponseFrame[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: DesktopHostResponseFrame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === undefined) return frames
      frames.push(frame)
    }
  }

  /** Reject EOF that splits a frame. */
  finish(): void {
    if (this.buffer.byteLength !== 0) throw new Error('dsh desktop: Host response pipe ended inside a frame')
  }

  private next(): DesktopHostResponseFrame | undefined {
    if (this.buffer.byteLength < FRAME_HEADER_BYTES) return undefined
    if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('dsh desktop: invalid Host response frame marker')
    const rawType = this.buffer.readUInt8(4)
    const streamId = this.buffer.readUInt32BE(5)
    const payloadLength = this.buffer.readUInt32BE(9)
    assertStreamId(streamId)
    const limit = rawType === RESPONSE_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
    if (payloadLength > limit) {
      throw new Error(`dsh desktop: Host response frame exceeds the ${String(limit)}-byte limit`)
    }
    const frameLength = FRAME_HEADER_BYTES + payloadLength
    if (this.buffer.byteLength < frameLength) return undefined
    const payload = this.buffer.subarray(FRAME_HEADER_BYTES, frameLength)
    this.buffer = this.buffer.subarray(frameLength)
    switch (rawType) {
      case RESPONSE_FRAME_START:
        return this.parseStart(streamId, payload)
      case RESPONSE_FRAME_DATA:
        return { type: 'data', streamId, data: payload }
      case RESPONSE_FRAME_END:
        if (payloadLength !== 0) throw new Error('dsh desktop: Host response end frame carried a payload')
        return { type: 'end', streamId }
      case RESPONSE_FRAME_ERROR:
        return this.parseError(streamId, payload)
      default:
        throw new Error(`dsh desktop: unknown Host response frame type ${String(rawType)}`)
    }
  }

  private parseStart(streamId: number, payload: Buffer): DesktopHostResponseFrame {
    const value = this.parseJson(payload, 'start')
    if (!isRecord(value) || !Number.isInteger(value.status) || (value.status as number) < 100
      || (value.status as number) > 599 || !isHeaders(value.headers) || typeof value.hasBody !== 'boolean') {
      throw new Error('dsh desktop: invalid Host response start payload')
    }
    return {
      type: 'start',
      streamId,
      status: value.status as number,
      headers: value.headers,
      hasBody: value.hasBody,
    }
  }

  private parseError(streamId: number, payload: Buffer): DesktopHostResponseFrame {
    const value = this.parseJson(payload, 'error')
    if (!isRecord(value) || typeof value.message !== 'string') {
      throw new Error('dsh desktop: invalid Host response error payload')
    }
    return { type: 'error', streamId, message: value.message }
  }

  private parseJson(payload: Buffer, subject: string): unknown {
    try {
      return JSON.parse(payload.toString('utf8')) as unknown
    } catch (error) {
      throw new Error(`dsh desktop: Host response ${subject} payload is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
