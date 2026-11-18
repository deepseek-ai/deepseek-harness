/**
 * Pure-type outlet of the session-projection Service Definition: the one projection type
 * table, importable from client aggregates without dragging the host-side
 * cordis Context merges of the package root (dsh-agent → dsh-session). Domain
 * packages may declare-merge through either the package root or this outlet —
 * re-export preserves symbol identity, so both land on the same table.
 *
 * @module @deepseek-ai/dsh-session-projection/types
 */

/**
 * Type-only marker of a `SessionProjectionMap` entry that a Session summary
 * leaves out. The symbol never exists at runtime: a marked entry keeps its
 * plain JSON value, `SessionProjectionViewValue` strips the mark in the wire
 * and client view types, and the only runtime fact is the `summary: false`
 * declared at registration. A marked key's registration declares
 * `summary: false` so the runtime key set and the client view type agree, and
 * `summaryKeys()` skips exactly those keys; the registration types do not
 * enforce that pairing.
 */
declare const sessionProjectionSummaryExcluded: unique symbol

/**
 * One `SessionProjectionMap` entry excluded from Session summary payloads
 * (the Session list row and any other summary read). The mark is type-only;
 * `T` keeps its exact runtime value and wire representation. Wrap only the
 * excluded contributor's own map entry, and place a nullable entry's `null`
 * outside the wrapper (`SessionProjectionSummaryExcluded<Item[]> | null`) so
 * the required symbol cannot absorb that member.
 */
export type SessionProjectionSummaryExcluded<T> = T & {
  readonly [sessionProjectionSummaryExcluded]: true
}

/**
 * The merge-extensible client projection table shared by wire blocks, client
 * cells, and React hooks. Domain packages merge their client-visible key here;
 * values are wire-JSON whole values. How a value is rendered is the slot
 * system's business, never this layer's.
 *
 */
export interface SessionProjectionMap {}

/**
 * One map entry's client view value: the summary mark stripped. The
 * conditional distributes over a nullable entry's union, so a `| null` member
 * written outside the wrapper survives unchanged.
 */
export type SessionProjectionViewValue<T> =
  T extends SessionProjectionSummaryExcluded<infer Value> ? Value : T

/** Every client view value, keyed by projection key, with no summary mark. */
export type SessionProjectionViewValues = {
  [K in keyof SessionProjectionMap]: SessionProjectionViewValue<SessionProjectionMap[K]>
}

/**
 * Keys a Session summary omits: map entries whose non-nullish value carries
 * the summary mark. Nullish members are ignored, so a nullable entry is still
 * recognized when its `null` lives outside the wrapper.
 */
export type SessionProjectionSummaryExcludedKey = {
  [K in keyof SessionProjectionMap]:
  NonNullable<SessionProjectionMap[K]> extends SessionProjectionSummaryExcluded<unknown> ? K : never
}[keyof SessionProjectionMap]

/**
 * The client values a Session summary carries: every client view value except
 * {@link SessionProjectionSummaryExcludedKey}. A summary read returns these
 * keys only; an opened Session's full snapshot keeps every view value.
 */
export type SessionProjectionSummaryValues =
  Omit<SessionProjectionViewValues, SessionProjectionSummaryExcludedKey>
