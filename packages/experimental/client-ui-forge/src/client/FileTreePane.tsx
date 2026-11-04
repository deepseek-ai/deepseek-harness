/** Resizable file navigation; width belongs to the mounted tab and survives hiding the pane. */

import clsx from 'clsx'
import changesCss from './ChangesTab.module.css'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChangedFiles, type ChangedFilesProps } from './ChangedFiles.tsx'
import css from './FileTreePane.module.css'

const MIN_WIDTH = 200
const MAX_WIDTH = 600
const DIFF_MIN_WIDTH = 320

/** Placement of a tab's file navigator; hiding it retains its viewing choices. */
export type FileTreePosition = 'right' | 'left' | 'hidden'

/**
 * Render a keyboard- and pointer-resizable tree beside the diff.
 * @param props - tree rows, pane position, and the toggle's controlled element id.
 * @returns the bounded pane and its resize separator.
 */
export function FileTreePane({ position, id, ...props }: ChangedFilesProps & {
  readonly position: FileTreePosition
  readonly id: string
}): ReactNode {
  const pane = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null)
  const [width, setWidth] = useState(240)
  const [maximum, setMaximum] = useState(MAX_WIDTH)
  useLayoutEffect(() => {
    const parent = pane.current?.parentElement
    if (parent === undefined || parent === null) return
    const measure = (): void => {
      const available = parent.clientWidth
      // A retained tab has no measurable width while its session or pane is hidden.
      if (available === 0) return
      setMaximum(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - DIFF_MIN_WIDTH)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => { observer.disconnect() }
  }, [])
  const shown = Math.min(width, maximum)
  const direction = position === 'left' ? 1 : -1
  const resize = (next: number): void => { setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(maximum, next)))) }
  return <div ref={pane} className={clsx(css.pane, changesCss.treePane)} data-position={position} hidden={position === 'hidden'} style={{ width: shown }}>
    <div className={css.resize} role="separator" tabIndex={0} aria-label={props.t('diff.resizeFileTree')}
      aria-orientation="vertical" aria-controls={id} aria-valuemin={MIN_WIDTH} aria-valuemax={maximum} aria-valuenow={shown}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointer: event.pointerId, x: event.clientX, width: shown }
      }}
      onPointerMove={(event) => {
        const active = drag.current
        if (active?.pointer === event.pointerId) resize(active.width + direction * (event.clientX - active.x))
      }}
      onPointerUp={(event) => {
        const active = drag.current
        if (active?.pointer !== event.pointerId) return
        resize(active.width + direction * (event.clientX - active.x))
        drag.current = null
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        resize(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maximum : shown + direction * (event.key === 'ArrowRight' ? 20 : -20))
      }} />
    <nav id={id} className={css.navigation} aria-label={props.t('diff.allFiles', { count: props.files.length })}>
      <ChangedFiles {...props} />
    </nav>
  </div>
}
