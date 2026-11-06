/** Raw PCM payload and multipart body accepted by the One-Shot transcription endpoint. */
import { randomUUID } from 'node:crypto'
import { SpeechTranscriptionError } from '@deepseek-ai/dsh-experimental-speech-to-text'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'

/** Region-less UI languages and the region the service's `x-client-locale` table lists for them. */
const DEFAULT_REGIONS: Readonly<Record<string, string>> = { zh: 'zh_CN', en: 'en_US', pt: 'pt_BR' }

/**
 * Convert a client UI language to the service's `x-client-locale` spelling.
 * @param locale - BCP 47 language tag such as `zh`, `zh-Hant` or `pt-BR`.
 * @returns underscore-separated locale, with a default region for a bare `zh`, `en` or `pt`.
 */
export function clientLocale(locale: string): string {
  const wire = locale.replaceAll('-', '_')
  return DEFAULT_REGIONS[wire] ?? wire
}

/** The service rejects raw PCM whose byte length is not a multiple of this value. */
const PCM_ALIGNMENT_BYTES = 32
const WAVE_HEADER_BYTES = 44

/** Canonical WAV converted to the service's raw 16 kHz mono PCM16 payload. */
export interface PcmPayload {
  /** Samples zero-padded to the service alignment; padding adds at most 1 ms of silence. */
  readonly pcm: Uint8Array
  /** Duration of the original recording. */
  readonly seconds: number
}

/**
 * Strip the WAV header and align the samples.
 * @param audio - canonical 16 kHz mono PCM16 WAV recording.
 * @param maxDurationSeconds - longest recording the service accepts.
 * @returns aligned samples and the recording duration.
 */
export function pcmPayload(audio: Uint8Array, maxDurationSeconds: number): PcmPayload {
  let seconds: number
  try { seconds = validateWave(audio, maxDurationSeconds) } catch (error) {
    // validateWave reports every rejection as an Error whose message names the violated constraint.
    throw new SpeechTranscriptionError('invalid-audio', (error as Error).message, { cause: error })
  }
  const samples = audio.subarray(WAVE_HEADER_BYTES)
  const pcm = new Uint8Array(Math.ceil(samples.byteLength / PCM_ALIGNMENT_BYTES) * PCM_ALIGNMENT_BYTES)
  pcm.set(samples)
  return { pcm, seconds }
}

/** One encoded `multipart/form-data` request body. */
export interface MultipartBody {
  readonly body: Uint8Array<ArrayBuffer>
  readonly contentType: string
}

/**
 * Encode text fields and one binary file; the complete byte length is known before sending.
 * @param fields - text field names and values.
 * @param file - file field name, file name, and bytes.
 * @returns the body and its content type.
 */
export function multipartBody(fields: readonly (readonly [string, string])[],
  file: { readonly name: string; readonly filename: string; readonly bytes: Uint8Array }): MultipartBody {
  const boundary = `dsh-speech-${randomUUID()}`
  const parts: Uint8Array[] = []
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n'), file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}
