/** Length-prefixed `node:v8` frames as specs write and inspect them on a connection's streams. */
import { deserialize, serialize } from 'node:v8'

/** A decoded frame as the specs inspect it. */
export interface WireFrame { readonly type: string; readonly id: number; readonly [field: string]: unknown }

/**
 * Encode one frame.
 * @param value - the frame's fields.
 * @returns a 4-byte big-endian length followed by the `node:v8` encoding of `value`.
 */
export function frame(value: unknown): Buffer {
  const payload = serialize(value)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}

/**
 * Decode the complete frames among written bytes.
 * @param bytes - frames in the order they were written; an incomplete last frame is ignored.
 * @returns the decoded frames.
 */
export function decodeFrames(bytes: Buffer): WireFrame[] {
  const result: WireFrame[] = []
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const end = offset + 4 + bytes.readUInt32BE(offset)
    if (end > bytes.length) break
    result.push(deserialize(bytes.subarray(offset + 4, end)) as WireFrame)
    offset = end
  }
  return result
}
