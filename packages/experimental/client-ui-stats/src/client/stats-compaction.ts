/** Compaction transaction state and its presentation as a synthetic step row. */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { StatsCompactionMetrics, StatsCompactionState } from './stats-contract.ts'
import {
  cacheHitRate, cacheReadTokens, cacheWriteTokens, contextTokens, isNumber, outputTokens,
} from './stats-usage.ts'

/** Event shape a Conversation Definition receives. */
type MatchEvent = Parameters<ConversationNodeDefinition['match']>[0]

/**
 * Compaction id an event names.
 * @param event - event seen by the Definition match.
 * @returns the nonempty compaction id, or null for events outside a transaction.
 */
export function compactionEventId(event: MatchEvent): string | null {
  if (event.type !== 'compaction/start'
    && event.type !== 'compaction/summary'
    && event.type !== 'compaction/end') return null
  const value: unknown = event.data.compactionId
  return typeof value === 'string' && value !== '' ? value : null
}

/** Text characters of a content-block list, for the summary size note. */
function textChars(blocks: readonly { readonly type: string; readonly text?: string }[]): number {
  let chars = 0
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
  }
  return chars
}

/**
 * Start state for one `compaction/start`.
 * @param event - the start event.
 * @returns state that later summary and end events refine.
 */
export function newCompactionState(event: MatchEvent): StatsCompactionState {
  /* v8 ignore next 3 -- the Definition only calls start for a compaction/start match. */
  if (event.type !== 'compaction/start') {
    throw new Error('stats-compaction start requires compaction/start')
  }
  return {
    compactionId: event.data.compactionId,
    turn: event.data.turn,
    startSeq: event.seq,
    startTime: event.time,
    summarySeq: null,
    endSeq: null,
    endTime: null,
    error: null,
    provider: null,
    model: null,
    usage: null,
    shadowedTokens: null,
    summaryChars: null,
    checkpointSeq: null,
  }
}

/**
 * Fold the summary or end of a compaction into its state.
 * @param state - state opened by compaction/start.
 * @param event - a matching compaction event.
 * @returns state after the event, or the same state for unrelated events.
 */
export function foldCompaction(state: StatsCompactionState, event: MatchEvent): StatsCompactionState {
  if (event.type === 'compaction/summary') {
    return {
      ...state,
      summarySeq: event.seq,
      provider: event.data.provider,
      model: event.data.model,
      usage: event.data.usage ?? null,
      shadowedTokens: event.data.shadowedTokenCount,
      summaryChars: textChars(event.data.summary),
    }
  }
  /* v8 ignore next -- a summary returned above; only compaction/end reaches this branch. */
  if (event.type === 'compaction/end') {
    return {
      ...state,
      turn: state.turn ?? event.data.turn,
      endSeq: event.seq,
      endTime: event.time,
      error: event.data.error ?? null,
    }
  }
  /* v8 ignore next -- the Definition routes only summary and end updates here. */
  return state
}

/**
 * View metrics of one compaction transaction.
 * @param state - folded compaction state.
 * @returns the row values; unavailable measurements stay null.
 */
export function compactionMetrics(state: StatsCompactionState): StatsCompactionMetrics {
  const usage = state.usage
  const endTime = state.endTime
  return {
    compactionId: state.compactionId,
    turn: state.turn,
    startTime: state.startTime,
    endTime,
    wall: isNumber(endTime) ? Math.max(0, endTime - state.startTime) : null,
    running: state.endSeq === null,
    context: contextTokens(usage),
    output: outputTokens(usage),
    cacheHit: cacheHitRate(usage),
    cacheRead: cacheReadTokens(usage),
    cacheWrite: cacheWriteTokens(usage),
    provider: state.provider,
    model: state.model,
    shadowedTokens: state.shadowedTokens,
    summaryChars: state.summaryChars,
    error: state.error,
  }
}
