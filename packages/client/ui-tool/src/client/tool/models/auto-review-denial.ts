import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoReviewDenial } from './tool-call-model.ts'

/** Localized copy that replaces ordinary failed-call output for an Auto denial. */
export interface AutoReviewDenialPresentation {
  summary: string
  output: string
}

/**
 * Normalize only the user-visible copy; the durable error keeps the raw reason.
 * @param reason - raw persisted reviewer reason, or null when none was recorded.
 * @returns one display line, or null when the reason has no displayable text.
 */
export function normalizeAutoReviewReason(reason: string | null): string | null {
  if (reason === null) return null
  const normalized = reason.trim().replace(/[\r\n\u2028\u2029]+/gu, ' ')
  return normalized === '' ? null : normalized
}

/**
 * Resolve the collapsed identity and the single expanded OUT line.
 * @param denial - locale-neutral persisted denial facts.
 * @param t - conversation-namespace translator.
 * @returns localized summary and output text for the Tool row.
 */
export function localizeAutoReviewDenial(
  denial: AutoReviewDenial,
  t: TranslateNS<'conversation'>,
): AutoReviewDenialPresentation {
  const reason = normalizeAutoReviewReason(denial.reason) ?? t('tool.autoReviewReasonFallback')
  return {
    summary: t('tool.autoReviewRejected'),
    output: t('tool.autoReviewNotExecuted', { reason }),
  }
}
