/** Localized durations and relative times shown on change request cards. */

import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

type Translate = PropsLocale<typeof NS>['t']

/**
 * Format an elapsed time as hours and minutes, minutes and seconds, or seconds.
 * @param ms - elapsed milliseconds.
 * @param t - forge panel copy.
 * @returns the localized duration.
 */
export function formatDuration(ms: number, t: Translate): string {
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const seconds = total % 60
  if (hours > 0) return t('duration.hours', { hours, minutes })
  if (minutes > 0) return t('duration.minutes', { minutes, seconds })
  return t('duration.seconds', { seconds })
}

/**
 * Format how long ago an ISO 8601 time was.
 * @param iso - the time.
 * @param now - current epoch milliseconds.
 * @param t - forge panel copy.
 * @returns the localized relative time, or undefined when `iso` does not parse.
 */
export function formatAgo(iso: string, now: number, t: Translate): string | undefined {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const { unit, n } = relativeTime(at, now)
  return t(`time.${unit}`, { n })
}
