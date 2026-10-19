/** Chat presentation derived from Host-backed detail, collapse timing, and folded replies. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { DEFAULT_FOLDED_REPLIES, type CollapseTiming, type FoldedReplies, type TranscriptViewMode } from '../chat-settings.ts'
export { COLLAPSE_TIMINGS, FOLDED_REPLIES, type CollapseTiming, type FoldedReplies } from '../chat-settings.ts'

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Preference identity for layout resets and diagnostics; renderers select the capabilities below. */
  readonly mode: TranscriptViewMode
  /** Saved collapse timing; completion retains the default immediate folding and scrolling. */
  readonly collapseTiming: CollapseTiming
  /** Assistant replies that stay visible while a completed Turn folds: every reply, or only the final answer. */
  readonly foldedReplies: FoldedReplies
  /** Whether a normally completed Turn folds its process rows behind the whole-Turn control. */
  readonly foldCompletedTurns: boolean
  /** Collapsible group headers for all Turns, historical Turns only, or no Turns. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Show the running command, path, query, or reasoning detail in group titles. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
}

const POLICIES: Readonly<Record<TranscriptViewMode, Omit<ChatPresentationPolicy, 'collapseTiming' | 'foldedReplies'>>> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: false,
    settledReasoningPreview: false,
  },
  standard: {
    mode: 'standard',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'history',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  verbose: {
    mode: 'verbose',
    foldCompletedTurns: false,
    stepGrouping: 'none',
    liveProcessDetail: false,
    settledReasoningPreview: true,
  },
}

function withTiming(
  collapseTiming: CollapseTiming,
  foldedReplies: FoldedReplies,
): Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>> {
  return {
    compact: { ...POLICIES.compact, collapseTiming, foldedReplies },
    standard: { ...POLICIES.standard, collapseTiming, foldedReplies },
    detailed: { ...POLICIES.detailed, collapseTiming, foldedReplies },
    verbose: { ...POLICIES.verbose, collapseTiming, foldedReplies },
  }
}

const TIMING_POLICIES = {
  completion: { all: withTiming('completion', 'all'), final: withTiming('completion', 'final') },
  'next-input': { all: withTiming('next-input', 'all'), final: withTiming('next-input', 'final') },
}

/**
 * Resolve a stable policy for one detail mode, collapse timing, and folded-reply choice.
 * @param mode - persisted work-details mode.
 * @param collapseTiming - persisted timing; defaults to immediate completion folding.
 * @param foldedReplies - persisted folded-reply choice; defaults to keeping every reply visible.
 * @returns the same policy object for the same choices.
 */
export function presentationPolicyFor(
  mode: TranscriptViewMode,
  collapseTiming: CollapseTiming = 'completion',
  foldedReplies: FoldedReplies = DEFAULT_FOLDED_REPLIES,
): ChatPresentationPolicy {
  return TIMING_POLICIES[collapseTiming][foldedReplies][mode]
}

/**
 * Combine Host-backed detail, persisted timing, and folded replies without owning subscriptions.
 * @param mode - live work-details mode.
 * @param collapseTiming - live Host-backed collapse timing.
 * @param foldedReplies - live Host-backed folded-reply choice.
 * @returns observable policy whose subscriptions follow all three preferences.
 */
export function derivePresentationPolicy(
  mode: ObservableSnapshot<TranscriptViewMode>,
  collapseTiming: ObservableSnapshot<CollapseTiming>,
  foldedReplies: ObservableSnapshot<FoldedReplies>,
): ObservableSnapshot<ChatPresentationPolicy> {
  return {
    getSnapshot: () => presentationPolicyFor(mode.getSnapshot(), collapseTiming.getSnapshot(), foldedReplies.getSnapshot()),
    subscribe: (listener) => {
      const unsubscribeMode = mode.subscribe(listener)
      const unsubscribeTiming = collapseTiming.subscribe(listener)
      const unsubscribeReplies = foldedReplies.subscribe(listener)
      return () => { unsubscribeMode(); unsubscribeTiming(); unsubscribeReplies() }
    },
  }
}
