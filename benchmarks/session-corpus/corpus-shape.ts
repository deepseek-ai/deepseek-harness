/** Per-Session length targets for the synthetic Session corpus. */

/**
 * Upper-quantile anchors, in percent, of the measured corpus distribution.
 * Each anchor pairs with one entry of every dimension table below.
 */
const QUANTILES = [10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 92, 94, 96, 97, 98, 99, 99.3, 99.6, 99.8, 99.9, 100] as const

/**
 * Aggregate quantiles of 1,650 local DSH Sessions measured on 2026-09-28
 * (newest generation per Session; top-level and subagent Sessions together).
 * Only counts and byte totals were extracted; no content, identity, or path.
 */
const MEASURED = {
  /** Logical events, expanding compact delta rows to their event count. */
  events: [22, 22, 27, 32, 53, 63, 84, 154, 251, 387, 709, 975, 1398, 2398, 2652, 3492, 7229, 11620, 21995, 26580, 60699, 84467],
  /** Decompressed JSONL bytes including the header line. */
  logicalBytes: [
    37_233, 46_642, 54_432, 67_432, 86_195, 95_561, 184_414, 572_320, 882_968, 1_250_060, 1_849_503,
    2_341_019, 2_849_779, 3_902_295, 4_874_426, 6_691_370, 8_479_554, 10_570_582, 13_024_700, 17_646_397,
    21_225_976, 48_139_877,
  ],
  /** Started turns. */
  turns: [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 4, 5, 7, 9, 11, 18, 20, 23, 39, 118, 2181],
} as const

/** Minimum length of one synthetic Session. */
export interface SessionShape {
  /** Index of the measured anchor; Sessions with one anchor share one shape. */
  readonly anchor: number
  /** Logical events the Session must contain at least. */
  readonly events: number
  /** Decompressed log bytes the Session must contain at least. */
  readonly logicalBytes: number
  /** Completed turns. */
  readonly turns: number
}

/** Number of measured anchors, and therefore of distinct Session shapes. */
export const ANCHOR_COUNT = QUANTILES.length

/**
 * Read the length targets of one measured anchor.
 * @param anchor - zero-based anchor index.
 * @returns the anchor's minimum event, byte, and turn counts.
 */
export function anchorShape(anchor: number): SessionShape {
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= ANCHOR_COUNT) {
    throw new Error(`corpus anchor ${String(anchor)} does not exist`)
  }
  return {
    anchor,
    events: MEASURED.events[anchor] as number,
    logicalBytes: MEASURED.logicalBytes[anchor] as number,
    turns: MEASURED.turns[anchor] as number,
  }
}

/**
 * Select the length targets for one rank of an ascending corpus.
 *
 * Every dimension uses the next measured anchor at or above the rank's
 * quantile, so each quantile of the generated corpus is at least the measured
 * one. Dimensions share the rank, so a long Session is long in every dimension.
 * @param rank - zero-based ascending length rank.
 * @param count - corpus size.
 * @returns the rank's minimum event, byte, and turn counts.
 */
export function sessionShape(rank: number, count: number): SessionShape {
  const quantile = (100 * (rank + 1)) / count
  const anchor = QUANTILES.findIndex(value => value >= quantile)
  if (!Number.isInteger(rank) || rank < 0 || anchor === -1) {
    throw new Error(`corpus rank ${String(rank)} is outside a ${String(count)}-Session corpus`)
  }
  return anchorShape(anchor)
}
