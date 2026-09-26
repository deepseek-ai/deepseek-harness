/** Account-owned take-over of the frame-wide quota notice for account balances. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Toast, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, HostObservable, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { PlatformPageClaim, PlatformPages } from './platform-pages.ts'

/** Injected share of the account route's frame-wide quota notice entry. */
export interface AccountQuotaNoticeInjected {
  /** Desktop-only: show one page in the account feature's shared native host; absent in ordinary browsers. */
  openPlatformPage?: PlatformPages['open']
  hooks: {
    account: HostObservable<AccountSnapshot>
    /** The page the shared host is showing, or null while it is closed. */
    platformPage: HostObservable<PlatformPageClaim | null>
  }
}

type AccountQuotaNoticeProps = PropsRuntime<'shell.quota-notice'>
  & { matched: QuotaNoticeOwnerProps }
  & PropsLocale<'settings.account'>
  & InjectFace<AccountQuotaNoticeInjected>

/**
 * @param props - the claimed notice, account state, and the shared Platform page channel.
 * @returns the balance Modal, nothing while awaiting account state or a Platform page's return, or the fallback Toast.
 */
export function AccountQuotaNotice({ matched, openPlatformPage, useAccount, usePlatformPage, t }: AccountQuotaNoticeProps) {
  const { dismiss, keepOpen, message } = matched
  const accountStatus = useAccount(snapshot => snapshot.view?.status)
  const accountFailed = useAccount(snapshot => snapshot.failed)
  const signedIn = accountStatus === 'credential-stored'
  const platformPage = usePlatformPage(current => current)
  const [opened, setOpened] = useState(false)
  const previousSignedIn = useRef(signedIn)
  // Both claims are tied to this entry's lifetime: an unmount that the notice
  // never asked for (a higher-priority chain entry, plugin reload, or a crash)
  // must not strand the hold or leave the shared page mounted.
  const releaseHold = useRef<(() => void) | undefined>(undefined)
  const releasePage = useRef<(() => void) | undefined>(undefined)
  const releaseClaims = () => {
    releasePage.current?.()
    releasePage.current = undefined
    releaseHold.current?.()
    releaseHold.current = undefined
  }
  useEffect(() => releaseClaims, [])
  useEffect(() => {
    // The notice outlives the panel that raised it, so only a real sign-out takes
    // the balance surface down; the first, still unloaded snapshot must not.
    if (previousSignedIn.current && !signedIn) {
      releaseClaims()
      dismiss()
    }
    previousSignedIn.current = signedIn
  }, [dismiss, signedIn])
  // Await the first account snapshot without letting a Toast timer discard the
  // notice before the native account action becomes available. A terminal stream
  // failure ends that wait and leaves the generic warning available.
  if (accountStatus === undefined && !accountFailed && openPlatformPage !== undefined) return null
  // Signed out, unavailable, or without the native host, use generic notice copy.
  if (!signedIn || openPlatformPage === undefined) {
    return <Toast text={message} icon={<IconWarningOutlineRegular size={18} />} onDone={dismiss} />
  }
  // Defer the Modal until the native page closes; do not mount hidden focus or
  // Escape handlers under the opaque view.
  if (opened || platformPage !== null) return null
  return <Modal open title={t('quotaTitle')} closeLabel={t('close')} onClose={dismiss}
    description={t('quotaDescription')}
    footer={<>
      <Button variant="outline" onClick={dismiss}>{t('cancel')}</Button>
      <Button variant="primary" onClick={() => {
        // Retain the notice before its page mounts; a later failure would
        // otherwise republish it and remount this entry.
        releaseHold.current = keepOpen()
        releasePage.current = openPlatformPage('top-up', () => { releasePage.current = undefined; dismiss() })
        setOpened(true)
      }}>{t('quotaTopUp')}</Button>
    </>} />
}
