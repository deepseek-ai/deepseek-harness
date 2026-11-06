import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { IconInfoOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Localized full label for the currently displayed effort name. */
  formatLabel: (effort: string) => string
  /** Accessible label for the default-effort explanation button. */
  defaultInfoLabel: string
  /** Explanation of unspecified effort, distinct from disabling reasoning. */
  defaultExplanation: string
  disabled: boolean
  /** A selection is being saved; keep its displayed value and keyboard focus. */
  pending: boolean
  onSelect: (effort: string | undefined) => void
}

type PointerGeometry = { start: number; length: number; size: number; centerY: number; offset: number }
type Gesture =
  | { kind: 'pointer'; source: string; index: number; geometry: PointerGeometry | null; position: number | null }
  | {
    kind: 'caption'
    source: string
    index: number
    pointerId: number
    startX: number
    startY: number
    startPosition: number
    length: number
    position: number | null
  }
  | { kind: 'keyboard' | 'cancelled'; source: string; index: number }
  | { kind: 'hover'; catalog: string; thumb: boolean; tick: number | null }
const ADJUST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
/** Pointer travel under which a dragged thumb settles onto the nearest stop. */
const SNAP_DISTANCE_PX = 10

/**
 * Preview discrete effort choices with a native range and a draggable, range-focusing caption.
 * @param props - Exact-model choices, persisted value, and selection callback.
 * @returns A native range with a live value label and independent motion decoration.
 */
