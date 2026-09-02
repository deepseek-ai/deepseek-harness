import { describe, expect, it } from 'vitest'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, scanZstdFrames,
} from '../src/zstd.ts'
import { NodePrivateZstdFrameDecoder } from '../src/zstd-private-decoder.ts'
import { PublicZstdFrameDecoder } from '../src/zstd-public-decoder.ts'

describe('JSONL Zstandard compatibility', () => {
  it('round-trips concatenated checksummed frames through the built-in Node API', async () => {
    const encoded = Buffer.concat([
      await compressZstdFrame('{"type":"session","version":0,"id":"compat","createdAt":1}\n'),
      await compressZstdFrame('{"type":"turn/start","seq":0,"turn":1}\n'),
    ])
    const { frames, tornStart } = scanZstdFrames(encoded)

    expect(tornStart).toBeUndefined()
    expect(frames).toHaveLength(2)
    expect(frames.map(frame => encoded.subarray(frame.start, frame.start + 4).toString('hex')))
      .toEqual(['28b52ffd', '28b52ffd'])
    const decoded = await Promise.all(frames.map(frame => decompressZstdFrame(encoded.subarray(frame.start, frame.end))))
    expect(Buffer.concat(decoded).toString()).toContain('"type":"turn/start"')

    const preferred = createZstdFrameDecoder()
    expect(preferred).toBeInstanceOf(NodePrivateZstdFrameDecoder)
    for (const decoder of [preferred, new PublicZstdFrameDecoder()]) {
      try {
        const plaintext = Array.from(decoder.decode(encoded, frames), chunk => Buffer.from(chunk))
        expect(Buffer.concat(plaintext).toString()).toContain('"type":"turn/start"')
      } finally {
        decoder.close()
      }
    }

    const eventFrame = encoded.subarray(frames[1]!.start, frames[1]!.end)
    const missingChecksumByte = eventFrame.subarray(0, -1)
    expect(scanZstdFrames(missingChecksumByte)).toEqual({ frames: [], tornStart: 0 })
  })
})
