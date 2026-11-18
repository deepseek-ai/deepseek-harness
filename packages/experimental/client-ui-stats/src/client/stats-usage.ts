/** Token accounting helpers shared by the Statistics table's step and turn levels. */

import type { StatsUsage } from './stats-contract.ts'

/**
 * Whether a value is a finite number.
 * @param value - candidate value.
 * @returns true when the value is a finite number.
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Whether one usage object reported any token bucket. */
function reported(usage: StatsUsage | null): usage is StatsUsage {
  return usage !== null
    && (usage.inputTokens !== undefined || usage.outputTokens !== undefined
      || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined)
}

/**
 * Prompt length: input, cache read, and cache write do not overlap.
 * @param usage - usage reported by one assistant message.
 * @returns prompt token count, or null when nothing was reported.
 */
export function contextTokens(usage: StatsUsage | null): number | null {
  if (!reported(usage)) return null
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Output tokens reported by one usage object.
 * @param usage - usage reported by one assistant message.
 * @returns output token count, or null when unreported.
 */
export function outputTokens(usage: StatsUsage | null): number | null {
  return reported(usage) ? usage.outputTokens ?? null : null
}

/**
 * Cache-read tokens reported by one usage object.
 * @param usage - usage reported by one assistant message.
 * @returns cache-read token count, or null when unreported.
 */
export function cacheReadTokens(usage: StatsUsage | null): number | null {
  return usage?.cacheReadTokens ?? null
}

/**
 * Cache-write tokens reported by one usage object.
 * @param usage - usage reported by one assistant message.
 * @returns cache-write token count, or null when unreported.
 */
export function cacheWriteTokens(usage: StatsUsage | null): number | null {
  return usage?.cacheWriteTokens ?? null
}

/**
 * Share of the prompt served from cache; null when nothing was reported.
 * @param usage - usage reported by one assistant message.
 * @returns cache hit rate in [0, 1], or null when it cannot be derived.
 */
export function cacheHitRate(usage: StatsUsage | null): number | null {
  const context = contextTokens(usage)
  if (context === null || context <= 0) return null
  const read = cacheReadTokens(usage)
  if (read === null) return null
  return Math.min(1, read / context)
}
