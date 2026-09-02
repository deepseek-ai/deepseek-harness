/**
 * Tool-pairing balance over a session surface. Compaction changes surface
 * positions, so safe cuts are derived from tool-call/result content in current
 * surface order rather than step markers.
 * @module @deepseek-ai/dsh-compaction/tool-pairing
 */

import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

/** Incremental balance state for one session surface generation. */
interface BalanceCache {
  /** Surface rewrite generation this state describes. */
  generation: number
  /**
   * Balance of every surface cut in current order: a surface of N sequences has
   * N + 1 cuts, entry `i` being the cut before sequence `i` and the final entry
   * the cut after the surface tail.
   */
  cutBalanced: readonly boolean[]
  /** Current surface position of each event seq, indexing {@link cutBalanced}. */
  indexBySeq: Map<SessionSeq, number>
  /** In-progress tool-call count after the processed surface tail. */
  inProgressToolCalls: number
}

const balanceCacheBySession = new WeakMap<Session, BalanceCache>()

/** Return how one surface event changes the in-progress tool-call count. */
function eventDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/** Fold surface sequences not yet in the cache into its balance state. */
function extendCache(
  session: Session,
  cache: BalanceCache,
  seqs: readonly SessionSeq[],
): BalanceCache {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  // Validate the unseen tail before mutating the live cache, so a corrupt
  // append cannot leave a partially advanced state behind.
  const pendingCuts: boolean[] = []
  let inProgressToolCalls = cache.inProgressToolCalls
  for (const seq of tail) {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    inProgressToolCalls += eventDelta(event)
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }

  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  return cache
}

/** Return balance state synchronized with the current session surface. */
function balanceCache(session: Session): BalanceCache {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)

  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    // A rebuild is the same fold started from the empty-surface state, whose
    // single leading cut is trivially balanced.
    const rebuilt = extendCache(session, {
      generation,
      cutBalanced: [true],
      indexBySeq: new Map(),
      inProgressToolCalls: 0,
    }, seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs)
  return cached
}

/** Balance of the cut at a sequence's position plus offset, rejecting seqs outside current membership. */
function cutBalance(cache: BalanceCache, seq: SessionSeq, offset: 0 | 1): boolean {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  }
  return balanced
}

/**
 * Whether the cut immediately before a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose leading cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 * @throws when the seq is absent from the current surface, a surface sequence has no
 * matching log event, or a tool result has no preceding open call.
 */
export function toolPairingBalancedBefore(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 0)
}

/**
 * Whether the cut immediately after a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose trailing cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 * @throws when the seq is absent from the current surface, a surface sequence has no
 * matching log event, or a tool result has no preceding open call.
 */
export function toolPairingBalancedAfter(session: Session, seq: SessionSeq): boolean {
  return cutBalance(balanceCache(session), seq, 1)
}
