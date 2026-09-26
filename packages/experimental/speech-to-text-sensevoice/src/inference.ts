/** CPU SenseVoice inference and Silero segmentation, confined to the recognition process. */
import { createRequire } from 'node:module'
import type { Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { Config } from './config.ts'
import { validateInput } from './input.ts'

/** Verified files and validated inference settings sent by the Host. */
export interface InferenceConfig extends Config {
  readonly model: string
  readonly tokens: string
  readonly vad: string
}

interface Stream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
interface Recognizer {
  createStream(): Stream
  setConfig(config: object): void
  decode(stream: Stream): void
  getResult(stream: Stream): { text: string }
}
interface Detector {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(externalBuffer: false): { samples: Float32Array }
  pop(): void
  reset(): void
  flush(): void
}
interface Sherpa {
  OfflineRecognizer: new (config: object) => Recognizer
  Vad: new (config: object, bufferSeconds: number) => Detector
}

/**
 * Load one native model pair; every recording resets VAD and updates its language hint.
 * @param config - verified ONNX paths and explicit CPU/VAD limits.
 * @returns synchronous inference confined to its dedicated process.
 */
export function createTranscriber(config: InferenceConfig): (audio: Uint8Array, language: string) => Transcript {
  // sherpa-onnx-node publishes a CommonJS Node-API binding with JSDoc but no declarations.
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { senseVoice: { model: config.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: config.tokens, numThreads: config.threads, provider: 'cpu', debug: 0 },
  }
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  const detector = new sherpa.Vad({
    sileroVad: { model: config.vad, threshold: config.vadThreshold, minSilenceDuration: config.minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds, maxSpeechDuration: config.segmentSeconds, windowSize: 512 },
    sampleRate: 16000, numThreads: config.threads, provider: 'cpu', debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1)
  return (audio, language) => {
    const audioSeconds = validateInput(audio, language, config.maxAudioBytes)
    const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44)
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768)
    nativeConfig.modelConfig.senseVoice.language = language
    recognizer.setConfig(nativeConfig)
    detector.reset()
    const started = performance.now(), texts: string[] = []
    const drain = (): void => {
      while (!detector.isEmpty()) {
        // Electron's V8 memory cage requires copied native buffers, including VAD output.
        const segment = detector.front(false)
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples })
        recognizer.decode(stream)
        texts.push(recognizer.getResult(stream).text.trim())
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    detector.flush(); drain()
    return { text: texts.filter(Boolean).join(' ').trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 }
  }
}
