/** Notification extension rendered inside the sidebar account menu. */
import { useEffect, useRef, type CSSProperties } from 'react'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { AccountNotice } from './notification-controller.ts'
import type { NotificationKey } from './locales.ts'
import css from './AccountNotifications.module.css'
import { dismissNotice } from './notice-transition.ts'

/** Notification view and interactions supplied by the notification plugin. */
export interface AccountNotificationsInjected {
  hooks: { notices: HostObservable<readonly AccountNotice[]> }
  /** @param id - notification that completed a displayed frame. */
  shown: (id: AccountNotice['id']) => void
  /** @param id - foreground notification whose non-dismiss action was clicked. */
  ctaClicked: (id: AccountNotice['id']) => void
  /** @param id - notification explicitly closed by the user. */
  dismiss: (id: AccountNotice['id']) => void
}

/** Notification component props derived from its parent-owned slot. */
export type AccountNotificationsProps = PropsRuntime<'settings.launcher.notifications'>
  & InjectFace<AccountNotificationsInjected> & PropsLocale<'account.notifications'>

/** @param props - account-menu availability and notification content. @returns the anchored notification stack. */
export function AccountNotifications({ active, openAccount, useNotices, shown, ctaClicked, dismiss, t }: AccountNotificationsProps) {
  const notices = useNotices(value => value)
  return active && <AccountNoticeStack notices={notices} closeLabel={t('close')}
    onOpenAccount={openAccount} onShown={shown} onCtaClicked={ctaClicked} onDismiss={dismiss} />
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'account.notifications': NotificationKey }
}

/* v8 ignore next 3 -- closed-union defaults only defend future source widening */
function assertNever(_value: never): never {
  throw new Error('unsupported account notification target')
}

/** @param displayUntil - server display deadline. @returns whether the notification remains eligible for display. */
function live(displayUntil: string | null): boolean {
  if (displayUntil === null) return true
  const expires = Date.parse(displayUntil)
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

/** @param props - server-ordered notices, localized fallback copy, and display callbacks.
 * @returns a non-modal stack whose foreground card alone can report display or be closed.
 */
export function AccountNoticeStack({ notices, closeLabel, onShown, onCtaClicked, onDismiss, onOpenAccount }: {
  notices: readonly AccountNotice[]
  closeLabel: string
  /** Open the account settings route while retaining the notification. */
  onOpenAccount: () => void
  /** Called after the foreground card has passed a visible presented frame. */
  onShown: (id: AccountNotice['id']) => void
  /** Called when the user clicks any non-dismiss action on the foreground card. */
  onCtaClicked: (id: AccountNotice['id']) => void
  /** Called when the user closes the foreground card. */
  onDismiss: (id: AccountNotice['id']) => void
}) {
  const liveNotices = notices.filter(notice => live(notice.displayUntil))
  return <div className={css.stack}>
    {liveNotices.map((notice, depth) => <NoticeCard key={notice.id} notice={notice} depth={depth}
      closeLabel={closeLabel}
      onShown={onShown} onCtaClicked={onCtaClicked} onDismiss={onDismiss} onOpenAccount={onOpenAccount} />)}
  </div>
}

/** One stable card node remains mounted as the cards before it are dismissed. */
function NoticeCard({ notice, depth, closeLabel, onShown, onCtaClicked, onDismiss, onOpenAccount }: {
  notice: AccountNotice
  depth: number
  closeLabel: string
  onOpenAccount: () => void
  onShown: (id: AccountNotice['id']) => void
  onCtaClicked: (id: AccountNotice['id']) => void
  onDismiss: (id: AccountNotice['id']) => void
}) {
  const foreground = depth === 0
  const card = useRef<HTMLElement>(null)
  const reported = useRef(false)
  const actionSlots = new Map<string, number>()
  useEffect(() => {
    if (!foreground || reported.current || !live(notice.displayUntil)) return
    const element = card.current
    /* v8 ignore next -- React attaches the card ref before running this effect. */
    if (element === null) return
    let intersecting = false
    let cancel: (() => void) | undefined
    const visible = () => intersecting && document.visibilityState !== 'hidden' && !element.closest('[hidden], [inert]')
    const attempt = () => {
      if (reported.current || cancel !== undefined || !live(notice.displayUntil)) return
      if (!visible()) return
      cancel = afterPaint(() => {
        cancel = undefined
        if (reported.current || !visible() || !live(notice.displayUntil)) return
        reported.current = true
        onShown(notice.id)
      })
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        intersecting = entry.isIntersecting
        attempt()
      }
    })
    observer.observe(element)
    document.addEventListener('visibilitychange', attempt)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', attempt)
      cancel?.()
    }
  }, [foreground, notice.id, notice.displayUntil, onShown])
  return <aside ref={card} className={css.card} data-front={foreground} aria-hidden={!foreground}
    style={{ '--notice-depth': depth, '--notice-scale': Math.pow(252 / 260, depth) } as CSSProperties}>
    <div role="status" className={css.copy}>
      <div className={css.title}><span className={css.icon} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3.6355 6.93969C3.6355 4.8398 5.33779 3.1375 7.43768 3.1375C9.53757 3.1375 11.23987 4.8398 11.23987 6.93968V11.363H3.6355V6.93969Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="0.875" />
          <path d="M1.641 11.3645H12.36M5.053 13.3095H8.9479M7.4375 4.27422V2.70137912" stroke="currentColor" strokeWidth="0.875" />
        </svg>
      </span><span>{notice.title}</span></div>
      <p>{notice.body}</p>
    </div>
    {notice.actions.length > 0 && <div className={css.actions}>
      {notice.actions.map((action) => {
        const target = JSON.stringify(action.target)
        const occurrence = actionSlots.get(target) ?? 0
        actionSlots.set(target, occurrence + 1)
        return <Button key={`${target}:${occurrence}`} size="sm" className={css.action}
          variant={action.style === 'primary' ? 'primary' : 'outline'} tabIndex={foreground ? undefined : -1}
          onClick={(event) => {
            if (action.target.type !== 'dismiss') onCtaClicked(notice.id)
            switch (action.target.type) {
              case 'app_route': onOpenAccount(); break
              case 'dismiss': dismissNotice(event.currentTarget.closest('aside') as HTMLElement, () => { onDismiss(notice.id) }); break
              /* v8 ignore next -- the Host validates both supported target variants */
              default: assertNever(action.target)
            }
          }}>{action.label}</Button>
      })}
    </div>}
    <button type="button" tabIndex={foreground ? undefined : -1} className={css.close} aria-label={closeLabel} onClick={(event) => { dismissNotice(event.currentTarget.parentElement as HTMLElement, () => { onDismiss(notice.id) }) }}><IconCloseOutlineRegular size={10} /></button>
  </aside>
}
