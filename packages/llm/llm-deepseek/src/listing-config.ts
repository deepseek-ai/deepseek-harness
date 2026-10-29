/** Configuration of a route that follows a `/models` listing: cache timing and its validation. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Default deadline of one model-listing request and of a first-use wait. */
export const DEFAULT_MODELS_TIMEOUT_MS = 5_000
/** Default interval between automatic listing refreshes after first use. */
export const DEFAULT_MODELS_MAX_AGE_MS = 600_000

/** Listing fields of a route Config. */
export interface ModelListingConfig {
  /** Deadline of one listing request, which also bounds a first-use wait (default five seconds). */
  modelsTimeoutMs: Volatile<number>
  /**
   * Listing refresh interval after first use; failures retry at the same interval (default ten minutes).
   * Zero refreshes on each access and disables automatic refresh.
   */
  modelsMaxAgeMs: Volatile<number>
}

/** Schemas of the {@link ModelListingConfig} fields. */
export const modelListingConfigFields = {
  modelsTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MODELS_TIMEOUT_MS).volatile(),
  modelsMaxAgeMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_MAX_AGE_MS).volatile(),
}

/** Plain listing options accepted by {@link resolveListingTiming}. */
export interface ModelListingOptions {
  modelsTimeoutMs?: number
  modelsMaxAgeMs?: number
}

/** Listing cache timing of one configuration generation. */
export interface ListingTiming {
  /** Deadline of one listing request. */
  readonly timeoutMs: number
  /** Listing age after which the next access refreshes it. */
  readonly maxAgeMs: number
}

/** Listing endpoint and cache timing of one configuration generation. */
export interface ListingSettings extends ListingTiming {
  /** Listing endpoint; it always shares the Messages origin. */
  readonly url: string
}

/**
 * Validate listing timing. Settings updates can reach it without schema validation, so every bound is judged here.
 * @param options - plain listing options; absent values take the defaults.
 * @param owner - plugin name that prefixes each failure message.
 * @returns the validated timing.
 * @throws Error when a value is outside its schema bounds.
 */
export function resolveListingTiming(options: ModelListingOptions, owner: string): ListingTiming {
  const { modelsTimeoutMs = DEFAULT_MODELS_TIMEOUT_MS, modelsMaxAgeMs = DEFAULT_MODELS_MAX_AGE_MS } = options
  if (!Number.isFinite(modelsTimeoutMs) || modelsTimeoutMs <= 0 || modelsTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${owner}: modelsTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isSafeInteger(modelsMaxAgeMs) || modelsMaxAgeMs < 0) {
    throw new Error(`${owner}: modelsMaxAgeMs must be a non-negative safe integer`)
  }
  return { timeoutMs: modelsTimeoutMs, maxAgeMs: modelsMaxAgeMs }
}
