/** SenseVoice language support and input failures that leave native inference untouched. */
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'

/** Language hints accepted by both provider metadata and native inference. */
export const languages: readonly string[] = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** A request rejected before native inference; the loaded worker remains reusable. */
export class SpeechInputError extends Error {}

/**
 * Validate a recording before touching the native recognizer.
 * @param audio - untrusted WAV request bytes.
 * @param language - requested SenseVoice language hint.
 * @param maxAudioBytes - configured worker byte limit.
 * @returns validated audio duration in seconds; invalid inputs throw SpeechInputError.
 */
export function validateInput(audio: Uint8Array, language: string, maxAudioBytes: number): number {
  if (!languages.includes(language)) throw new SpeechInputError('Unsupported SenseVoice language')
  if (audio.byteLength > maxAudioBytes) throw new SpeechInputError('Speech audio exceeds the worker byte limit')
  try { return validateWave(audio, maxAudioBytes / 32000) }
  catch (error) { throw new SpeechInputError('Invalid speech WAV', { cause: error }) }
}
