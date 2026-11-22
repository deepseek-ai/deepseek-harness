/** Recording checks and the multipart body of a DeepSeek speech recognition request. */
import { randomUUID } from 'node:crypto'
import { SpeechTranscriptionError } from '@deepseek-ai/dsh-experimental-speech-to-text'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'

/**
 * Check a recording against the service limits before it is uploaded.
 * @param audio - canonical 16 kHz mono PCM16 WAV recording, sent unchanged.
 * @param maxDurationSeconds - longest recording the service accepts.
 * @param maxBytes - largest file the service accepts.
 * @returns the recording duration in seconds.
 * @throws {SpeechTranscriptionError} code `invalid-audio` for a malformed, overlong, or oversized recording.
 */
export function recordingSeconds(audio: Uint8Array, maxDurationSeconds: number, maxBytes: number): number {
  let seconds: number
  try { seconds = validateWave(audio, maxDurationSeconds) } catch (error) {
    // validateWave reports every rejection as an Error whose message names the violated constraint.
    throw new SpeechTranscriptionError('invalid-audio', (error as Error).message, { cause: error })
  }
  if (audio.byteLength > maxBytes) {
    throw new SpeechTranscriptionError('invalid-audio', `Recording is ${audio.byteLength} bytes; the service accepts ${maxBytes}`)
  }
  return seconds
}

/** One encoded `multipart/form-data` request body. */
export interface MultipartBody {
  readonly body: Uint8Array<ArrayBuffer>
  readonly contentType: string
}

/**
 * Encode the recording as the service's single `file` field. The body is bytes rather than `FormData`, because
 * undici's `FormData` pump rejects unhandled when an upload is cancelled before the body is read.
 * @param recording - WAV bytes.
 * @returns the body and its content type.
 */
export function multipartBody(recording: Uint8Array): MultipartBody {
  const boundary = `dsh-speech-${randomUUID()}`
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    recording, Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}
