/** The `shell.overlay` entry that renders the account feature's shared native Platform page. */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PlatformPageClaim } from './platform-pages.ts'
import { PlatformOverlay, type PlatformBridge } from './PlatformOverlay.tsx'

/** Injected share of the shared Platform host. */
export interface AccountPlatformHostInjected {
  platform: PlatformBridge
  hooks: { page: HostObservable<PlatformPageClaim | null> }
  /**
   * Viewer returned: drop the live request, notifying its owner with the reason
   * the page stopped being live. Post-return reads belong to the requesting
   * surface; this host closes the page and nothing else.
   */
  closePage(this: void): void
}

/** Composed props of the shared Platform host. */
export type AccountPlatformHostProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<AccountPlatformHostInjected>

/**
 * @param props - the native commands, the live page request, and its dismissal.
 * @returns the native Platform container, or null while no page is requested.
 */
export function AccountPlatformHost({ platform, usePage, closePage, t }: AccountPlatformHostProps) {
  const claim = usePage(current => current)
  if (claim === null) return null
  return <PlatformOverlay bridge={platform} page={claim.page} backLabel={t('backToHarness')}
    loadingLabel={t('loading')} failureLabel={t('platformFailed')} retryLabel={t('platformRetry')}
    onClose={closePage} />
}
