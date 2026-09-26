/** Floating controls shared by every zoomable document renderer. */
import { forwardRef, useEffect, useImperativeHandle, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconPlusOutlineRegular, Menu, Tooltip,
  type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { MAX_FIXED_ZOOM, MIN_FIXED_ZOOM, ZOOM_OPTIONS, ZOOM_STEP, type ZoomLabels } from './types.ts'
import css from './ZoomControls.module.css'

function steppedZoom(zoom: number, direction: -1 | 1): number {
  const step = direction === -1 ? Math.ceil(zoom / ZOOM_STEP) - 1 : Math.floor(zoom / ZOOM_STEP) + 1
  return Math.min(MAX_FIXED_ZOOM, Math.max(MIN_FIXED_ZOOM, step * ZOOM_STEP))
}

/** Live percentage display updated independently from the document tree. */
export interface ZoomControlsHandle {
  /** @param zoom - current gesture scale multiplier. */
  showZoom: (zoom: number) => void
}

/**
 * Present fit-width, fixed presets, and incremental controls.
 * @param props - current resolved zoom, preference mode, labels, and callbacks.
 * @returns a localized zoom toolbar.
 */
export const ZoomControls = forwardRef<ZoomControlsHandle, {
  readonly zoom: number
  readonly fitWidth: boolean
  readonly labels: ZoomLabels
  readonly visible: boolean
  readonly onZoom: (zoom: number) => void
  readonly onFitWidth: () => void
  readonly onActiveChange: (active: boolean) => void
}>(function ZoomControls({ zoom, fitWidth, labels, visible, onZoom, onFitWidth, onActiveChange }, ref): ReactNode {
  const [displayZoom, setDisplayZoom] = useState(zoom)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  useImperativeHandle(ref, () => ({ showZoom: setDisplayZoom }), [])
  useEffect(() => { onActiveChange(open || hovered || focused) }, [focused, hovered, onActiveChange, open])
  const items: readonly MenuEntry[] = [
    { id: 'fit-width', label: labels.fitWidth },
    { type: 'separator', id: 'fit-scale' },
    ...ZOOM_OPTIONS.map(value => ({ id: String(value), label: labels.value(value * 100) })),
  ]
  const selectedId = fitWidth ? 'fit-width'
    : ZOOM_OPTIONS.includes(displayZoom as typeof ZOOM_OPTIONS[number]) ? String(displayZoom) : undefined
  return <div className={`${css.panel} ${visible ? css.visible : ''}`} role="toolbar" aria-label={labels.controls}
    data-document-zoom-controls data-document-zoom-visible={visible || undefined}
    onPointerEnter={() => { setHovered(true) }} onPointerLeave={() => { setHovered(false) }}
    onFocusCapture={() => { setFocused(true) }} onBlurCapture={() => { setFocused(false) }}>
    <Tooltip label={labels.out} side="top">
      <span className={css.controlAnchor}><Button size="sm" className={css.zoomButton} aria-label={labels.out}
        disabled={displayZoom <= MIN_FIXED_ZOOM} onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { onZoom(steppedZoom(displayZoom, -1)) }}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </Button></span>
    </Tooltip>
    <Menu open={open} side="top" align="start" portal compact listClassName={css.zoomMenu}
      anchor={<Button size="sm" className={css.percent} aria-label={labels.menu} aria-expanded={open}
        onMouseDown={(event) => { event.preventDefault() }} onClick={() => { setOpen(value => !value) }}>
        <span>{labels.value(Math.round(displayZoom * 100))}</span>
        <IconChevronDownOutlineRegular size={12} />
      </Button>}
      items={items} selectedId={selectedId} onClose={() => { setOpen(false) }} onSelect={(selected) => {
        setOpen(false)
        if (selected === 'fit-width') onFitWidth()
        else onZoom(Number(selected))
      }} />
    <Tooltip label={labels.into} side="top">
      <span className={css.controlAnchor}><Button size="sm" className={css.zoomButton} aria-label={labels.into}
        disabled={displayZoom >= MAX_FIXED_ZOOM} onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { onZoom(steppedZoom(displayZoom, 1)) }}>
        <IconPlusOutlineRegular size={14} />
      </Button></span>
    </Tooltip>
  </div>
})
