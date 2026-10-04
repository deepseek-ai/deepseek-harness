/** Pointer-captured resizing keeps the Inspector and main content within the viewport. */
import { useRef } from 'react'
import type { PointerEvent } from 'react'
import css from './page.module.css'

const MIN_HEIGHT = 20
const MAX_HEIGHT = 80

/**
 * Render the top divider; height is a percentage of the viewport, retained by its panel.
 * @param props - current height, resize callback, localized label, and controlled panel id.
 * @returns the pointer- and keyboard-operable horizontal divider.
 */
export function InspectorResizeHandle({ height, onResize, label, panelId }: {
  height: number
  onResize: (height: number) => void
  label: string
  panelId: string
}) {
  const drag = useRef<{ pointerId: number; y: number; height: number }>()
  const resize = (value: number): void => { onResize(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value))) }
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    if (start?.pointerId !== event.pointerId) return
    resize(start.height + (start.y - event.clientY) / window.innerHeight * 100)
  }
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div className={css.resize} role="separator" tabIndex={0} aria-label={label} aria-orientation="horizontal"
    aria-controls={panelId} aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={Math.round(height)}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current !== undefined) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, y: event.clientY, height }
    }}
    onPointerMove={move}
    onPointerUp={(event) => { move(event); end(event) }}
    onPointerCancel={end}
    onLostPointerCapture={end}
    onKeyDown={(event) => {
      const next = { ArrowUp: height + 5, ArrowDown: height - 5, Home: MIN_HEIGHT, End: MAX_HEIGHT }[event.key]
      if (next === undefined) return
      event.preventDefault()
      resize(next)
    }} />
}
