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
  return usePositionedOverlay(options)?.style ?? null
}

/** Layout-origin geometry supplied to the package's submenu placement strategy. */
export interface OverlayGeometry {
  anchor: DOMRect
  parent: DOMRect
  width: number
  gap: number
  bounds: { left: number; right: number }
}

/** Preferred coordinates and optional explicit width, before viewport clamping. */
export interface OverlayPlacement {
  left: number
  top: number
  width?: number
  page: boolean
}

/** Fixed coordinates and navigation mode from the same placement measurement. */
interface PositionedOverlay {
  style: CSSProperties
  page: boolean
}

/**
 * Package-internal placement core shared by anchored overlays and Menu children.
 * Owns size variables, coordinate conversion, observers, and movement tracking.
 * A custom placement consumes natural width and may set `--dsh-anchored-width`;
 * CSS must consume it with a max-content fallback. Managed styles restore on cleanup.
 * @param options - Anchored inputs plus an optional parent card and pure placement strategy.
 * @returns Coordinates and page mode together, or null while no anchor is available.
 */
export function usePositionedOverlay(options: Omit<AnchoredPositionOptions, 'layoutKey'> & {
  parentRef?: RefObject<HTMLElement | null>
  placement?: (geometry: OverlayGeometry) => OverlayPlacement
  layoutKey?: unknown
}): PositionedOverlay | null {
  const { open, anchorRef, panelRef, parentRef, placement, side = 'bottom', align = 'start', gap, margin,
    getAnchorRect, layoutKey, minWidthFromAnchor = false, frameClearance = true } = options
  const [position, setPosition] = useState<PositionedOverlay | null>(null)
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
    const parent = parentRef?.current
    const properties = ['--dsh-anchored-max-width', '--dsh-anchored-max-height',
      ...placement === undefined ? [] : ['--dsh-anchored-width'], ...minWidthFromAnchor ? ['min-width'] : []]
    const previous = properties.map(name => [name, panel.style.getPropertyValue(name), panel.style.getPropertyPriority(name)] as const)
    let active = true
    let lastBoxes = ''
    const readRect = () => getAnchorRect === undefined ? anchor.getBoundingClientRect() : getAnchorRect()
    const boxes = (rect: DOMRect | null, parentRect: DOMRect | undefined) =>
      [rect?.x, rect?.y, rect?.width, rect?.height, parentRect?.x, parentRect?.y, parentRect?.width, parentRect?.height].join(',')
    const place = (rect: DOMRect | null, parentRect: DOMRect | undefined): void => {
      lastBoxes = boxes(rect, parentRect)
      let next: PositionedOverlay | null = null
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
        if (placement !== undefined) panel.style.setProperty('--dsh-anchored-width', 'max-content')
        const panelWidth = panel.offsetWidth
        const panelHeight = panel.offsetHeight
        const normalize = (box: DOMRect) => new DOMRect(
          box.x + (visualOrigin ? x : 0), box.y + (visualOrigin ? y : 0), box.width, box.height,
        )
        const normalized = normalize(rect)
        const preferred: OverlayPlacement = placement === undefined ? {
          left: side === 'right' ? normalized.right + gap : align === 'end' ? normalized.right - panelWidth : normalized.left,
          top: side === 'right' ? normalized.top : side === 'top' ? normalized.top - gap - panelHeight : normalized.bottom + gap,
          page: false,
        } : placement({ anchor: normalized, parent: normalize(parentRect ?? rect), width: panelWidth, gap,
          bounds: { left: x + margin, right: x + width - margin } })
        if (preferred.width !== undefined) panel.style.setProperty('--dsh-anchored-width', `${preferred.width}px`)
        const finalHeight = preferred.width === undefined ? panelHeight : panel.offsetHeight
        next = {
          style: {
            left: Math.max(x + margin, Math.min(preferred.left, x + width - margin - (preferred.width ?? panelWidth))),
            top: Math.max(y + topMargin, Math.min(preferred.top, y + height - margin - finalHeight)),
          },
          page: preferred.page,
        }
      }
      setPosition(current => current?.style.left === next?.style.left && current?.style.top === next?.style.top
        && current?.page === next?.page ? current : next)
    }
    const update = (): void => {
      if (!active) return
      place(readRect(), parent?.getBoundingClientRect())
    }
    update()
    win.addEventListener('scroll', update, true)
    win.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    viewport?.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(anchor)
    observer?.observe(panel)
    if (parent != null) observer?.observe(parent)
    // Transforms and surrounding layout can move an anchor without resizing either element.
    let frame = 0
    const track = (): void => {
      if (!active) return
      const rect = readRect()
      const parentRect = parent?.getBoundingClientRect()
      if (boxes(rect, parentRect) !== lastBoxes) place(rect, parentRect)
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
  }, [
    open, anchorRef, panelRef, parentRef, placement, side, align, gap, margin,
    getAnchorRect, layoutKey, minWidthFromAnchor, frameClearance,
  ])
  return position
}
