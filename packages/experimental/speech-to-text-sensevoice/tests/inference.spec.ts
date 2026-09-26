/** Native inference preserves language hints, bounded segments, and Electron-safe buffers. */
import { expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { createTranscriber } from '../src/inference.ts'

const native = vi.hoisted(() => ({ speech: true, texts: ['第一句。', '第二句。'], configs: [] as object[],
  front: vi.fn(), resets: vi.fn(), accepted: [] as number[], windows: [] as number[] }))
vi.mock('node:module', () => {
  return { createRequire: () => () => ({
    OfflineRecognizer: class {
      constructor(config: object) { native.configs.push(structuredClone(config)) }
      setConfig(config: object) { native.configs.push(structuredClone(config)) }
      createStream() { return { acceptWaveform: ({ samples }: { samples: Float32Array }) => { native.accepted.push(samples.length) } } }
      decode() {}
      getResult() { return { text: native.texts.shift() ?? '' } }
    },
    Vad: class {
      ready = false
      constructor(config: object) { native.configs.push(structuredClone(config)) }
      acceptWaveform(samples: Float32Array) { native.windows.push(samples.length); this.ready = native.speech }
      isEmpty() { return !this.ready }
      front(externalBuffer: false) { native.front(externalBuffer); return { samples: new Float32Array(512) } }
      pop() { this.ready = false }
      reset() { native.resets(); this.ready = false }
      flush() {}
    },
  }) }
})
function wave(samples = 1024): Uint8Array {
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  return b
}
it('loads one model pair, carries language changes, and copies VAD buffers for Electron', () => {
  const transcribe = createTranscriber(Object.assign(Config({ dataRoot: '/cache' }), { model: '/model', tokens: '/tokens', vad: '/vad' }))
  const result = transcribe(wave(), 'zh')
  expect(result).toMatchObject({ text: '第一句。 第二句。', audioSeconds: 1024 / 16000 })
  expect(result.inferenceSeconds).toBeGreaterThanOrEqual(0)
  expect(native.accepted).toEqual([512, 512])
  expect(native.front).toHaveBeenCalledWith(false)
  expect(native.configs.at(-1)).toMatchObject({ modelConfig: { senseVoice: { language: 'zh', useInverseTextNormalization: 1 } } })
  native.speech = false
  expect(transcribe(wave(100), 'en').text).toBe('')
  expect(native.configs.at(-1)).toMatchObject({ modelConfig: { senseVoice: { language: 'en' } } })
  expect(native.resets).toHaveBeenCalledTimes(2)
  expect(native.windows.at(-1)).toBe(100)
})
it('rejects unsupported language, malformed audio and recordings above the worker limit', () => {
  const transcribe = createTranscriber(Object.assign(Config({ dataRoot: '/cache', maxAudioBytes: 64 }), { model: '/model', tokens: '/tokens', vad: '/vad' }))
  expect(() => transcribe(wave(1), 'invalid')).toThrow('language')
  expect(() => transcribe(new Uint8Array(46), 'zh')).toThrow('WAV')
  expect(() => transcribe(wave(), 'zh')).toThrow('byte limit')
})
