/**
 * Pure types of the turn-outline domain: the ONE home of the `turnOutline`
 * projection-key declaration, free of this package's host-side value imports
 * (zod, the projection definition). Host consumers import `./types`; client
 * aggregates import `./client`, which re-exports this module.
 *
 * @module @deepseek-ai/dsh-session-turn-outline/types
 */

export {}

/** One started turn's outline facts, independent of what a client has paged in. */
export interface TurnOutlineEntry {
  /** Host-assigned turn number (the `turn/start` payload). */
  readonly turn: number
  /** The turn's `turn/start` event seq — paging a window back through this seq loads the whole turn. */
  readonly seq: number
  /** Bounded first-human-prompt preview (one rail-card line); `''` until an eligible prompt lands. */
  readonly prompt: string
  /** Bounded final-response preview (up to three rail-card lines); `''` until the turn ends with assistant text. */
  readonly response: string
}

/**
 * Fold state: the served entries plus the open turn's response draft. The
 * draft buffers the newest text-bearing assistant message until `turn/end`
 * commits it, and the wire view projects only `turns` — draft-only applies
 * keep that array's identity, so the change feed stays quiet between turn
 * boundaries.
 */
export interface TurnOutlineState {
  /** Started turns in ascending turn order. */
  readonly turns: readonly TurnOutlineEntry[]
  /** Newest text-bearing assistant preview of the open turn; `''` outside one. */
  readonly draft: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Whole-log turn outline fold state (entries plus the open turn's response draft). */
    turnOutline: TurnOutlineState
  }
  interface SessionProjectionMap {
    /** Every started turn with its `turn/start` seq and bounded previews, strictly increasing by turn; see {@link TurnOutlineEntry}. */
    turnOutline: readonly TurnOutlineEntry[]
  }
}
