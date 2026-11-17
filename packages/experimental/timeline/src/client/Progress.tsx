import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Task } from '../records.ts'
import type { ProgressPrecision } from '../policy.ts'
import { progressStates } from '../tasks.ts'
import type { ProgressParts } from '../tasks.ts'

const partLabels = {
  done: 'completedWork',
  active: 'activeWork',
  pending: 'pendingWork',
  blocked: 'blockedWork',
} as const
type ProgressState = (typeof progressStates)[number]

/** Keep incomplete work below 100 at the chosen display precision. */
export function formatProgress(value: number, decimals: ProgressPrecision = 2): string {
  const percent = Math.max(0, Math.min(1, value)) * 100
  return Math.min(percent, value < 1 ? 100 - 10 ** -decimals : 100).toFixed(decimals)
}

/**
 * Show a task weight independently of the progress precision setting.
 * @param weight - the stored sibling weight.
 * @returns the weight rounded to at most two decimal places, without trailing zeros.
 */
export function formatWeight(weight: number): string {
  return String(Number(weight.toFixed(2)))
}

/** Stable, determinate progress with quiet motion only while work is active. */
export function Progress({
  value,
  status,
  label,
  decimals = 2,
  parts,
  t,
}: {
  value: number
  status: Task['status']
  label: string
  decimals?: ProgressPrecision
  parts?: ProgressParts | undefined
} & PropsLocale<'timeline'>): ReactNode {
  const [hovered, setHovered] = useState<{ part: ProgressState; expanded: boolean } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const select = (part: ProgressState | undefined) => {
    setHovered(part === undefined ? null : { part, expanded: false })
  }
  const clear = () => {
    setHovered(null)
    setDismissed(false)
  }
  const segmented = parts !== undefined
  useEffect(() => {
    if (!segmented && (hovered !== null || dismissed)) {
      setHovered(null)
      setDismissed(false)
      return
    }
    if (hovered === null || hovered.expanded || !segmented || dismissed) return
    const timer = setTimeout(() => {
      setHovered(current => (current === hovered ? { ...current, expanded: true } : current))
    }, 500)
    return () => { clearTimeout(timer) }
  }, [hovered, segmented, dismissed])
  const describe = (state: ProgressState) => {
    const part = parts?.[state]
    if (part === undefined) return ''
    const percent =
      state === 'done' ? formatProgress(part.fraction, decimals) : (part.fraction * 100).toFixed(decimals)
    return t(partLabels[state], { count: part.leaves, percent })
  }
  const breakdown = progressStates.map(describe).join('\n')
  const part = hovered === null ? undefined : parts?.[hovered.part]
  const titles =
    part?.titles
      .slice(0, part.leaves > 6 ? 5 : 6)
      .map(title => `- ${title.replace(/\s+/gu, ' ').trim()}`) ?? []
  if (part !== undefined && part.leaves > 6) titles.push('- ...')
  const tooltip =
    hovered === null ? breakdown : [describe(hovered.part), ...(hovered.expanded ? titles : [])].join('\n')
  const work = (parts?.done.fraction ?? 0) + (parts?.active.fraction ?? 0)
  const tip = (parts?.active.fraction ?? 0) > 0 ? 'active' : 'done'
  const bar = (
    <div
      className="timeline-progress"
      data-status={status}
      data-segmented={parts === undefined ? undefined : true}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Number(formatProgress(value, decimals))}
      aria-valuetext={parts === undefined ? `${formatProgress(value, decimals)}%` : breakdown}
      tabIndex={parts === undefined ? undefined : 0}
      aria-keyshortcuts={parts === undefined ? undefined : 'ArrowLeft ArrowRight'}
      onMouseLeave={clear}
      onBlur={clear}
      onFocus={() => {
        const part = progressStates.find(state => (parts?.[state].fraction ?? 0) > 0)
        select(part)
      }}
      onKeyDown={(event) => {
        if (segmented && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setHovered(null)
          setDismissed(true)
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const visible = progressStates.filter(state => (parts?.[state].fraction ?? 0) > 0)
        if (visible.length === 0) return
        event.preventDefault()
        const current = hovered === null ? -1 : visible.indexOf(hovered.part)
        const direction = event.key === 'ArrowRight' ? 1 : -1
        const index =
          current < 0
            ? direction === 1
              ? 0
              : visible.length - 1
            : (current + direction + visible.length) % visible.length
        select(visible[index])
      }}
    >
      {parts === undefined ? (
        <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      ) : (
        <>
          {progressStates.map(state => (
            <span
              key={state}
              data-part={state}
              data-tip={state === tip ? true : undefined}
              aria-hidden="true"
              style={{ width: `${parts[state].fraction * 100}%` }}
              onMouseEnter={() => { select(state) }}
            />
          ))}
          <span
            className="timeline-progress-highlight"
            data-flow={status === 'active' && work > 0 ? true : undefined}
            aria-hidden="true"
            style={{ width: `${work * 100}%` }}
          />
        </>
      )}
    </div>
  )
  return parts === undefined ? (
    bar
  ) : (
    <Tooltip label={tooltip} disabled={dismissed} side="top" portal maxWidth={360}>
      {bar}
    </Tooltip>
  )
}
