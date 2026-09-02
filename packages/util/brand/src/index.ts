/**
 * Duplicate-install-safe nominal primitive helpers.
 *
 * A brand makes structurally identical strings or numbers non-interchangeable
 * at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
 * expected, and an event sequence cannot be passed as a log offset. Comparison,
 * logging, and serialization retain the underlying primitive behavior.
 *
 * This package owns no concrete domain value and keeps no runtime identity or mutable
 * state, so independently installed copies produce interchangeable values.
 *
 * @module @deepseek-ai/dsh-brand
 */

declare const BRAND: unique symbol

/** A string carrying a compile-time-only brand `B`. */
export type Branded<B extends string> = string & { readonly [BRAND]: B }

/** A number carrying a compile-time-only brand `B`. */
export type BrandedNumber<B extends string> = number & { readonly [BRAND]: B }

/**
 * Apply a compile-time string brand without changing the value.
 * @param value - string admitted by the domain that owns the target brand.
 * @returns the same string with the requested compile-time brand.
 */
export function brandString<T extends Branded<string>>(value: string | T): T {
  return value as T
}

/**
 * Apply a compile-time number brand without changing the value.
 * @param value - number admitted by the domain that owns the target brand.
 * @returns the same number with the requested compile-time brand.
 */
export function brandNumber<T extends BrandedNumber<string>>(value: number | T): T {
  return value as T
}
