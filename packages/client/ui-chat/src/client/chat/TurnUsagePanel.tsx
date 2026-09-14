// Icon-row Turn-stat actions: a database pill labelled with the turn total
// click-opens the per-Turn usage dialog, and a clock pill labelled with the
// turn wall time click-opens the Turn-time dialog. Both sit right of the
// branch action in the tail's IconActions row, ahead of the plain clock text.

import { createPortal } from 'react-dom'
import { IconClockOutline16, IconDatabaseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTokenUsage } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatLatencySeconds, formatRunDuration, formatTokensPerSecond } from './message-chrome.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './TurnUsagePanel.module.css'
import dialogCss from './stat-dialog.module.css'

export interface TurnUsagePanelProps {
  usage: TurnTokenUsage
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

export interface TurnTimePanelProps {
  /** Turn wall time in ms, the pill's label. */
  runMs: number
  /** Turn decode throughput, a dialog row when known. */
  tokensPerSecond?: number | undefined
  /** Turn first-step TTFT in ms, a dialog row when known. */
  ttftMs?: number | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

function formatCompactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatTokens(value, t) })
}

function formatExactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

/**
 * Turn-usage IconActions pill with a click-open Turn-usage details dialog.
 * @param props - Turn usage buckets and locale seat.
 * @returns The trigger and, while open, its portaled dialog anchored above the trigger.
 */
export function TurnUsagePanel({ usage, t }: TurnUsagePanelProps) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()

  const cacheHit = usage.cacheReadTokens === undefined
    ? null
    : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1)
  const total = formatCompactCount(usage.totalTokens, t)
  const routes = usage.routes?.map(route => `${route.provider}/${route.model}`).join(', ') ?? ''

  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconDatabaseOutline16 />
        <span className={css.label}>{t('message.turnUsage.consumed', { total })}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('message.turnUsage.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconDatabaseOutline16 />
              {t('message.turnUsage.title')}
            </span>
            <span className={dialogCss.titleValue}>{formatExactCount(usage.totalTokens, t)}</span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-turn-usage-details>
            {routes !== '' && (
              <>
                <dt>{t('message.turnUsage.model')}</dt>
                <dd className={dialogCss.route}>{routes}</dd>
              </>
            )}
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnUsage.cacheHit')}</dt>
                <dd>{`${cacheHit}%`}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{formatExactCount(usage.uncachedInputTokens, t)}</dd>
            {usage.cacheReadTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheRead')}</dt>
                <dd>{formatExactCount(usage.cacheReadTokens, t)}</dd>
              </>
            )}
            {usage.cacheWriteTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheWrite')}</dt>
                <dd>{formatExactCount(usage.cacheWriteTokens, t)}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>
              {formatExactCount(usage.outputTokens, t)}
              {usage.reasoningTokens !== undefined && (
                <span className={dialogCss.reasoning}>
                  {t('message.turnUsage.reasoning', { tokens: formatExactCount(usage.reasoningTokens, t) })}
                </span>
              )}
            </dd>
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * Turn-time IconActions pill with a click-open Turn-time details dialog.
 * @param props - Turn timing facts and locale seat.
 * @returns The clock-and-duration trigger and, while open, its portaled dialog anchored above the trigger.
 */
export function TurnTimePanel({ runMs, tokensPerSecond, ttftMs, t }: TurnTimePanelProps) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconClockOutline16 />
        <span className={css.label}>{t('message.ranFor', { duration: formatRunDuration(runMs, t) })}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('message.turnTime.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconClockOutline16 />
              {t('message.turnTime.title')}
            </span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-turn-time-details>
            <dt>{t('message.turnTime.duration')}</dt>
            <dd>{formatRunDuration(runMs, t)}</dd>
            {tokensPerSecond !== undefined && (
              <>
                <dt>{t('message.turnTime.speed')}</dt>
                <dd>{t('message.tokensPerSecond', { tps: formatTokensPerSecond(tokensPerSecond) })}</dd>
              </>
            )}
            {ttftMs !== undefined && (
              <>
                <dt>{t('message.turnTime.ttft')}</dt>
                <dd>{t('duration.seconds', { seconds: formatLatencySeconds(ttftMs) })}</dd>
              </>
            )}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}
