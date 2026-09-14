import { useEffect, useState } from 'react'
import { IconCheckOutline16, IconLoadingOutline16, IconRefreshOutline14 } from './icons/index.tsx'
import css from './ConnectionIndicator.module.css'

/** Visual state rendered by {@link ConnectionIndicator}. */
export type ConnectionIndicatorState =
  | 'disconnected'
  | 'connecting'
  | 'recovered'

/** Exit-transition length; keep equal to the `.leaving` transition duration in the stylesheet. */
const EXIT_MS = 150

/**
 * Render an inline connection-recovery control. The outage and retry-attempt
 * states are one button whose static label already names the retry action;
 * clicking it requests an immediate reconnect. The indicator animates in on
 * appearance and fades out for {@link EXIT_MS} before unmounting.
 * @param props.state - visible outage, retry-attempt, or recovered state.
 * @param props.disconnectedLabel - localized outage text naming the retry action.
 * @param props.connectingLabel - localized retry text followed by the attempt dots.
 * @param props.recoveredLabel - localized recovery confirmation.
 * @param props.reconnectActionLabel - accessible label for the outage action.
 * @param props.restartActionLabel - accessible label for replacing an active attempt.
 * @param props.onReconnect - request an immediate reconnect attempt.
 * @returns the indicator, or null when no connection feedback is active.
 */
export function ConnectionIndicator({
  state,
  disconnectedLabel,
  connectingLabel,
  recoveredLabel,
  reconnectActionLabel,
  restartActionLabel,
  onReconnect,
}: {
  state: ConnectionIndicatorState | undefined
  disconnectedLabel: string
  connectingLabel: string
  recoveredLabel: string
  reconnectActionLabel: string
  restartActionLabel: string
  onReconnect: () => void
}) {
  const [rendered, setRendered] = useState(state)
  const leaving = state === undefined && rendered !== undefined
  useEffect(() => {
    if (state !== undefined) {
      setRendered(state)
      return
    }
    if (rendered === undefined) return
    const timeout = window.setTimeout(() => { setRendered(undefined) }, EXIT_MS)
    return () => { window.clearTimeout(timeout) }
  }, [state, rendered])

  if (rendered === undefined) return null
  const leavingClass = leaving ? ` ${css.leaving}` : ''
  if (rendered === 'recovered') {
    return (
      <div
        className={`${css.indicator} ${css.success}${leavingClass}`}
        role="status"
        aria-label={recoveredLabel}
      >
        <span className={css.icon} aria-hidden="true"><IconCheckOutline16 size={14} /></span>
        <span className={css.label}>{recoveredLabel}</span>
      </div>
    )
  }

  const connecting = rendered === 'connecting'
  return (
    <button
      type="button"
      className={`${css.indicator} ${css.warning}${leavingClass}`}
      data-phase={rendered}
      aria-label={connecting ? restartActionLabel : reconnectActionLabel}
      onClick={onReconnect}
    >
      <span className={css.icon} aria-hidden="true">
        {connecting
          ? <IconLoadingOutline16 size={14} className={css.spinner} />
          : <IconRefreshOutline14 size={14} />}
      </span>
      <span className={css.label}>
        {connecting
          ? (
            <>
              {connectingLabel}
              <span className={css.dots} aria-hidden="true">
                <span>.</span>
                <span className={css.secondDot}>.</span>
                <span className={css.thirdDot}>.</span>
              </span>
            </>
          )
          : disconnectedLabel}
      </span>
    </button>
  )
}
