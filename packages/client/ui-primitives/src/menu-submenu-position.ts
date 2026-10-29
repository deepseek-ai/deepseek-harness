/** Viewport placement for Menu's portaled child card, independent of input device. */
import { useLayoutEffect, useState, type RefObject } from 'react'
import { overlayTopMargin } from './overlay-top-margin.ts'

interface SubmenuPosition {
  left: number
  top: number
  maxHeight: number
  width?: number
  page: boolean
}

/**
 * Fit a child beside its parent, or over the parent's panel when neither side fits.
 * CSS cannot choose a sibling portal's placement from both measured card widths.
 * @param active - The mounted parent's row ID, or null while closed.
 * @param parent - Parent card, including its scroll region.
 * @param trigger - The parent row opening the child.
 * @param child - Child card, measured before its first paint.
 * @param contextual - Whether frame clearance is excluded for a context menu.
 * @returns Viewport coordinates and the single-panel navigation mode, or null before placement.
 */
export function useMenuSubmenuPosition(
  active: string | null,
  parent: RefObject<HTMLDivElement>,
  trigger: RefObject<HTMLButtonElement>,
  child: RefObject<HTMLDivElement>,
  contextual: boolean,
): SubmenuPosition | null {
  const [position, setPosition] = useState<SubmenuPosition | null>(null)
  useLayoutEffect(() => {
    if (active === null) { setPosition(null); return }
    const place = () => {
      if (parent.current === null || trigger.current === null || child.current === null) return
      const panel = parent.current.getBoundingClientRect()
      const row = trigger.current.getBoundingClientRect()
      const margin = 12
      const gap = 4
      const vw = window.innerWidth
      const vh = window.innerHeight
      const topMargin = contextual ? margin : overlayTopMargin(margin, row, gap)
      const maxHeight = Math.max(0, vh - topMargin - margin)
      // Keep natural width measurable after returning from a single-panel page.
      child.current.style.width = ''
      const width = child.current.offsetWidth
      const right = panel.right + gap
      const left = panel.left - gap - width
      const page = right + width > vw - margin && left < margin
      const pageWidth = Math.min(Math.max(panel.width, width), vw - margin * 2)
      const actualWidth = page ? pageWidth : width
      const x = page ? panel.left : right + width <= vw - margin ? right : left
      const height = Math.min(child.current.offsetHeight, maxHeight)
      const y = page ? panel.top : row.top
      const next: SubmenuPosition = {
        left: Math.max(margin, Math.min(x, vw - actualWidth - margin)),
        top: Math.max(topMargin, Math.min(y, vh - height - margin)),
        maxHeight,
        ...(page ? { width: pageWidth } : {}),
        page,
      }
      if (page) child.current.style.width = `${pageWidth}px`
      setPosition(current => current?.left === next.left && current.top === next.top
        && current.maxHeight === next.maxHeight && current.width === next.width && current.page === next.page ? current : next)
    }
    place()
    let frame: number
    const track = () => { place(); frame = requestAnimationFrame(track) }
    frame = requestAnimationFrame(track)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [active, parent, trigger, child, contextual])
  return position
}
