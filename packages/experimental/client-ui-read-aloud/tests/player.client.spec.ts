/** Gapless scheduling of PCM chunks on a Web Audio clock. */
import { afterEach, expect, it, vi } from 'vitest'
import { createPcmPlayer } from '../src/client/player.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** The slice of Web Audio the player uses, with a clock the test moves. */
function fakeContext() {
  const sources: { start: number; samples: number[]; stopped: boolean; ended: () => void }[] = []
  const context = {
    currentTime: 0,
    destination: {},
    closed: false,
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length)
      return { duration: length / sampleRate, getChannelData: () => data }
    },
    createBufferSource: () => {
      const source = { buffer: undefined as { getChannelData: () => Float32Array } | undefined, connected: undefined as object | undefined,
        entry: { start: 0, samples: [] as number[], stopped: false, ended: () => {} } }
      return {
        set buffer(value: { getChannelData: () => Float32Array }) { source.buffer = value },
        connect: (destination: object) => { source.connected = destination },
        start: (at: number) => {
          source.entry.start = at
          source.entry.samples = [...source.buffer!.getChannelData()]
          expect(source.connected).toBe(context.destination)
          sources.push(source.entry)
        },
        stop: () => { source.entry.stopped = true },
        addEventListener: (_type: string, listener: () => void) => { source.entry.ended = listener },
      }
    },
    close: async () => { context.closed = true },
  }
  return { context, sources }
}

const pcm = (...samples: number[]): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, index) => { view.setInt16(index * 2, sample, true) })
  return bytes
}

it('plays chunks back to back and starts the next one at once after a gap', () => {
  const { context, sources } = fakeContext()
  const player = createPcmPlayer(context as never)
  expect(player.bufferedSeconds()).toBe(0)
  player.enqueue(pcm(0, 16_384, -32_768, 32_767), 4)
  player.enqueue(pcm(1, 2), 4)
  expect(sources.map(source => source.start)).toEqual([0.03, 1.03])
  expect(sources[0]!.samples).toEqual([0, 0.5, -1, 32_767 / 32_768])
  expect(player.bufferedSeconds()).toBeCloseTo(1.53)
  context.currentTime = 1
  expect(player.bufferedSeconds()).toBeCloseTo(0.53)
  context.currentTime = 5
  expect(player.bufferedSeconds()).toBe(0)
  player.enqueue(pcm(1, 2, 3, 4), 4)
  expect(sources[2]!.start).toBe(5.03)
})

it('reads samples from a view that starts inside a larger buffer', () => {
  const { context, sources } = fakeContext()
  const padded = new Uint8Array([9, ...pcm(256, -256)])
  createPcmPlayer(context as never).enqueue(padded.subarray(1), 2)
  expect(sources[0]!.samples).toEqual([256 / 32_768, -256 / 32_768])
})

it('stops what is still playing and releases the output when closed', () => {
  const { context, sources } = fakeContext()
  const player = createPcmPlayer(context as never)
  player.enqueue(pcm(1, 2), 2)
  player.enqueue(pcm(3, 4), 2)
  sources[0]!.ended()
  player.close()
  expect(sources.map(source => source.stopped)).toEqual([false, true])
  expect(context.closed).toBe(true)
})

it('opens the default output when none is given', () => {
  const { context } = fakeContext()
  vi.stubGlobal('AudioContext', function AudioContext() { return context })
  createPcmPlayer().close()
  expect(context.closed).toBe(true)
})
