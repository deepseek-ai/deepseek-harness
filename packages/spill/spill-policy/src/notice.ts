/** Browser-safe formatting and recognition of persisted spill-policy notices. */
import { describeOmitted, type Omitted } from '@deepseek-ai/dsh-output-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'

const OPEN = '('
const CLOSE = ')'
const LOCATION = ' Full formatted result stored at: '
const GUIDANCE_SEPARATOR = '. '
const SEPARATOR = '\n\n'
const EXACT_OMISSION = describeOmitted({ kind: 'exact', count: 0 }, 'bytes')
const COUNT_OFFSET = EXACT_OMISSION.indexOf('0')
const COUNT_SUFFIX = EXACT_OMISSION.slice(COUNT_OFFSET + 1)

/**
 * Format the notice appended to a retained preview, preserving its persisted spelling.
 * @param omitted - bytes omitted by the retention policy.
 * @param ref - saved text locator and retrieval guidance.
 * @returns the complete notice without a leading preview separator.
 */
export function formatSpillNotice(omitted: Omitted, ref: Pick<SpillRef, 'locator' | 'retrievalHint'>): string {
  return `${OPEN}${describeOmitted(omitted, 'bytes')}${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`
}

function isOmission(text: string): boolean {
  if (text === describeOmitted({ kind: 'none' }, 'bytes')
    || text === describeOmitted({ kind: 'unknown' }, 'bytes')) return true
  const count = Number(text.slice(COUNT_OFFSET, text.length - COUNT_SUFFIX.length))
  return Number.isSafeInteger(count) && count >= 0
    && text === describeOmitted({ kind: 'exact', count }, 'bytes')
}

/**
 * Recognize a final spill-policy notice in persisted text, including notice-only output.
 * This identifies the text convention, not authenticated provenance of tool output.
 * @param text - complete recorded text result.
 * @returns whether a complete notice occupies the end of the result.
 */
export function hasSpillNotice(text: string): boolean {
  if (!text.endsWith(CLOSE)) return false
  let start = 0
  while (true) {
    const next = text.indexOf(`${SEPARATOR}${OPEN}`, start)
    const candidate = text.slice(start, next < 0 ? -CLOSE.length : next)
    const location = candidate.indexOf(LOCATION, OPEN.length)
    if (candidate.startsWith(OPEN) && location >= 0
      && isOmission(candidate.slice(OPEN.length, location))) {
      return text.indexOf(GUIDANCE_SEPARATOR, start + location + LOCATION.length) >= 0
    }
    if (next < 0) return false
    start = next + SEPARATOR.length
  }
}
