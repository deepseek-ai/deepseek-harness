/** Web Audio playback of streamed PCM: each chunk starts exactly where the one before it ends. */
import type { PcmPlayer } from './reader.ts'

/** Seconds between queuing a chunk and its earliest start, so the first samples are not cut. */
const LEAD_SECONDS = 0.03
/** Divisor that maps a signed 16-bit sample to the -1..1 range of Web Audio. */
const INT16_RANGE = 32_768

/**
 * Open one audio output. Chunks play back to back; after a gap in arrival the next chunk starts at once.
 * @param context - audio output; the default opens the device's default output.
 * @returns the player, which closes the context when closed.
 */
export function createPcmPlayer(context: AudioContext = new AudioContext()): PcmPlayer {
  const playing = new Set<AudioBufferSourceNode>()
  let end = 0
  return {
    enqueue(pcm, sampleRate) {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      const buffer = context.createBuffer(1, pcm.byteLength >> 1, sampleRate)
      const channel = buffer.getChannelData(0)
      for (let index = 0; index < channel.length; index++) channel[index] = view.getInt16(index * 2, true) / INT16_RANGE
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      const start = Math.max(end, context.currentTime + LEAD_SECONDS)
      source.start(start)
      end = start + buffer.duration
      playing.add(source)
      source.addEventListener('ended', () => { playing.delete(source) }, { once: true })
    },
    bufferedSeconds: () => Math.max(0, end - context.currentTime),
    close() {
      for (const source of playing) source.stop()
      playing.clear()
      void context.close()
    },
  }
}
