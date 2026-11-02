/** Synchronous placement for body-portaled panels with a viewport fixed-position containing block. */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { overlayTopMargin } from './overlay-top-margin.ts'

/** Inputs for {@link useAnchoredPosition}. */
export interface AnchoredPositionOptions {
  /** Whether the panel is mounted and should track its anchor. */
  open: boolean
  /** Element whose viewport rect anchors the panel. */
  anchorRef: RefObject<HTMLElement | null>
  /** Body-portaled, fixed-position panel; its ancestors must not establish a containing block. */
  panelRef: RefObject<HTMLElement | null>
  /** Preferred anchor edge; right-side panels align their top edges. */
  side?: 'top' | 'bottom' | 'right'
  /** Horizontal alignment for panels above or below the anchor. */
  align?: 'start' | 'end'
  /** Distance from the preferred anchor edge, in CSS pixels. */
  gap: number
  /** Minimum viewport inset; desktop frame clearance can increase the top inset. */
  margin: number
  /** Reserve desktop frame clearance in addition to the margin; false keeps only the viewport margin. Defaults to true. */
  frameClearance?: boolean
  /** Host-supplied client rect; null hides the panel until the anchor is available. */
  getAnchorRect?: () => DOMRect | null
  /** Re-measure a committed content change before paint. */
  layoutKey?: string | number
  /** Minimum panel width follows the anchor, bounded by the visible viewport. */
  minWidthFromAnchor?: boolean
}

/**
 * Keep a fixed panel aligned and constrained to the visible viewport.
 * Panel CSS consumes `--dsh-anchored-max-width` and `--dsh-anchored-max-height` for size limits.
 * The hook owns those inline variables and optional min-width while open, restoring them on cleanup.
 * @param options - Open state, element refs, placement, and optional host rect or content change key.
 * @returns Fixed left/top coordinates, or null while closed or awaiting an anchor; the first measurement completes before paint.
 */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin,
    getAnchorRect, layoutKey, minWidthFromAnchor = false, frameClearance = true } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (anchor === null || panel === null) return
    const win = anchor.ownerDocument.defaultView
    if (win === null) return
    const viewport = win.visualViewport
    // WebKit client rects use the visual origin; viewport-fixed CSS uses the layout origin.
    const visualOrigin = typeof win.CSS !== 'undefined' && win.CSS.supports('-webkit-backdrop-filter', 'none')
    const properties = ['--dsh-anchored-max-width', '--dsh-anchored-max-height', ...minWidthFromAnchor ? ['min-width'] : []]
    const previous = properties.map(name => [name, panel.style.getPropertyValue(name), panel.style.getPropertyPriority(name)] as const)
    let active = true
    let lastRect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'> | null = null
    const readRect = () => getAnchorRect === undefined ? anchor.getBoundingClientRect() : getAnchorRect()
    const place = (rect: DOMRect | null): void => {
      lastRect = rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      let next: CSSProperties | null = null
      if (rect !== null) {
        const x = viewport?.offsetLeft ?? 0
        const y = viewport?.offsetTop ?? 0
        const width = viewport?.width ?? (anchor.ownerDocument.documentElement.clientWidth || win.innerWidth)
        const height = viewport?.height ?? (anchor.ownerDocument.documentElement.clientHeight || win.innerHeight)
        const topMargin = frameClearance ? overlayTopMargin(margin, rect, gap) : margin
        const maxWidth = Math.max(0, width - margin * 2)
        panel.style.setProperty('--dsh-anchored-max-width', `${maxWidth}px`)
        panel.style.setProperty('--dsh-anchored-max-height', `${Math.max(0, height - topMargin - margin)}px`)
        if (minWidthFromAnchor) panel.style.minWidth = `${Math.min(rect.width, maxWidth)}px`
        const panelWidth = panel.offsetWidth
        const panelHeight = panel.offsetHeight
        const offsetX = visualOrigin ? x : 0
        const offsetY = visualOrigin ? y : 0
        const left = offsetX + (side === 'right' ? rect.right + gap : align === 'end' ? rect.right - panelWidth : rect.left)
        const top = offsetY + (side === 'right' ? rect.top : side === 'top' ? rect.top - gap - panelHeight : rect.bottom + gap)
        next = {
          left: Math.max(x + margin, Math.min(left, x + width - margin - panelWidth)),
          top: Math.max(y + topMargin, Math.min(top, y + height - margin - panelHeight)),
        }
      }
      setPosition(current => current?.left === next?.left && current?.top === next?.top ? current : next)
    }
    const update = (): void => {
      if (!active) return
      place(readRect())
    }
    update()
    win.addEventListener('scroll', update, true)
    win.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    viewport?.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(anchor)
    observer?.observe(panel)
    // Transforms and surrounding layout can move an anchor without resizing either element.
    let frame = 0
    const track = (): void => {
      if (!active) return
      const rect = readRect()
      if (rect?.x !== lastRect?.x || rect?.y !== lastRect?.y
        || rect?.width !== lastRect?.width || rect?.height !== lastRect?.height) place(rect)
      frame = win.requestAnimationFrame(track)
    }
    frame = win.requestAnimationFrame(track)
    return () => {
      active = false
      win.cancelAnimationFrame(frame)
      observer?.disconnect()
      win.removeEventListener('scroll', update, true)
      win.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      viewport?.removeEventListener('resize', update)
      for (const [name, value, priority] of previous) panel.style.setProperty(name, value, priority)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin, getAnchorRect, layoutKey, minWidthFromAnchor, frameClearance])
  return position
}
