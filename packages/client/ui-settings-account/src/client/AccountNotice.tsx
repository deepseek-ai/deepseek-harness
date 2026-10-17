/**
 * Sidebar bonus notice. The card reports a display once it has a position, the
 * document is visible, and it has painted one frame: that is the whole signal,
 * and the card measures no cover, so a painted card behind the open Settings
 * overlay reports the same way as any other. Closing counts as a display too,
 * because the user acted on it. An award that expired before a render is not
 * drawn at all.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BonusNotice } from './bonus-notices.ts'
import css from './AccountNotice.module.css'
import { dismissNotice } from './notice-transition.ts'

/** @param expiresAt - server expiration timestamp. @returns whether the award can still be spent. */
function live(expiresAt: string): boolean {
  if (expiresAt === '') return true
  const expires = Date.parse(expiresAt)
  // An unparsable timestamp is not evidence of expiry, so the notice still shows.
  return Number.isNaN(expires) || expires > Date.now()
}

/**
 * @param run - callback to invoke once one presented frame has passed.
 * @returns a canceller for a card that unmounts or hides first.
 */
function afterPaint(run: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    // Without a frame clock, the following task is the best available paint boundary.
    const timer = setTimeout(run, 0)
    return () => { clearTimeout(timer) }
  }
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const frame = requestAnimationFrame(() => {
    // The frame callback runs before its paint; the following task runs after it.
    timer = setTimeout(() => {
      if (!cancelled) run()
    }, 0)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** @param props - server-ordered notices, localized fallback copy, anchor, and display callbacks.
 * @returns a non-modal stack whose foreground card alone can report display or be closed.
 */
export function AccountNoticeStack({ notices, anchor, title, closeLabel, onShown, onDismiss }: {
  notices: readonly BonusNotice[]
  anchor: RefObject<HTMLElement>
  title: string
  closeLabel: string
  /** Called after the foreground card has passed a visible presented frame. */
  onShown: (orderId: BonusNotice['orderId']) => void
  /** Called when the user closes the foreground card. */
  onDismiss: (orderId: BonusNotice['orderId']) => void
}) {
  const [position, setPosition] = useState<{ left: number; bottom: number }>()
  useLayoutEffect(() => {
    if (!anchor.current) return
    const element = anchor.current
    const update = () => {
      const rect = element.getBoundingClientRect()
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
        bottom: Math.max(8, window.innerHeight - rect.top + 4) })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])
  const liveNotices = notices.filter(notice => live(notice.expiresAt))
  return createPortal(<div className={css.stack} style={position ?? { visibility: 'hidden' }}>
    {liveNotices.map((notice, depth) => <NoticeCard key={notice.orderId} notice={notice} depth={depth}
      ready={position !== undefined} title={notice.title ?? title} closeLabel={closeLabel}
      onShown={onShown} onDismiss={onDismiss} />)}
  </div>, document.body)
}

/** One stable card node remains mounted as the cards before it are dismissed. */
function NoticeCard({ notice, depth, ready, title, closeLabel, onShown, onDismiss }: {
  notice: BonusNotice
  depth: number
  ready: boolean
  title: string
  closeLabel: string
  onShown: (orderId: BonusNotice['orderId']) => void
  onDismiss: (orderId: BonusNotice['orderId']) => void
}) {
  const foreground = depth === 0
  const reported = useRef(false)
  useEffect(() => {
    if (!ready || !foreground || reported.current || !live(notice.expiresAt)) return
    let cancel: (() => void) | undefined
    const attempt = () => {
      if (reported.current || cancel !== undefined || !live(notice.expiresAt)) return
      if (document.visibilityState === 'hidden') return
      cancel = afterPaint(() => {
        cancel = undefined
        if (reported.current || document.visibilityState === 'hidden' || !live(notice.expiresAt)) return
        reported.current = true
        onShown(notice.orderId)
      })
    }
    attempt()
    document.addEventListener('visibilitychange', attempt)
    return () => {
      document.removeEventListener('visibilitychange', attempt)
      cancel?.()
    }
  }, [ready, foreground, notice.orderId, notice.expiresAt, onShown])
  return <aside className={css.card} data-front={foreground} aria-hidden={!foreground}
    style={{ '--notice-depth': depth, '--notice-scale': Math.pow(272 / 280, depth) } as CSSProperties}>
    <div role="status" className={css.copy}>
      <div className={css.title}><span className={css.icon} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3.6355 6.93969C3.6355 4.8398 5.33779 3.1375 7.43768 3.1375C9.53757 3.1375 11.23987 4.8398 11.23987 6.93968V11.363H3.6355V6.93969Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="0.875" />
          <path d="M1.641 11.3645H12.36M5.053 13.3095H8.9479M7.4375 4.27422V2.70137912" stroke="currentColor" strokeWidth="0.875" />
        </svg>
      </span><span>{title}</span></div>
      <p>{notice.message}</p>
    </div>
    <button type="button" tabIndex={foreground ? undefined : -1} className={css.close} aria-label={closeLabel} onClick={(event) => { dismissNotice(event.currentTarget.parentElement as HTMLElement, () => { onDismiss(notice.orderId) }) }}><IconCloseOutlineRegular size={10} /></button>
  </aside>
}
