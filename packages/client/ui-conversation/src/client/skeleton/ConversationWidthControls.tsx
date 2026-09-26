import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ConversationWidthControlsProps } from '../contract/slots.ts'
import css from './ConversationRoot.module.css'

/** localStorage key for the dragged transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a dragged content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Horizontal room reserved for both handles and their safe edge zones. */
const CONTENT_EDGE_BUDGET = 176
const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
const FALLBACK_WHEEL_LINE_PX = 16

/** Read a valid persisted width preference, or null when absent or corrupt. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolve the width displayed for one measured Conversation column. */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/** Convert a wheel event's vertical delta to scrollport pixels. */
function wheelDeltaY(event: React.WheelEvent, scrollport: HTMLElement): number {
  if (event.deltaMode === WHEEL_DELTA_LINE) {
    const lineHeight = Number.parseFloat(getComputedStyle(scrollport).lineHeight)
    return event.deltaY * (Number.isFinite(lineHeight) ? lineHeight : FALLBACK_WHEEL_LINE_PX)
  }
  if (event.deltaMode === WHEEL_DELTA_PAGE) return event.deltaY * scrollport.clientHeight
  return event.deltaY
}

/** One pointer-captured transcript width handle. */
function WidthHandle(props: {
  side: 'left' | 'right'
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}) {
  const dragging = useRef(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    const outward = callbacks.current.side === 'right' ? dx : -dx
    return base.current + outward * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
  }
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = event.clientX
    latest.current = event.clientX
    base.current = callbacks.current.onStart()
    dragging.current = true
    event.currentTarget.toggleAttribute('data-dragging', true)
  }, [])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${event.clientY - box.top}px`)
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(outwardWidth())
    })
  }, [])
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    dragging.current = false
    event.currentTarget.toggleAttribute('data-dragging', false)
    event.currentTarget.releasePointerCapture(event.pointerId)
    cancelFrame()
    latest.current = event.clientX
    // A press-only gesture must not overwrite a wider preference with its window-clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
    callbacks.current.onEnd()
  }, [])
  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    event.currentTarget.toggleAttribute('data-dragging', false)
    // Cancellation abandons persistence and restores the saved width through onEnd.
    cancelFrame()
    callbacks.current.onEnd()
  }, [])
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const body = event.currentTarget.parentElement
    /* v8 ignore next -- a width handle renders only inside the Conversation body. */
    if (body === null) return
    const scrollport = body.querySelector<HTMLElement>(':scope > [data-conversation-scroll]')
    /* v8 ignore next -- the Conversation body always contains its direct scroll element. */
    if (scrollport === null) return
    if (event.ctrlKey || event.deltaY === 0) return
    scrollport.scrollBy({ top: wheelDeltaY(event, scrollport) })
  }, [])

  return (
    <div
      className={css.widthHandle}
      data-side={props.side}
      data-width-handle={props.side}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onWheel={onWheel}
    />
  )
}

/**
 * Install the main Conversation width axis and render its drag handles.
 * @param props - Mounted Conversation body and current presentation phase.
 * @returns two active-phase width handles, or no controls outside the active phase.
 */
export function ConversationWidthControls({ container, phase }: ConversationWidthControlsProps) {
  const publishWidths = useCallback((container: HTMLDivElement): void => {
    const target = container.parentElement ?? container
    const column = container.offsetWidth
    target.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    const preference = readWidthPreference()
    if (preference === null) target.style.removeProperty('--dsh-chat-user-width')
    else target.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
  }, [])

  useLayoutEffect(() => {
    if (container === null) return
    const observer = new ResizeObserver(() => { publishWidths(container) })
    observer.observe(container)
    publishWidths(container)
    return () => { observer.disconnect() }
  }, [container, publishWidths])

  const onStart = useCallback((): number => {
    if (container === null) return 680
    return resolveContentWidth(container.offsetWidth, readWidthPreference())
  }, [container])
  const onDrag = useCallback((width: number): void => {
    if (container === null) return
    const target = container.parentElement ?? container
    target.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(container.offsetWidth, width)}px`)
  }, [container])
  const onCommit = useCallback((width: number): void => {
    if (container === null) return
    localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(container.offsetWidth, width)}`)
  }, [container])
  const onEnd = useCallback((): void => {
    if (container !== null) publishWidths(container)
  }, [container, publishWidths])

  if (container === null || phase !== 'active') return null
  return (['left', 'right'] as const).map(side => (
    <WidthHandle
      key={side}
      side={side}
      onStart={onStart}
      onDrag={onDrag}
      onCommit={onCommit}
      onEnd={onEnd}
    />
  ))
}
