/**
 * The scrollport a preview body remembers its offset against: the body element
 * itself, or an inner element a renderer claims through `scrollportRef`.
 */
import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'

/** The bound scrollport and the two callback refs that bind it. */
export interface Scrollport {
  /** The current scrollport: a renderer's claimed element, else the body. */
  readonly scrollportRef: RefObject<HTMLElement | null>
  /** Callback ref for the scrolling body element. */
  readonly bindBody: (body: HTMLDivElement | null) => void
  /** Callback ref a renderer passes its inner scrollport to; `null` returns the role to the body. */
  readonly bindScrollport: (scrollport: HTMLElement | null) => void
}

/**
 * Track the body and the renderer's scrollport. A newly bound renderer
 * scrollport starts at the remembered offset; releasing it hands the role back
 * to the body, at the same offset.
 * @param scrollTop - the remembered offset in px, read each render.
 * @returns the scrollport ref and its two binders, stable across renders.
 */
export function useScrollport(scrollTop: number): Scrollport {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const scrollportRef = useRef<HTMLElement | null>(null)
  const storedScrollTopRef = useRef(0)
  storedScrollTopRef.current = scrollTop
  const bindBody = useCallback((body: HTMLDivElement | null): void => {
    const previous = bodyRef.current
    bodyRef.current = body
    if (scrollportRef.current === null || scrollportRef.current === previous) scrollportRef.current = body
  }, [])
  const bindScrollport = useCallback((scrollport: HTMLElement | null): void => {
    const next = scrollport ?? bodyRef.current
    scrollportRef.current = next
    if (next !== null) next.scrollTop = storedScrollTopRef.current
  }, [])
  return { scrollportRef, bindBody, bindScrollport }
}
