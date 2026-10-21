/** Offscreen snapshots for native Workspace and Session row dragging. */
import { useEffect, useMemo, useRef } from 'react'
import type { DragEvent } from 'react'
import css from './Rows.module.css'

/**
 * Own a row's inert drag preview until drag end, replacement, or unmount.
 * The offscreen copy keeps WebKit snapshots separate from overlapping panels.
 * Its cloned slot DOM remains in document.body for that lifetime; query live rows
 * within their list to exclude duplicate text and element IDs.
 * @returns preview callbacks; cleanup reports whether this row started a drag,
 * even when its preview failed or the row became non-draggable before drag end.
 */
export function useRowDragPreview(): {
  start: (event: DragEvent<HTMLElement>) => void
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
      start: (event: DragEvent<HTMLElement>): void => {
        clear()
        dragging.current = true
        const row = event.currentTarget
        const rect = row.getBoundingClientRect()
        const style = getComputedStyle(row)
        const copy = row.cloneNode(true) as HTMLElement
        copy.removeAttribute('data-row-key')
        copy.tabIndex = -1
        for (const control of copy.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex], [contenteditable]',
        )) control.tabIndex = -1
        copy.style.color = style.color
        const image = row.ownerDocument.createElement('div')
        image.className = css.dragPreview as string
        image.inert = true
        image.setAttribute('aria-hidden', 'true')
        Object.assign(image.style, {
          left: `${String(-rect.width)}px`, width: `${String(rect.width)}px`,
          height: `${String(rect.height)}px`, font: style.font,
        })
        image.style.setProperty('--dsh-workspace-indent', style.getPropertyValue('--dsh-workspace-indent'))
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
  }, [])
  useEffect(() => () => { preview.clear() }, [preview])
  return preview
}
