/** Locally resizable raw-data panel; pointer capture owns the drag lifetime. */

import { useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './inspector.module.css'

/** Raw text and owner callbacks for one Inspector's detail panel. */
export type InspectorDetailsProps = PropsLocale<'session-inspector'> & {
  readonly text: string
  readonly failed?: boolean
  readonly children?: ReactNode
  readonly close: () => void
}

interface DetailDrag {
  readonly pointerId: number
  readonly y: number
  readonly height: number
  readonly available: number
}

function clampPercent(value: number): number { return Math.max(15, Math.min(80, value)) }

/**
 * Resize the raw-data area from its upper edge while keeping the table visible.
 * @param props - Complete raw text, localized labels, and close callback.
 * @returns Detail text with a pointer- and keyboard-operated horizontal separator.
 */
export function InspectorDetails({ text, failed, children, close, t }: InspectorDetailsProps) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<DetailDrag | null>(null)
  const [percent, setPercent] = useState(40)
  const resize = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    setPercent(clampPercent((current.height + current.y - event.clientY) / current.available * 100))
  }
  const stop = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div ref={panel} id={id} className={css.details} style={{ flexBasis: `${percent}%` }}>
    <div role="separator" tabIndex={0} aria-orientation="horizontal" aria-controls={id}
      aria-label={t('table.resizeDetails')} aria-valuemin={15} aria-valuemax={80} aria-valuenow={Math.round(percent)}
      className={css.detailsResize}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current !== null) return
        const element = panel.current
        const available = element?.parentElement?.getBoundingClientRect().height ?? 0
        if (element === null || available === 0) return
        event.preventDefault()
        drag.current = { pointerId: event.pointerId, y: event.clientY, height: element.getBoundingClientRect().height, available }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={resize}
      onPointerUp={(event) => { resize(event); stop(event) }}
      onPointerCancel={stop}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={(event) => {
        switch (event.key) {
          case 'ArrowUp': setPercent(value => clampPercent(value + 5)); break
          case 'ArrowDown': setPercent(value => clampPercent(value - 5)); break
          case 'Home': setPercent(15); break
          case 'End': setPercent(80); break
          default: return
        }
        event.preventDefault()
      }} />
    <div className={css.toolbar}><span>{t('table.raw')}</span><button type="button" onClick={close}>{t('table.close')}</button></div>
    {children === undefined ? <pre role={failed ? 'alert' : undefined}>{text}</pre>
      : <div className={css.objectDetails}>{children}</div>}
  </div>
}
