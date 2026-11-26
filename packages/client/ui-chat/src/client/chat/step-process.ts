/** Step-run grouping and localized titles for projected step-process activity. */
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ProcessActivitySummary } from '../contract/process-groups.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'

/**
 * Decide whether a Turn shows its step runs behind group headers or flat.
 * Detailed keeps the open Turn, and the latest completed Turn until the next input, flat.
 * @param grouping - the work-details mode's step grouping.
 * @param turnOpen - whether the Turn is still running.
 * @param deferCollapse - whether the latest completed Turn stays flat until the next input.
 * @returns whether the step runs render as group headers.
 */
export function stepRunsGrouped(
  grouping: ChatPresentationPolicy['stepGrouping'],
  turnOpen: boolean,
  deferCollapse: boolean,
): boolean {
  return grouping === 'collapsed' || (grouping === 'history' && !turnOpen && !deferCollapse)
}

/**
 * Compose a closed group's localized title from its top three categories without counts.
 * @param summary - ranked work and phase evidence for this range.
 * @param t - Chat namespace translator.
 * @returns the secondary disclosure title.
 */
export function processTitle(
  summary: ProcessActivitySummary,
  t: ChatViewSlotProps['t'],
): string {
  const labels = summary.counts.slice(0, 3).map(({ kind }) => t(`message.stepProcess.done.${kind}`))
  const first = labels[0]
  if (first === undefined) return t('message.stepProcess.done.thinking')
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    const prefix = t('message.stepProcess.sharedPrefix')
    const shared = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
    return t('message.stepProcess.joinTwo', { first, second: continuation(shared ? second.slice(prefix.length) : second) })
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(t('message.stepProcess.comma'))
  return summary.counts.length > 3 ? t('message.stepProcess.more', { title }) : title
}

/**
 * Title an open group while no tool runs: the request analysis before any non-Context work, then the completed work and the next step.
 * @param summary - ranked work and phase evidence for this range.
 * @param t - Chat namespace translator.
 * @returns the live title without its detail.
 */
export function thinkingTitle(
  summary: ProcessActivitySummary,
  t: ChatViewSlotProps['t'],
): string {
  const first = summary.counts[0]
  if (first === undefined || first.kind === 'context') return t('message.stepProcess.thinking')
  return t('message.stepProcess.thinkingNext', { title: processTitle(summary, t) })
}
