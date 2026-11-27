/** Floating controls shared by every zoomable document renderer. */
import clsx from 'clsx'
import { forwardRef, useEffect, useImperativeHandle, useState, type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { IconChevronDownOutlineRegular, IconPlusOutlineRegular } from './icons/index.tsx'
import { Menu, type MenuEntry } from './Menu.tsx'
import { Tooltip } from './Tooltip.tsx'
import { DOCUMENT_ZOOM, type DocumentZoomLabels } from './document-zoom.ts'
import css from './ZoomControls.module.css'

function steppedZoom(zoom: number, direction: -1 | 1): number {
  const step = direction === -1 ? Math.ceil(zoom / DOCUMENT_ZOOM.step) - 1 : Math.floor(zoom / DOCUMENT_ZOOM.step) + 1
  return Math.min(DOCUMENT_ZOOM.maximum, Math.max(DOCUMENT_ZOOM.minimum, step * DOCUMENT_ZOOM.step))
}

/** Live percentage display updated independently from the document tree. */
export interface ZoomControlsHandle {
  /** @param zoom - current gesture scale multiplier. */
  showZoom: (zoom: number) => void
}

/**
 * Present optional fitting, fixed presets, and incremental controls.
 * @param props - committed `zoom`, optional `fit` row (omitted: no fitting row), localized labels, `visible`, optional
 *   owner `className`, and zoom and activity callbacks.
 * @param ref - `showZoom` displays a transient scale until `zoom` changes.
 * @returns a localized zoom toolbar.
 */
export const ZoomControls = forwardRef<ZoomControlsHandle, {
  readonly zoom: number
  readonly fit?: { readonly label: string; readonly selected: boolean; readonly onSelect: () => void } | undefined
  readonly className?: string | undefined
  readonly labels: DocumentZoomLabels
  readonly visible: boolean
  readonly onZoom: (zoom: number) => void
  readonly onActiveChange: (active: boolean) => void
}>(function ZoomControls({
  zoom, fit, className, labels, visible, onZoom, onActiveChange,
}, ref): ReactNode {
  const [committed, setCommitted] = useState(zoom)
  const [transient, setTransient] = useState<number>()
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  if (committed !== zoom) {
    setCommitted(zoom)
    setTransient(undefined)
  }
  const displayZoom = transient ?? zoom
  useImperativeHandle(ref, () => ({ showZoom: setTransient }), [])
  useEffect(() => { onActiveChange(open || hovered || focused) }, [focused, hovered, onActiveChange, open])
  const items: readonly MenuEntry[] = [
    ...(fit === undefined ? [] : [{ id: 'fit', label: fit.label }, { type: 'separator' as const, id: 'fit-scale' }]),
    ...DOCUMENT_ZOOM.presets.map(value => ({ id: String(value), label: labels.value(value * 100) })),
  ]
  const selectedId = fit?.selected === true ? 'fit'
    : DOCUMENT_ZOOM.presets.some(value => value === displayZoom) ? String(displayZoom) : undefined
  return <div className={clsx(css.panel, visible && css.visible, className)} role="toolbar" aria-label={labels.controls}
    data-document-zoom-controls data-document-zoom-visible={visible || undefined}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') setHovered(true) }} onPointerLeave={() => { setHovered(false) }}
    onFocusCapture={() => { setFocused(true) }} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
    }}>
    <Tooltip label={labels.out} side="top">
      <span className={css.controlAnchor}><Button size="sm" className={css.zoomButton} aria-label={labels.out}
        disabled={displayZoom <= DOCUMENT_ZOOM.minimum} onMouseDown={(event) => { event.preventDefault() }}
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
        if (selected === 'fit') fit?.onSelect()
        else onZoom(Number(selected))
      }} />
    <Tooltip label={labels.into} side="top">
      <span className={css.controlAnchor}><Button size="sm" className={css.zoomButton} aria-label={labels.into}
        disabled={displayZoom >= DOCUMENT_ZOOM.maximum} onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { onZoom(steppedZoom(displayZoom, 1)) }}>
        <IconPlusOutlineRegular size={14} />
      </Button></span>
    </Tooltip>
  </div>
})
