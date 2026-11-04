import { useState, type CSSProperties } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './EffortSlider.module.css'

/** One adapter-advertised stop; undefined selects the adapter's default behavior. */
export interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Data and localized chrome supplied by the model selector. */
export interface EffortSliderProps {
  choices: readonly EffortChoice[]
  value: string | undefined
  label: string
  currentLabel: string
  /** Localized tooltip text for the currently displayed effort name. */
  formatTooltip: (effort: string) => string
  disabled: boolean
  /** A selection is being saved; keep its displayed value and keyboard focus. */
  pending: boolean
  onSelect: (effort: string | undefined) => void
}

type Gesture = { kind: 'pointer' | 'keyboard' | 'cancelled'; source: string; index: number }
const ADJUST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * Preview a discrete selection locally and submit once when the gesture finishes.
 * @param props - Exact-model choices, persisted value, and selection callback.
 * @returns A native discrete range with a live value label.
 */
export function EffortSlider({ choices, value, label, currentLabel, formatTooltip, disabled, pending, onSelect }: EffortSliderProps) {
  const selectedIndex = choices.findIndex(choice => choice.effort === value)
  const source = JSON.stringify([choices.map(choice => [choice.key, choice.effort]), value])
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const preview = gesture?.source === source && gesture.kind !== 'cancelled' ? gesture.index : selectedIndex
  const index = Math.max(0, preview)
  const current = choices[preview]
  const rangeDisabled = disabled || selectedIndex < 0 || choices.length < 2
  const commit = (nextIndex: number): void => {
    const choice = choices[nextIndex]
    setGesture(null)
    if (!disabled && !pending && choice !== undefined) onSelect(choice.effort)
  }
  const finish = (kind: Gesture['kind'], nextIndex: number): void => {
    if (gesture?.kind === kind && gesture.source === source) commit(nextIndex)
    else setGesture(null)
  }
  return (
    <div
      className={css.root}
      role="group"
      aria-label={label}
      style={{
        '--effort-count': Math.max(1, choices.length),
        '--effort-progress': `${choices.length > 1 ? index / (choices.length - 1) * 100 : 0}%`,
      } as CSSProperties}
    >
      <div className={css.heading}>
        <Tooltip label={formatTooltip(current?.label ?? currentLabel)} side="top" delayMs={500} portal>
          <span className={css.value}>{current?.label ?? currentLabel}</span>
        </Tooltip>
      </div>
      <div className={css.rail}>
        <input
          className={css.range}
          type="range"
          aria-label={label}
          aria-valuetext={current?.label ?? currentLabel}
          min={0}
          max={Math.max(0, choices.length - 1)}
          step={1}
          value={index}
          disabled={rangeDisabled}
          aria-disabled={rangeDisabled || pending}
          aria-busy={pending}
          onPointerDown={(event) => {
            if (pending) { event.preventDefault(); return }
            setGesture({ kind: 'pointer', source, index })
          }}
          onChange={(event) => {
            if (pending || disabled) return
            const nextIndex = event.currentTarget.valueAsNumber
            if (gesture === null) commit(nextIndex)
            else if (gesture.source === source && gesture.kind !== 'cancelled') setGesture({ ...gesture, index: nextIndex })
          }}
          onPointerUp={(event) => { finish('pointer', event.currentTarget.valueAsNumber) }}
          onPointerCancel={() => { setGesture(null) }}
          onLostPointerCapture={() => { setGesture(null) }}
          onBlur={() => { setGesture(null) }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (pending && ADJUST_KEYS.has(event.key)) {
              event.preventDefault()
              event.stopPropagation()
              return
            }
            if (event.key === 'Escape' && gesture !== null) {
              event.preventDefault()
              event.stopPropagation()
              setGesture({ ...gesture, kind: 'cancelled' })
            } else if (ADJUST_KEYS.has(event.key)) {
              event.stopPropagation()
              if (gesture === null) setGesture({ kind: 'keyboard', source, index })
            }
          }}
          onKeyUp={(event) => {
            if (ADJUST_KEYS.has(event.key)) {
              event.stopPropagation()
              finish('keyboard', event.currentTarget.valueAsNumber)
            }
          }}
        />
        <div className={css.ticks} aria-hidden="true">
          {choices.map((choice, at) => <span key={choice.key} className={at <= preview ? css.tickActive : css.tick} data-current={at === preview ? '' : undefined} />)}
        </div>
      </div>
    </div>
  )
}
