/** Localized durations and relative times shown on change request cards. */

import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
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

/**
 * Format how long ago an ISO time was in the compact form a one-line list row shows, such as 5分钟 or 2d.
 * @param iso - ISO 8601 time.
 * @param now - current epoch milliseconds.
 * @param t - forge panel copy.
 * @returns the label, or undefined for an unparsable time.
 */
export function formatShortAgo(iso: string, now: number, t: Translate): string | undefined {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const { unit, n } = relativeTime(at, now)
  return t(`time.short.${unit}`, { n })
}
