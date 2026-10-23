/** Offscreen row snapshots for native browser dragging. */
import { useEffect, useMemo, useRef } from 'react'
import type { DragEvent } from 'react'
import clsx from 'clsx'
import css from './RowDragPreview.module.css'

/**
 * Own a row's inert drag preview until drag end, replacement, or unmount.
 * The offscreen copy keeps WebKit snapshots separate from overlapping panels.
 * Its cloned slot DOM remains in document.body for that lifetime; query live rows
 * within their list to exclude duplicate text and element IDs.
 * @param className - preview background matching the row's surface; WebKit fills
 * transparent snapshot pixels white, including rounded corners.
 * @returns preview callbacks; cleanup reports whether this row started a drag,
 * even when its preview failed or the row became non-draggable before drag end.
 * Start accepts the source row when a child handle owns the drag event.
 */
export function useRowDragPreview(className: string): {
  start: (event: DragEvent<HTMLElement>, row?: HTMLElement) => void
  clear: () => boolean
} {
  const current = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const preview = useMemo(() => {
    const clear = (): boolean => {
      const wasDragging = dragging.current
      dragging.current = false
      current.current?.remove()
      current.current = null
      return wasDragging
    }
    return {
      clear,
      start: (event: DragEvent<HTMLElement>, row = event.currentTarget): void => {
        clear()
        dragging.current = true
        const rect = row.getBoundingClientRect()
        const style = getComputedStyle(row)
        const copy = row.cloneNode(true) as HTMLElement
        copy.removeAttribute('data-row-key')
        copy.tabIndex = -1
        for (const control of copy.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex], [contenteditable]',
        )) control.tabIndex = -1
        copy.style.color = style.color
        copy.style.paddingInlineStart = style.paddingInlineStart
        const image = row.ownerDocument.createElement('div')
        image.className = clsx(css.preview, className)
        image.inert = true
        image.setAttribute('aria-hidden', 'true')
        Object.assign(image.style, {
          left: `${String(-rect.width)}px`, width: `${String(rect.width)}px`,
          height: `${String(rect.height)}px`, font: style.font,
        })
        image.append(copy)
        row.ownerDocument.body.append(image)
        current.current = image
        try {
          event.dataTransfer.setDragImage(image, event.clientX - rect.left, event.clientY - rect.top)
        } catch (_error) {
          // Browsers may reject a custom image; retain native dragging without the copy.
          image.remove()
          current.current = null
        }
      },
    }
  }, [className])
  useEffect(() => () => { preview.clear() }, [preview])
  return preview
}
