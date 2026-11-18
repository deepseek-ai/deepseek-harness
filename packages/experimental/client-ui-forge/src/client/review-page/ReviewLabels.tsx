/**
 * A change request's labels on one line: labels that do not fit fold into a `+N` chip whose tooltip names every label.
 * The fold is measured again whenever the line's width changes.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeRequestLabel } from '@deepseek-ai/dsh-experimental-forge/types'
import type { NS } from '../locales.ts'
import css from './ReviewPage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Width the `+N` chip reserves, in pixels, before the chip itself is measured. */
const CHIP_RESERVE = 36

/**
 * Count the labels that fit before the chip: every label fits when all of them fit in the line, otherwise the labels
 * that end before the line's width less the chip's.
 * @param widths - each label's width with its gap, in order.
 * @param available - the line's width.
 * @param chip - the chip's width with its gap.
 * @returns how many labels show.
 */
export function fittingLabels(widths: readonly number[], available: number, chip: number): number {
  let used = 0
  for (const width of widths) used += width
  if (used <= available) return widths.length
  let shown = 0
  used = 0
  for (const width of widths) {
    if (used + width + chip > available) break
    used += width
    shown += 1
  }
  return shown
}

/** The label colors as the host sets them, with readable text over light and dark fills. */
function labelStyle(color: string | null): CSSProperties | undefined {
  if (color === null || !/^[0-9a-f]{6}$/i.test(color)) return undefined
  const value = Number.parseInt(color, 16)
  const luminance = (0.299 * (value >> 16) + 0.587 * ((value >> 8) & 0xff) + 0.114 * (value & 0xff)) / 255
  return { background: `#${color}`, color: luminance > 0.6 ? '#1f2328' : '#ffffff', borderColor: 'transparent' }
}

/**
 * Render the labels on one line.
 * @param props.labels - labels in host order.
 * @param props.truncated - whether the host has more labels than `labels`.
 * @param props.t - forge panel copy.
 * @returns the line, or null without labels.
 */
export function ReviewLabels({ labels, truncated, t }: {
  readonly labels: readonly ChangeRequestLabel[]
  readonly truncated: boolean
  readonly t: Translate
}): ReactNode {
  const line = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(labels.length)
  useLayoutEffect(() => {
    const element = line.current
    if (element === null) return
    const measure = (): void => {
      const items = [...element.querySelectorAll<HTMLElement>('[data-forge-label]')]
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0
      const chip = element.querySelector<HTMLElement>('[data-forge-label-more]')
      setShown(fittingLabels(items.map(item => item.offsetWidth + gap), element.clientWidth, (chip?.offsetWidth ?? CHIP_RESERVE) + gap))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [labels])
  if (labels.length === 0) return null
  const hidden = labels.length - shown
  const all = labels.map(label => label.name).join(t('reviewPage.labelSeparator'))
  return (
    <span ref={line} className={css.labels} aria-label={t('reviewPage.labelsAll', { labels: all })} role="group">
      {labels.map((label, index) => (
        <span key={label.name} className={css.label} style={labelStyle(label.color)} data-forge-label=""
          data-hidden={index >= shown ? '' : undefined} aria-hidden="true">{label.name}</span>
      ))}
      {(hidden > 0 || truncated) && (
        <Tooltip label={all} side="bottom" openOnClick maxWidth={360}>
          <button type="button" className={css.labelMore} data-forge-label-more="" aria-label={t('reviewPage.labelsAll', { labels: all })}>
            {truncated ? t('reviewPage.labelsMoreTruncated', { count: hidden }) : t('reviewPage.labelsMore', { count: hidden })}
          </button>
        </Tooltip>
      )}
    </span>
  )
}