export function EffortSlider({
  choices, value, label, currentLabel, formatLabel, defaultInfoLabel, defaultExplanation, disabled, pending, onSelect,
}: EffortSliderProps) {
  const thumbRef = useRef<HTMLSpanElement>(null)
  const rangeRef = useRef<HTMLInputElement>(null)
  const captionRef = useRef<HTMLButtonElement>(null)
  const infoFocused = useRef(false)
  const selectedIndex = choices.findIndex(choice => choice.effort === value)
  const catalog = JSON.stringify(choices.map(choice => [choice.key, choice.effort]))
  const source = JSON.stringify([catalog, value])
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const rangeDisabled = disabled || selectedIndex < 0 || choices.length < 2
  if (gesture?.kind === 'hover' && (gesture.catalog !== catalog || rangeDisabled)) setGesture(null)
  if (gesture !== null && gesture.kind !== 'hover' && gesture.kind !== 'cancelled'
    && (gesture.source !== source || rangeDisabled || pending)) {
    setGesture({ kind: 'cancelled', source, index: selectedIndex })
  }
  const active = gesture !== null && gesture.kind !== 'hover' && gesture.source === source && !rangeDisabled && !pending ? gesture : null
  const hover = gesture?.kind === 'hover' && gesture.catalog === catalog && !rangeDisabled ? gesture : null
  const preview = active !== null && active.kind !== 'cancelled' ? active.index : selectedIndex
  const index = Math.max(0, preview)
  const current = choices[preview]
  const defaultSelected = current !== undefined && current.effort === undefined
  const displayName = current?.label ?? currentLabel
  const valueLabel = formatLabel(displayName)
  // Preserve the effort name when a long localized prefix needs truncation.
  const valueStart = Math.max(0, valueLabel.lastIndexOf(displayName))
  useEffect(() => {
    // An external selection can remove the focused info button; keep keyboard access on the range.
    if (!defaultSelected && infoFocused.current) {
      rangeRef.current?.focus()
      infoFocused.current = false
    }
  }, [defaultSelected])
  const capturedPointer = gesture?.kind === 'caption' ? gesture.pointerId : null
  useEffect(() => {
    const caption = captionRef.current
    if (capturedPointer === null || caption === null) return
    // Source changes, locks, and unmounts end the caption's capture as well as its preview.
    return () => { if (caption.hasPointerCapture(capturedPointer)) caption.releasePointerCapture(capturedPointer) }
  }, [capturedPointer])
  const progress = choices.length > 1 ? index / (choices.length - 1) : 0
  const dragging = (active?.kind === 'pointer' || active?.kind === 'caption') && active.position !== null
  const snapPosition = (position: number, length: number | null): number => {
    if (length === null || choices.length < 2) return position
    const nearest = Math.round(position * (choices.length - 1)) / (choices.length - 1)
    return Math.abs(position - nearest) * length <= SNAP_DISTANCE_PX ? nearest : position
  }
  const dragLength = active?.kind === 'caption' ? active.length : active?.kind === 'pointer' ? active.geometry?.length ?? null : null
  const visualProgress = active !== null && (active.kind === 'pointer' || active.kind === 'caption') && active.position !== null
    ? snapPosition(active.position, dragLength)
    : progress
  const expanded = active?.kind === 'pointer' || (active?.kind === 'caption' && dragging) || hover?.thumb === true

  // Pointer geometry comes from the unscaled wrapper, so zoom and the spring cannot change the grab offset.
  const measure = (input: HTMLInputElement): PointerGeometry | null => {
    const range = input.getBoundingClientRect()
    const thumb = thumbRef.current?.getBoundingClientRect()
    if (thumb === undefined || range.width <= thumb.width) return null
    return {
      start: range.left + thumb.width / 2, length: range.width - thumb.width,
      size: thumb.width, centerY: range.top + range.height / 2, offset: 0,
    }
  }
  const hoverAt = (event: PointerEvent<HTMLInputElement>, settledIndex?: number): Gesture | null => {
    if (rangeDisabled || event.pointerType !== 'mouse' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return null
    const geometry = measure(event.currentTarget)
    const thumb = thumbRef.current?.getBoundingClientRect()
    if (geometry === null || thumb === undefined) return null
    const center = settledIndex === undefined ? thumb.left + thumb.width / 2
      : geometry.start + settledIndex / (choices.length - 1) * geometry.length
    const overThumb = Math.abs(event.clientX - center) <= geometry.size / 2
      && Math.abs(event.clientY - geometry.centerY) <= geometry.size / 2
    const nearest = Math.max(0, Math.min(choices.length - 1,
      Math.round((event.clientX - geometry.start) / geometry.length * (choices.length - 1))))
    const tickX = geometry.start + nearest / (choices.length - 1) * geometry.length
    const overTick = !pending && !overThumb && Math.abs(event.clientX - tickX) <= 8 && Math.abs(event.clientY - geometry.centerY) <= 8
    return { kind: 'hover', catalog, thumb: overThumb, tick: overTick ? nearest : null }
  }
  const commit = (nextIndex: number, next: Gesture | null = null): void => {
    const choice = choices[nextIndex]
    setGesture(next)
    if (!rangeDisabled && !pending && choice !== undefined) onSelect(choice.effort)
  }
  const finish = (kind: 'pointer' | 'keyboard', nextIndex: number, next: Gesture | null = null): void => {
    if (gesture?.kind === kind && gesture.source === source) commit(nextIndex, next)
    else setGesture(next)
  }
  const movePointer = (event: PointerEvent<HTMLInputElement>): void => {
    if (gesture?.kind === 'cancelled') return
    if (gesture?.kind === 'pointer') {
      if (gesture.source !== source || rangeDisabled || pending || gesture.geometry === null) return
      const { start, length, offset } = gesture.geometry
      const position = Math.max(0, Math.min(1, (event.clientX - start - offset) / length))
      setGesture(previous => previous?.kind === 'pointer' && previous.source === source ? { ...previous, position } : previous)
    } else if (gesture === null || gesture.kind === 'hover') {
      const next = hoverAt(event)
      setGesture(previous => previous?.kind === 'hover' && next?.kind === 'hover'
        && previous.catalog === next.catalog && previous.thumb === next.thumb && previous.tick === next.tick ? previous : next)
    }
  }
  const releaseCaption = (pointerId: number): void => {
    const caption = captionRef.current
    if (caption?.hasPointerCapture(pointerId)) caption.releasePointerCapture(pointerId)
  }
  const cancelCaption = (pointerId: number): void => {
    releaseCaption(pointerId)
    setGesture(previous => previous?.kind === 'caption' && previous.pointerId === pointerId
      ? { kind: 'cancelled', source: previous.source, index: previous.index } : previous)
  }
  const startCaption = (event: PointerEvent<HTMLButtonElement>): void => {
    if (pending || rangeDisabled) { event.preventDefault(); return }
    if (!event.isPrimary || event.button > 0) return
    event.preventDefault()
    const input = rangeRef.current
    if (input === null) return
    input.focus()
    const geometry = measure(input)
    const thumb = thumbRef.current?.getBoundingClientRect()
    if (geometry === null || thumb === undefined) return
    // The caption may be clamped at an edge; its center is never the drag's value origin.
    const startPosition = (thumb.left + thumb.width / 2 - geometry.start) / geometry.length
    event.currentTarget.setPointerCapture(event.pointerId)
    setGesture({ kind: 'caption', source, index, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      startPosition, length: geometry.length, position: null })
  }
  const moveCaption = (event: PointerEvent<HTMLButtonElement>): void => {
    if (gesture?.kind !== 'caption' || gesture.pointerId !== event.pointerId || gesture.source !== source || rangeDisabled || pending) return
    const deltaX = event.clientX - gesture.startX
    const deltaY = event.clientY - gesture.startY
    if (gesture.position === null) {
      if (event.pointerType === 'touch' && Math.abs(deltaY) >= 3 && Math.abs(deltaY) > Math.abs(deltaX)) {
        cancelCaption(event.pointerId)
        return
      }
      if (Math.abs(deltaX) < 3) return
    }
    event.preventDefault()
    const position = Math.max(0, Math.min(1, gesture.startPosition + deltaX / gesture.length))
    const nextIndex = Math.round(position * (choices.length - 1))
    setGesture(previous => previous?.kind === 'caption' && previous.pointerId === event.pointerId && previous.source === source
      ? { ...previous, position, index: nextIndex } : previous)
  }
  const finishCaption = (event: PointerEvent<HTMLButtonElement>): void => {
    releaseCaption(event.pointerId)
    if (gesture?.kind !== 'caption' || gesture.pointerId !== event.pointerId || gesture.source !== source) return
    if (gesture.position !== null && gesture.index !== selectedIndex && !rangeDisabled && !pending) commit(gesture.index)
    else setGesture(null)
  }
  return (
    <div
      className={css.root}
      role="group"
      aria-label={label}
      style={{
        '--effort-count': Math.max(1, choices.length),
        '--effort-progress': `${progress * 100}%`,
        '--effort-visual-position': visualProgress,
      } as CSSProperties}
    >
      <div className={css.heading} data-dragging={dragging ? '' : undefined}>
        <Tooltip label={valueLabel} side="top" delayMs={500} maxWidth={260} onlyWhenClipped portal disabled={dragging}>
          <span className={css.value} data-effort-tag>
            <button ref={captionRef} type="button" className={css.caption} data-effort-caption aria-label={valueLabel}
              disabled={rangeDisabled} aria-disabled={rangeDisabled || pending} aria-busy={pending}
              onPointerDown={startCaption} onPointerMove={moveCaption} onPointerUp={finishCaption}
              onPointerCancel={(event) => { cancelCaption(event.pointerId) }}
              onLostPointerCapture={(event) => { cancelCaption(event.pointerId) }}
              onClick={(event) => {
                // Pointer clicks already focused on down; zero-detail keyboard/AT activation is a new focus request.
                if (event.detail !== 0 || rangeDisabled || pending) return
                setGesture(null)
                rangeRef.current?.focus()
              }}>
              <span className={css.valueLabel} data-effort-label>
                <span className={css.valuePrefix}>{valueLabel.slice(0, valueStart)}</span>
                <span className={css.valueName} data-effort-name>{valueLabel.slice(valueStart)}</span>
              </span>
            </button>
            {defaultSelected && (
              <Tooltip label={defaultExplanation} side="top" delayMs={300} focusDelayMs={0} maxWidth={260} portal openOnClick>
                <button type="button" className={css.infoButton} aria-label={defaultInfoLabel}
                  onFocus={() => { infoFocused.current = true }} onBlur={() => { infoFocused.current = false }}>
                  <IconInfoOutlineRegular size={12} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          </span>
        </Tooltip>
      </div>
      <div className={css.rail} data-dragging={dragging ? '' : undefined} data-disabled={rangeDisabled ? '' : undefined}>
        <div className={css.track} data-effort-track aria-hidden="true">
          <span className={css.fill} data-effort-fill />
        </div>
        <input
          ref={rangeRef}
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
            if (pending || rangeDisabled) { event.preventDefault(); return }
            if (event.button > 0) return
            const geometry = measure(event.currentTarget)
            const thumb = thumbRef.current?.getBoundingClientRect()
            if (geometry !== null && thumb !== undefined) {
              const offset = event.clientX - thumb.left - thumb.width / 2
              if (Math.abs(offset) <= geometry.size / 2 && Math.abs(event.clientY - geometry.centerY) <= geometry.size / 2) {
                geometry.offset = offset
              }
            }
            setGesture({ kind: 'pointer', source, index, geometry, position: null })
          }}
          onPointerEnter={movePointer}
          onPointerMove={movePointer}
          onPointerLeave={() => { setGesture(previous => previous?.kind === 'hover' ? null : previous) }}
          onChange={(event) => {
            if (pending || rangeDisabled) return
            const nextIndex = event.currentTarget.valueAsNumber
            if (gesture === null || gesture.kind === 'hover') commit(nextIndex)
            else if (gesture.source === source && (gesture.kind === 'pointer' || gesture.kind === 'keyboard')) {
              setGesture(previous => (previous?.kind === 'pointer' || previous?.kind === 'keyboard') && previous.source === source
                ? { ...previous, index: nextIndex } : previous)
            }
          }}
          onPointerUp={(event) => {
            if (gesture?.kind === 'pointer' && gesture.source === source && !rangeDisabled && !pending) event.currentTarget.focus()
            finish('pointer', event.currentTarget.valueAsNumber, hoverAt(event, event.currentTarget.valueAsNumber))
          }}
          onPointerCancel={() => { setGesture(null) }}
          onLostPointerCapture={() => { setGesture(previous => previous?.kind === 'hover' ? previous : null) }}
          onBlur={(event) => {
            // WebKit focuses the enclosing menu when its native range takes over a pointer drag.
            const insideAncestor = event.relatedTarget instanceof Node && event.relatedTarget.contains(event.currentTarget)
            if (gesture?.kind === 'caption') releaseCaption(gesture.pointerId)
            setGesture(previous => previous?.kind === 'caption'
              ? { kind: 'cancelled', source: previous.source, index: previous.index }
              : previous?.kind === 'cancelled' || (insideAncestor && previous?.kind === 'pointer' && previous.source === source)
                ? previous : null)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (pending && ADJUST_KEYS.has(event.key)) {
              event.preventDefault()
              event.stopPropagation()
              return
            }
            if (event.key === 'Escape' && gesture !== null && gesture.kind !== 'hover' && gesture.kind !== 'cancelled') {
              event.preventDefault()
              event.stopPropagation()
              if (gesture.kind === 'caption') releaseCaption(gesture.pointerId)
              setGesture({ kind: 'cancelled', source, index })
            } else if (ADJUST_KEYS.has(event.key)) {
              event.stopPropagation()
              if (gesture?.kind === 'caption') releaseCaption(gesture.pointerId)
              if (gesture === null || gesture.kind === 'hover' || gesture.kind === 'caption'
                || (gesture.kind === 'cancelled' && !event.repeat)) {
                setGesture({ kind: 'keyboard', source, index })
              }
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
          {choices.map((choice, at) => <span key={choice.key} className={at <= preview ? css.tickActive : css.tick}
            data-effort-tick={at} data-current={at === preview ? '' : undefined}
            data-hovered={!pending && hover?.tick === at ? '' : undefined}
            style={{ left: `${choices.length > 1 ? at / (choices.length - 1) * 100 : 0}%` }} />)}
        </div>
        <div className={css.thumbRail} aria-hidden="true">
          <span ref={thumbRef} className={css.thumbPosition} data-effort-thumb>
            <span className={css.thumb} data-effort-thumb-scale data-expanded={expanded ? '' : undefined} />
          </span>
        </div>
      </div>
    </div>
  )
}
