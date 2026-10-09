/** Chat presentation derived from Host-backed detail and in-memory collapse timing. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TranscriptViewMode } from '../chat-settings.ts'

/** Available points when a completed Turn returns to its historical presentation. */
export const COLLAPSE_TIMINGS = ['completion', 'next-input'] as const

/** When a completed Turn returns to its historical presentation. */
export type CollapseTiming = typeof COLLAPSE_TIMINGS[number]

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Mode this policy was derived from; for diagnostics, never for branching in renderers. */
  readonly mode: TranscriptViewMode
  /** Browser-local experiment; completion retains the default immediate folding and scrolling. */
  readonly collapseTiming: CollapseTiming
  /** Whether a normally completed Turn folds its process rows behind the whole-Turn control. */
  readonly foldCompletedTurns: boolean
  /** Collapsible group headers for all Turns, historical Turns only, or no Turns. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Show the running command, path, query, or reasoning detail in group titles. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
}

const POLICIES: Readonly<Record<TranscriptViewMode, Omit<ChatPresentationPolicy, 'collapseTiming'>>> = {
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

function withTiming(collapseTiming: CollapseTiming): Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>> {
  return {
    compact: { ...POLICIES.compact, collapseTiming },
    standard: { ...POLICIES.standard, collapseTiming },
    detailed: { ...POLICIES.detailed, collapseTiming },
    verbose: { ...POLICIES.verbose, collapseTiming },
  }
}

const TIMING_POLICIES = {
  completion: withTiming('completion'),
  'next-input': withTiming('next-input'),
}

/**
 * Resolve a stable policy for one detail mode and collapse timing.
 * @param mode - persisted work-details mode.
 * @param collapseTiming - in-memory timing; defaults to immediate completion folding.
 * @returns the same policy object for the same pair of choices.
 */
export function presentationPolicyFor(
  mode: TranscriptViewMode,
  collapseTiming: CollapseTiming = 'completion',
): ChatPresentationPolicy {
  return TIMING_POLICIES[collapseTiming][mode]
}

/**
 * Combine Host-backed detail and in-memory timing without owning subscriptions.
 * @param mode - live work-details mode.
 * @param collapseTiming - live, in-memory collapse timing.
 * @returns observable policy whose subscriptions follow both preferences.
 */
export function derivePresentationPolicy(
  mode: ObservableSnapshot<TranscriptViewMode>,
  collapseTiming: ObservableSnapshot<CollapseTiming>,
): ObservableSnapshot<ChatPresentationPolicy> {
  return {
    getSnapshot: () => presentationPolicyFor(mode.getSnapshot(), collapseTiming.getSnapshot()),
    subscribe: (listener) => {
      const unsubscribeMode = mode.subscribe(listener)
      const unsubscribeTiming = collapseTiming.subscribe(listener)
      return () => { unsubscribeMode(); unsubscribeTiming() }
    },
  }
}
