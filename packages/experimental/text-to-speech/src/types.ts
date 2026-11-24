/** Provider-neutral speech synthesis inputs, audio facts, and registration metadata. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Configured identity of one synthesis provider. */
export type SynthesisProviderId = Branded<'SynthesisProviderId'>

/** The one audio encoding every provider streams: headerless signed 16-bit little-endian PCM, one channel. */
export interface SynthesisAudioFormat {
  readonly encoding: 'pcm-s16le'
  /** Samples per second. */
  readonly sampleRate: number
}

/** Public provider facts; credentials and endpoints are excluded. */
export interface SynthesisProviderInfo {
  readonly id: SynthesisProviderId
  readonly name: string
  readonly location: 'host-local' | 'cloud'
  readonly audio: SynthesisAudioFormat
  /** Longest text, in UTF-16 code units, that one synthesis call accepts. */
  readonly maxCharacters: number
  /** Ids of the voices the provider speaks with, in menu order; never empty, and the first is its default. */
  readonly voices: readonly string[]
}

/**
 * Why a provider refuses text until the user acts. `sign-in-required`: neither a DeepSeek account sign-in nor a
 * DeepSeek API key is available.
 */
export type SynthesisUnavailableReason = 'sign-in-required'

/** Whether a provider synthesizes now; `failed` carries a Host diagnostic for a configuration that does not resolve. */
export type SynthesisAvailability =
  | { readonly phase: 'ready' }
  | { readonly phase: 'unavailable'; readonly reason: SynthesisUnavailableReason }
  | { readonly phase: 'failed'; readonly message: string }

/** Provider-owned availability; a provider without one is always ready. */
export interface SynthesisAvailabilitySource {
  /** @returns the latest state. */
  snapshot(): SynthesisAvailability
  /** @param listener - state invalidation callback. @returns subscription disposer. */
  subscribe(listener: () => void): () => void
}

/** Provider facts, its current availability, and the voice preference applied to it. */
export interface SynthesisProviderView extends SynthesisProviderInfo {
  readonly availability: SynthesisAvailability
  /** Voice of a synthesis through this provider that names none: the saved voice while the provider offers it, else its default. */
  readonly voice: string
}

/** One consistent observation of the provider roster and the configured selection. */
export interface SynthesisSnapshot {
  readonly providers: readonly SynthesisProviderView[]
  /** Configured provider id; it may name no registered provider. */
  readonly selected: SynthesisProviderId
}

/** A saved preference change; the voice must be one the selected provider offers. */
export interface SynthesisSelectionPatch {
  readonly voice: string
}

/**
 * Stable synthesis failure classes that Consumers localize.
 * `sign-in-required` needs a new sign-in; `api-key-invalid` needs another API key; `rate-limited`, `timeout` and
 * `service-error` allow a later retry; `service-unavailable` and `quota-exceeded`, an exhausted balance or allowance,
 * last until the service recovers or the balance is restored; `text-rejected` needs different text.
 */
export type SynthesisFailureCode = 'sign-in-required' | 'api-key-invalid' | 'rate-limited' | 'quota-exceeded'
  | 'service-unavailable' | 'text-rejected' | 'timeout' | 'service-error'

/** Plain text to speak and the voice that speaks it; markup is spoken as written. */
export interface SynthesisInput {
  readonly text: string
  /** One of the provider's `info.voices`. */
  readonly voice: string
}

/** One replaceable synthesizer. It owns its availability, execution, and cancellation. */
export interface SynthesisProvider {
  readonly info: SynthesisProviderInfo
  readonly availability?: SynthesisAvailabilitySource
  /**
   * Speak one text as a stream of audio in `info.audio`. Chunks split the byte stream at arbitrary positions, and
   * audio already yielded stays valid when a later pull fails.
   * @param input - text of at most `info.maxCharacters` code units and one of `info.voices`.
   * @param signal - caller or registration cancellation; it ends the provider's I/O even while no pull is waiting.
   * @returns audio bytes in playback order; a pull rejects with a `SpeechSynthesisError` for a classified failure.
   */
  synthesize(input: SynthesisInput, signal: AbortSignal): AsyncIterable<Uint8Array>
}

/** Caller input before the configured provider and the saved voice are applied. */
export interface SynthesisRequest {
  readonly text: string
  /** Voice of the configured provider; absent selects that provider's `voice` in the snapshot. */
  readonly voice?: string
}

/** Resolved input pins the exact registered provider, including its lifetime. */
export interface SynthesisSpec extends SynthesisInput {
  readonly provider: SynthesisProvider
}
