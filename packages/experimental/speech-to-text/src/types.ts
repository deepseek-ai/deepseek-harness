/** Provider-neutral speech transcription inputs and registration metadata. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Configured identity of one transcription provider. */
export type SpeechProviderId = Branded<'SpeechProviderId'>

/** Provider-specific planning estimates, not measured progress or guaranteed resource limits. */
export interface SpeechSetupEstimate {
  readonly recommendedDiskBytes: number
  readonly expectedMemoryBytes: number
  readonly minimumMinutes: number
  readonly maximumMinutes: number
}

/** Public provider facts; credentials and filesystem paths are excluded. */
export interface SpeechProviderInfo {
  readonly id: SpeechProviderId
  readonly name: string
  readonly location: 'host-local' | 'cloud'
  /** Accepted language hints, including automatic detection when supported. */
  readonly languages: readonly string[]
  readonly setupEstimate?: SpeechSetupEstimate
  /** Origins offered for an explicit preparation download; omitted or empty when no choice applies. */
  readonly downloadSources?: readonly string[]
}

/** Ordered resource-preparation operations understood by the speech UI. Providers omit operations they do not need. */
export type SpeechPreparationStepKind = 'check' | 'model' | 'vad' | 'verify' | 'load'

/** One Host-owned operation; only its running state has a live elapsed clock. */
export interface SpeechPreparationStep {
  readonly kind: SpeechPreparationStepKind
  readonly status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
  readonly startedAt?: number
}

/** Safe download diagnostics for localized preparation guidance; URLs omit credentials and query strings. */
export interface SpeechDownloadFailure {
  readonly resource: string
  readonly source: string
  readonly reason: 'network' | 'dns' | 'timeout' | 'certificate' | 'http' | 'integrity' | 'storage' | 'unknown'
  readonly code?: string
  readonly status?: number
}

/** Host-owned preparation state; byte totals describe downloads, never estimated installation percentages. */
export type SpeechPreparationState = (
  | { readonly phase: 'unprepared' | 'ready' | 'standby' | 'cancelled' }
  | { readonly phase: 'downloading'; readonly resource: string; readonly completedBytes: number; readonly totalBytes?: number }
  | { readonly phase: 'checking' | 'loading' | 'waking' | 'cancelling'; readonly startedAt: number }
  | { readonly phase: 'failed'; readonly message: string; readonly download?: SpeechDownloadFailure }
) & {
  readonly step?: SpeechPreparationStepKind
  readonly steps?: readonly SpeechPreparationStep[]
}

/** Provider facts and its current resource readiness; independent of plugin activation. */
export interface SpeechProviderView extends SpeechProviderInfo {
  readonly preparation: SpeechPreparationState
}

/** Host-persisted default selection captured when a recording starts. */
export interface SpeechSelection {
  readonly providerId: SpeechProviderId
  readonly language: string
}

/** User intent updates only the preference fields explicitly changed. */
export interface SpeechSelectionPatch {
  readonly providerId?: SpeechProviderId
  readonly language?: string
}

/** One consistent provider roster and default-selection observation. */
export interface SpeechSnapshot {
  readonly providers: readonly SpeechProviderView[]
  readonly selection: SpeechSelection
}

/** Download choice for one preparation task; omission keeps the provider's configured selection policy. */
export interface SpeechPreparationOptions {
  /** One advertised origin; providers reject unavailable sources and use a manual choice without fallback. */
  readonly downloadSource?: string
}

/** Optional resource preparation controls. Providers without them are immediately usable. */
export interface SpeechPreparation {
  /** @returns the latest Host-owned state. */
  snapshot(): SpeechPreparationState
  /** @param listener - state invalidation callback. @returns subscription disposer. */
  subscribe(listener: () => void): () => void
  /**
   * Start or join the current preparation task; page and transport lifetimes do not own it.
   * @param options - task-local download selection; providers reject changing the source of active work.
   */
  prepare(options?: SpeechPreparationOptions): void
  /** Cancel preparation. @returns after its resources settle. */
  cancel(): Promise<void>
}

/** Complete audio recording and an explicit language hint. */
export interface SpeechInput {
  readonly audio: Uint8Array
  readonly language: string
}

/** Final transcription; an empty string means no speech was recognized. */
export interface Transcript {
  readonly text: string
  readonly audioSeconds: number
  readonly inferenceSeconds: number
}

/** One replaceable recognizer. It owns preparation, execution, and cancellation. */
export interface SpeechProvider {
  readonly info: SpeechProviderInfo
  readonly preparation?: SpeechPreparation
  /**
   * Recognize one complete recording without submitting an Agent message.
   * @param input - WAV bytes and language, borrowed until settlement.
   * @param signal - caller or registration cancellation; rejection follows resource cleanup.
   * @returns final text and measured audio/inference durations.
   */
  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript>
}

/** Caller selection before composition defaults are resolved. */
export interface SpeechRequest {
  readonly audio: Uint8Array
  readonly providerId?: SpeechProviderId
  readonly language?: string
}

/** Resolved selection pins the exact registered provider, including its lifetime. */
export interface SpeechSpec extends SpeechInput {
  readonly provider: SpeechProvider
}
