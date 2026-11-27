// SegmentedControl: a tablist of two or more equal-width segments with one
// sliding indicator, for switching a card or panel between a few modes. The
// owner holds the selection; `label` is required so the tablist never ships
// without an accessible name, and every segment label is owner-localized.
// Each tab is `<id>-<value>` and controls the panel `<id>-<value>-panel`, the
// element the owner renders for that mode and points back at the tab with
// `aria-labelledby`.

import { useEffect, useRef } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import clsx from 'clsx'
import css from './SegmentedControl.module.css'

/** One segment of a {@link SegmentedControl}. */
export interface SegmentedControlOption<Value extends string> {
  /** The value the owner receives when this segment is chosen. */
  value: Value
  /** Localized segment text. */
  label: string
  /** Whether the segment refuses selection. */
  disabled?: boolean
  /** Localized hover text, typically why the segment is locked. */
  title?: string
}

/** The keys that walk the tablist, per the WAI-ARIA tabs pattern. */
type WalkKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

function isWalkKey(key: string): key is WalkKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
    || key === 'Home' || key === 'End'
}

/**
 * The enabled option a walk key lands on from the selected one: arrows step
 * to the nearest enabled neighbour and wrap, Home and End jump to the first
 * and last enabled option.
 */
function walk<Value extends string>(
  options: readonly SegmentedControlOption<Value>[],
  from: number,
  key: WalkKey,
): SegmentedControlOption<Value> | undefined {
  const enabled = options.filter(option => option.disabled !== true)
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled[enabled.length - 1]
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
  const count = options.length
  for (let offset = 1; offset < count; offset += 1) {
    const candidate = options[((from + step * offset) % count + count) % count]
    if (candidate !== undefined && candidate.disabled !== true) return candidate
  }
  return undefined
}

/**
 * Render a segmented control.
 * @param props.id - the owner's base id: each tab is `<id>-<value>` and names
 * `<id>-<value>-panel` as the panel it controls.
 * @param props.value - the selected option's value; the control is fully controlled.
 * @param props.options - the segments in display order; at least two.
 * @param props.onChange - called with the value a click or a walk key asks for,
 * never with the value already selected.
 * @param props.label - localized accessible name of the tablist.
 * @param props.disabled - lock every segment, typically while the shown panel
 * has a write or a fetch in flight that switching would orphan.
 * @param props.className - extra class for layout placement.
 * @returns the tablist element.
 */
export function SegmentedControl<Value extends string>({
  id, value, options, onChange, label, disabled = false, className,
}: {
  id: string
  value: Value
  options: readonly SegmentedControlOption<Value>[]
  onChange: (next: Value) => void
  label: string
  disabled?: boolean
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
}) {
  const list = useRef<HTMLDivElement>(null)
  const selected = options.findIndex(option => option.value === value)

  // A walk key reports the next value and the owner re-renders with it; the
  // keyboard then follows the selection so the roving tabindex stays usable.
  useEffect(() => {
    const root = list.current
    /* v8 ignore next -- the ref is attached to the always-rendered root before any effect runs. */
    if (root === null) return
    if (!root.contains(document.activeElement)) return
    root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [value])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!isWalkKey(event.key)) return
    event.preventDefault()
    const target = walk(options, selected, event.key)
    if (target !== undefined && target.value !== value) onChange(target.value)
  }

  const indicator = {
    '--dsh-segment-count': String(options.length),
    '--dsh-segment-index': String(selected),
  } as CSSProperties

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={clsx(css.control, className)}
      style={indicator}
    >
      <span aria-hidden="true" className={css.indicator} />
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${id}-${option.value}-panel`}
            tabIndex={active ? 0 : -1}
            disabled={disabled || option.disabled === true}
            title={option.title}
            className={css.tab}
            onClick={() => { if (!active) onChange(option.value) }}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
