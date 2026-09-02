/**
 * Pure client-safe subagent projection vocabulary.
 *
 * @module @deepseek-ai/dsh-subagent/projection-types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Durable active-turn timing for one descriptor-backed child session. */
export interface SubagentTimingProjection {
  /** Milliseconds accumulated across completed turns after the child's own descriptor. */
  settledMs: number
  /** Same-cut bounds of the currently open turn, when one has not reached `turn/end`. */
  active?: {
    /** Start of the open turn. */
    since: number
    /** Latest event time folded into this projection cut. */
    through: number
  }
}

/**
 * Durable identity of one descriptor-backed subagent session: lifecycle mode
 * plus creation label, folded last-wins from `subagent/descriptor` events.
 * Label strength follows the descriptor schema: a continuable child always
 * carries one, a one-shot child may omit it.
 */
export type SubagentIdentityProjection =
  | {
    /** A terminal one-shot child. */
    mode: 'one-shot'
    /** Optional durable creation label from the child's descriptor. */
    label?: string
    /**
     * Seq of the `subagent/descriptor` event this identity was folded from.
     * `session.isOwnSeq(seq)` proves the identity comes from the child's
     * OWN log suffix — where a descriptor is immutable once appended — and
     * not from a fork seed's replayed ancestor descriptor.
     */
    seq: SessionSeq
  }
  | {
    /** A resumable conversation. */
    mode: 'continuable'
    /** Durable creation label from the child's descriptor. */
    label: string
    /** Seq of the folded descriptor event; see the one-shot arm for the own-suffix proof. */
    seq: SessionSeq
  }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Active-turn duration for a descriptor-backed subagent session. */
    subagentTiming: SubagentTimingProjection
    /**
     * Identity of a descriptor-backed subagent session. `null` ⟺ no valid
     * descriptor (missing, malformed, or unrecognized-version — deliberately
     * undistinguished). The sentinel is deliberately serializable: a
     * value pushed over JSON transports must survive `JSON.stringify`
     * losslessly, where an `undefined` field would be dropped and a stale
     * identity would survive on the receiving side. The entry itself stays
     * non-optional.
     */
    subagent: SubagentIdentityProjection | null
  }
}
