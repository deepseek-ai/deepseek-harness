// @vitest-environment jsdom
/** Desktop account operations and ordinary-browser isolation in the shipped client composition. */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {
  AccountBonusBatch, AccountBonusOrderId, AccountDetails, AccountUserId, AccountView, SignInAttemptId,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Config as OnboardingConfig } from '../src/index.ts'
import { ChatSettingsSchema as ChatConfig } from '../../ui-chat/src/chat-settings.ts'
import { DeveloperToolsSettingsSchema as SettingsConfig } from '../../ui-settings/src/developer-tools-settings.ts'
import type { DesktopOnboardingInjected } from '../src/client/DesktopOnboardingEntry.tsx'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'
import { CONTACT_CONFIG_GLOBAL } from '../src/contact-config.ts'
import { AccountPlatformHost } from '../src/client/AccountPlatformHost.tsx'
import type { AccountPlatformHostInjected } from '../src/client/AccountPlatformHost.tsx'
import { AccountQuotaNotice } from '../src/client/AccountQuotaNotice.tsx'
import type { AccountQuotaNoticeInjected } from '../src/client/AccountQuotaNotice.tsx'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-account'
const view: AccountView = {
  status: 'signed-out', attempt: null,
  links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
}
const stored: AccountView = { ...view, status: 'credential-stored' }
const profile: AccountDetails['profile'] = { status: 'ready', value: { id: 'account-user' as AccountUserId, name: 'User', contact: null } }
/** @param orderId - server order. @param message - server copy. @returns one unnotified bonus for this account. */
function bonus(orderId: string, message = 'Awarded 5.00'): AccountBonusBatch {
  return {
    accountId: 'account-user' as AccountUserId,
    bonuses: [{
      orderId: orderId as AccountBonusOrderId, campaign: 'dsh_login_bonus', amount: '5.00', currency: 'CNY',
      grantedAt: '2026-09-21T12:00:00Z', expiresAt: '2099-01-01T00:00:00Z', message,
    }],
  }
}
function operations(c: TestClient): AccountSectionInjected {
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  return injected as AccountSectionInjected
}
/** The account take-over registered into the Chat-owned frame-wide quota notice chain. */
function quotaNoticeEntry(c: TestClient) {
  return c.ctx.slots.entries('shell.quota-notice').find(entry => entry.component === AccountQuotaNotice)
}
/** The account feature's one shared native Platform page host. */
function platformHostEntry(c: TestClient) {
  return c.ctx.slots.entries('shell.overlay').find(entry => entry.component === AccountPlatformHost)
}
/** One registered entry's injected share, read through the same object-narrowing the account operations use. */
function injectedOf(entry: { inject?: (() => object) | undefined }): object {
  const injected: object = entry.inject!()
  return injected
}
beforeEach(() => { vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('keeps account UI and account RPC inactive in a plain browser, including after reload', async ({ start, mock }) => {
  const c = await start()
  for (const reload of [false, true]) {
    if (reload) await c.reload(SELF)
    await c.flush()
    expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
    expect(c.ctx.slots.entries('settings.models.sign-in')).toHaveLength(0)
    expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
    expect(quotaNoticeEntry(c)).toBeUndefined()
    expect(platformHostEntry(c)).toBeUndefined()
    expect(mock.log.calls().filter(call => call.endpoint.startsWith('account/'))).toEqual([])
    expect(mock.log.streams().filter(stream => stream.endpoint.startsWith('account/'))).toEqual([])
  }
}, 60_000)

it('claims account balance notices from the frame-wide quota chain and declines generic quota', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const entry = quotaNoticeEntry(c)
  expect(entry).toBeDefined()
  const select = entry!.select! as (owner: QuotaNoticeOwnerProps) => QuotaNoticeOwnerProps | null
  const notice: QuotaNoticeOwnerProps = {
    code: 'ACCOUNT_QUOTA', message: 'Request quota exhausted.', dismiss: vi.fn(), keepOpen: vi.fn(() => () => {}),
  }
  expect(select(notice)).toBe(notice)
  expect(select({ ...notice, code: 'QUOTA' })).toBeNull()
}, 60_000)

it('shares account actions across seats, publishes dialog ownership, and opens contextual support', async ({ start }) => {
  vi.stubGlobal(CONTACT_CONFIG_GLOBAL, { contactFormUrl: 'https://example.test/form/', contactSource: 'harness' })
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  expect(c.ctx.slots.entries('settings.models.sign-in')[0]!.inject!()).toBe(actions)
  // The account UI follows the live theme service through the framework hook channel.
  const theme = c.ctx.get('theme') as ThemeRuntime
  const onTheme = vi.fn()
  const offTheme = actions.hooks.theme.subscribe(onTheme)
  expect(actions.hooks.theme.getSnapshot()).toBe(theme.getTheme())
  const probe = theme.register({ id: 'probe', colorScheme: 'dark', tokens: {} })
  expect(onTheme).toHaveBeenCalledOnce()
  probe()
  offTheme()
  expect(theme.getTheme().themes.map(candidate => candidate.id)).toEqual(['light', 'dark'])
  await actions.refreshAccount()
  expect(c.mock.remote.account.getProfile).not.toHaveBeenCalled()
  const listener = vi.fn()
  const off = actions.hooks.account.subscribe(listener)
  actions.showLogin(true)
  actions.setOnboarding(true)
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ loginVisible: true, onboarding: true })
  expect(listener).toHaveBeenCalledTimes(2)
  off()
  actions.showLogin(false)
  expect(listener).toHaveBeenCalledTimes(2)
  actions.contactUs()
  const signedOut = new URL(String(open.mock.calls.at(-1)![0]))
  expect(signedOut.searchParams.has('prefill_uid')).toBe(false)
  expect(signedOut.searchParams.has('hide_uid')).toBe(false)
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile) })
  const entry = c.ctx.slots.entries('settings.section').find(entry => entry.options.id === 'account')!
  expect(entry.inject!()).toBe(actions)
  expect(resolveSlotLabel(entry.options.label)).toBe('Account')
  vi.spyOn(c.ctx.locale, 'getSnapshot').mockReturnValue({ ...c.ctx.locale.getSnapshot(), active: 'zh' })
  actions.contactUs()
  const support = new URL(String(open.mock.calls.at(-1)![0]))
  expect(support.searchParams.has('prefill_uid')).toBe(false)
  expect(support.searchParams.has('hide_uid')).toBe(false)
  expect(support.searchParams.get('prefill_app_locale')).toBe('zh-CN')
  await c.unload(SELF)
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
}, 60_000)

it('coalesces refreshes, publishes independent failures, and rejects stale responses after sign-out or unload', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const pending = Promise.withResolvers<ReturnType<typeof ok<AccountDetails['profile'] | null>>>()
  c.mock.remote.account.getProfile.mockReturnValueOnce(pending.promise)
  c.mock.remote.account.getBalance.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce() })
  // Two concurrent account refreshes share the one in-flight request, so the
  // second call adds no second read of the profile or the balance.
  const a = actions.refreshAccount()
  const concurrently = actions.refreshAccount()
  expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce()
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledOnce()
  c.mock.streams.push('account/watch', view)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(view) })
  pending.resolve(ok(profile))
  await Promise.all([a, concurrently])
  expect(actions.hooks.account.getSnapshot().details).toBeUndefined()
  c.mock.remote.account.getProfile.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.remote.account.getBalance.mockRejectedValueOnce(new Error('offline'))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details).toEqual({ profile: { status: 'failed' }, balance: { status: 'failed' } }) })
  const pendingAgain = Promise.withResolvers<ReturnType<typeof ok<AccountDetails['profile'] | null>>>()
  c.mock.remote.account.getProfile.mockReturnValueOnce(pendingAgain.promise)
  const request = actions.refreshAccount()
  await c.unload(SELF)
  pendingAgain.resolve(ok(profile))
  await request
  expect(actions.hooks.account.getSnapshot().details?.profile).toEqual({ status: 'failed' })
}, 60_000)

it('uses the Desktop login carrier and exposes operation errors', async ({ start, mock }) => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  mock.remote.account.startSignIn.mockResolvedValue(ok(view))
  await actions.start()
  expect(mock.remote.account.startSignIn).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', version: '0.0.0-test' }),
    window.location.origin, 'desktop')
  const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
  mock.remote.account.startSignIn.mockResolvedValueOnce(failure)
  await expect(actions.start()).rejects.toThrow('account start failed')
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ loginVisible: true, loginFailed: true })
  const id = 'cancel-me' as SignInAttemptId
  mock.remote.account.cancelSignIn.mockResolvedValueOnce(ok(view)).mockResolvedValueOnce(failure)
  await actions.cancel(id)
  await expect(actions.cancel(id)).rejects.toThrow('account cancel failed')
  mock.remote.account.signOut.mockResolvedValueOnce(ok(view)).mockResolvedValueOnce(failure)
  await actions.signOut()
  // The launcher renders nothing, so the refused Remote call reaches the caller unchanged.
  await expect(actions.signOut()).rejects.toBe(failure.error)
}, 60_000)

it('uses the Desktop stream origin and exposes the native platform bridge', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://localhost:9876/stream' })
  const platform = { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() }
  vi.stubGlobal('dshPlatform', platform)
  await c.reload(SELF)
  const actions = operations(c)
  // The native commands reach the one shared host through the account page channel.
  const host = injectedOf(platformHostEntry(c)!) as AccountPlatformHostInjected
  expect(host.platform).toBe(platform)
  const notice = injectedOf(quotaNoticeEntry(c)!) as AccountQuotaNoticeInjected
  // Both surfaces inject the page opener callback, not the channel object; the
  // read policies each opener applies are asserted in their own cases.
  expect(typeof actions.openPlatformPage).toBe('function')
  expect(typeof notice.openPlatformPage).toBe('function')
  expect('platformPages' in actions).toBe(false)
  expect('platformPages' in notice).toBe(false)
  expect(notice.hooks.platformPage.getSnapshot()).toBeNull()

  // One surface requests a page; the viewer returning through the host's own
  // close action retires that owner exactly once and clears the observable.
  const owner = vi.fn()
  actions.openPlatformPage!('usage', owner)
  expect(host.hooks.page.getSnapshot()).toEqual({ page: 'usage' })
  expect(notice.hooks.platformPage.getSnapshot()).toEqual({ page: 'usage' })
  host.closePage()
  expect(host.hooks.page.getSnapshot()).toBeNull()
  expect(owner).toHaveBeenCalledExactlyOnceWith('returned')
  mock.remote.account.startSignIn.mockResolvedValue(ok(view))
  await actions.start()
  expect(mock.remote.account.startSignIn).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }), 'http://localhost:9876', 'desktop')
}, 60_000)


it('re-reads the account when the shared host returns from top-up, and not from usage or an absent page', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  await c.reload(SELF)
  const actions = operations(c)
  const host = injectedOf(platformHostEntry(c)!) as AccountPlatformHostInjected
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.remote.account.getBalance.mockResolvedValue(ok(null))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok({ accountId: 'account-user' as AccountUserId, bonuses: [] }))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  // The account becoming active already ran one shared refresh; measure only the
  // reads each return triggers from here.
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalled() })
  await c.flush()
  c.mock.remote.account.getUnnotifiedBonuses.mockClear()
  c.mock.remote.account.getProfile.mockClear()

  // Usage changes nothing the account owns, so returning from it reads nothing.
  actions.openPlatformPage!('usage', vi.fn())
  host.closePage()
  await c.flush()
  expect(mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()

  // Closing with no page showing is not a return, so it reads nothing either.
  host.closePage()
  await c.flush()
  expect(mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()

  // Top up may have changed what the account holds, so its return runs the one
  // shared refresh: the wallet reads and the unnotified-bonus read.
  actions.openPlatformPage!('top-up', vi.fn())
  host.closePage()
  await vi.waitFor(() => { expect(mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce() })
  expect(mock.remote.account.getProfile).toHaveBeenCalledOnce()
}, 60_000)

it('re-reads profile and balance but no bonus for the onboarding recharge return, and nothing on supersede or release', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  await c.reload(SELF)
  const actions = operations(c)
  const onboarding = injectedOf(c.ctx.slots.entries('shell.overlay')
    .find(entry => entry.options.id === 'desktop-onboarding')!) as DesktopOnboardingInjected
  const host = injectedOf(platformHostEntry(c)!) as AccountPlatformHostInjected
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.remote.account.getBalance.mockResolvedValue(ok(null))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok({ accountId: 'account-user' as AccountUserId, bonuses: [] }))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalled() })
  await c.flush()
  const bonusesBefore = c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length
  // The account becoming active already ran the shared refresh; measure only the
  // reads each later event triggers.
  c.mock.remote.account.getProfile.mockClear()
  c.mock.remote.account.getBalance.mockClear()

  // A superseded page is not a return, so it reads nothing for either caller.
  onboarding.openPlatformPage!('top-up', () => {})
  actions.openPlatformPage!('top-up', () => {})
  await c.flush()
  expect(c.mock.remote.account.getProfile).not.toHaveBeenCalled()

  // Releasing a request is not a return either.
  const release = actions.openPlatformPage!('top-up', () => {})
  release()
  await c.flush()
  expect(c.mock.remote.account.getProfile).not.toHaveBeenCalled()

  // The onboarding return re-reads profile and balance, and never the bonus: an
  // unseen award must not be acknowledged behind the onboarding surface.
  onboarding.openPlatformPage!('top-up', () => {})
  host.closePage()
  await vi.waitFor(() => { expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce() })
  await vi.waitFor(() => { expect(c.mock.remote.account.getBalance).toHaveBeenCalledOnce() })
  await c.flush()
  expect(c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length).toBe(bonusesBefore)
}, 60_000)

it('waits for an in-flight pre-return read before the post-top-up read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  await c.reload(SELF)
  const actions = operations(c)
  const host = injectedOf(platformHostEntry(c)!) as AccountPlatformHostInjected
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalled() })
  await c.flush()
  c.mock.remote.account.getProfile.mockClear()
  c.mock.remote.account.getBalance.mockClear()
  c.mock.remote.account.getUnnotifiedBonuses.mockClear()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof ok<AccountDetails['balance'] | null>>>>()
  c.mock.remote.account.getBalance.mockReturnValueOnce(pending.promise)
  try {
    c.mock.streams.push('account/watch', stored)
    await vi.waitFor(() => { expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce() })
    // The baseline includes the frame's own notice read, which is not the return read.
    const bonusesBeforeReturn = c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length

    actions.openPlatformPage!('top-up', vi.fn())
    host.closePage()
    await c.flush()
    // The return read has not started: the host is still waiting on the older one.
    expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce()
    expect(c.mock.remote.account.getBalance).toHaveBeenCalledOnce()

    pending.resolve(ok(null))
    await vi.waitFor(() => { expect(c.mock.remote.account.getProfile).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length).toBeGreaterThan(bonusesBeforeReturn) })
  } finally {
    // A failed assertion above must not strand the read the host is awaiting.
    pending.resolve(ok(null))
  }
}, 60_000)

it('reads the unnotified bonus in the active locale and acknowledges only after the card renders', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus(orderId)))
  c.mock.remote.account.ackBonusNotified.mockResolvedValue(ok(true))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId, message: 'Awarded 5.00' })
  })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
  // A successful read is not a display, so nothing may be acknowledged yet.
  expect(c.mock.remote.account.ackBonusNotified).not.toHaveBeenCalled()
  actions.bonusNoticeShown(orderId as AccountBonusOrderId)
  await vi.waitFor(() => {
    expect(c.mock.remote.account.ackBonusNotified).toHaveBeenCalledWith('account-user', orderId, expect.objectContaining({ locale: 'en' }))
  })
  actions.bonusNoticeDismissed(orderId as AccountBonusOrderId)
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
}, 60_000)

it('keeps the notice and its acknowledgement retry across repeated signed-in frames', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  vi.stubGlobal(CONTACT_CONFIG_GLOBAL, { bonusAckRetryDelayMs: 1, bonusAckRetryMaxDelayMs: 4 })
  const c = await start()
  const actions = operations(c)
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus(orderId)))
  c.mock.remote.account.ackBonusNotified.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId }) })
  actions.bonusNoticeShown(orderId as AccountBonusOrderId)
  await vi.waitFor(() => { expect(c.mock.remote.account.ackBonusNotified.mock.calls.length).toBeGreaterThan(0) })
  // One sign-in commits the credential and then updates the attempt; a reconnected
  // stream replays the same signed-in state. None of them is a new account.
  c.mock.streams.push('account/watch', stored)
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  // The displayed card stays, no second read replaces it, and the failed
  // acknowledgement keeps backing off instead of stopping until sign-out.
  expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce()
  await vi.waitFor(() => { expect(c.mock.remote.account.ackBonusNotified.mock.calls.length).toBeGreaterThan(1) }, { timeout: 30_000 })
}, 60_000)

it('keeps the notice absent when the bonus read is refused, then shows the next read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValueOnce({
    ok: false, error: new RemoteError('gateway/internal', 'offline', {}),
  })
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce() })
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
  expect(c.mock.remote.account.ackBonusNotified).not.toHaveBeenCalled()
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus(orderId)))
  await actions.refreshAccount()
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId, message: 'Awarded 5.00' })
  })
}, 60_000)

it('drops the previous account notice and stops reading after sign-out', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus('4c1b0000-0000-4000-8000-000000000001')))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().notice?.message).toBe('Awarded 5.00')
  })
  c.mock.streams.push('account/watch', view)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(view) })
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
  // Signing out ends the lifecycle, so no further read follows.
  const reads = c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  expect(c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length).toBe(reads)
}, 60_000)

it('refreshes balances and the bonus read on one Settings entry, without polling', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const balance: AccountDetails['balance'] = {
    status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  }
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', stored)
  // Signing in reads once; nothing else reads on a timer.
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1) })
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1)
  // Signing in already read the wallet once through the details refresh.
  const balances = c.mock.remote.account.getBalance.mock.calls.length
  await actions.refreshAccount()
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(balances + 1)
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
  // The bonus read carries the active UI language.
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en' }))
}, 60_000)

it('publishes a failed balance from a Settings entry without dropping the bonus read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getBalance.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1) })
  await actions.refreshAccount()
  expect(actions.hooks.account.getSnapshot().details?.balance).toEqual({ status: 'failed' })
  // The bonus read still ran: a failed wallet read does not cancel it.
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
}, 60_000)

it('publishes a terminal state-stream failure without mistaking it for plugin disposal', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  await c.mock.streams.opened('account/watch', 1)
  c.mock.streams.end('account/watch')
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().failed).toBe(true) })
}, 60_000)

it('ignores a terminal stream error when plugin disposal already owns teardown', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  let disposal: Promise<void> | undefined
  const original = c.ctx.remote.$stream.bind(c.ctx.remote)
  const spy = vi.spyOn(c.ctx.remote, '$stream').mockImplementation((options) => {
    const stream = original(options)
    stream.signal.addEventListener('abort', () => { disposal = c.unload(SELF) }, { once: true })
    return stream
  })
  await c.reload(SELF)
  spy.mockRestore()
  const actions = operations(c)
  await c.mock.streams.opened('account/watch', 2)
  c.mock.streams.end('account/watch')
  await vi.waitFor(() => { expect(disposal).toBeDefined() })
  await disposal
  expect(actions.hooks.account.getSnapshot().failed).toBe(false)
}, 60_000)

it('samples the build version, language, and UTC offset for every account call', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const offset = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(480)
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1) })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenLastCalledWith({
    version: '0.0.0-test', locale: 'en', timezoneOffsetSeconds: -28_800,
  })
  // The next call reads the zone again instead of reusing the first sample.
  offset.mockReturnValue(-300)
  await actions.refreshAccount()
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenLastCalledWith({
    version: '0.0.0-test', locale: 'en', timezoneOffsetSeconds: 18_000,
  })
}, 60_000)

it('reads the account task impact and reports a refused query', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  mock.remote.account.hasRunningAccountTasks.mockResolvedValueOnce(ok(true))
  expect(await actions.hasRunningAccountTasks()).toBe(true)
  mock.remote.account.hasRunningAccountTasks.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  await expect(actions.hasRunningAccountTasks()).rejects.toThrow('account task query failed')
}, 60_000)


it('forwards live account notices and removes their subscriptions', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const expired = vi.fn()
  const unavailable = vi.fn()
  const offExpired = actions.subscribeSessionExpired!(expired)
  const offUnavailable = actions.subscribeModelSignInRequired!(unavailable)
  for (const event of ['deepseek-account/session-expired', 'deepseek-account/model-sign-in-required']) {
    c.mock.streams.push('$events', { type: 'emit', event, args: [] })
  }
  await c.flush()
  expect(expired).toHaveBeenCalledOnce()
  expect(unavailable).toHaveBeenCalledOnce()
  offExpired()
  offUnavailable()
  for (const event of ['deepseek-account/session-expired', 'deepseek-account/model-sign-in-required']) {
    c.mock.streams.push('$events', { type: 'emit', event, args: [] })
  }
  await c.flush()
  expect(expired).toHaveBeenCalledOnce()
  expect(unavailable).toHaveBeenCalledOnce()
})
for (const native of [false, true]) it(`exposes desktop progress actions and disposes its subscriptions (native platform: ${native})`, async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const platform = { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() }
  if (native) vi.stubGlobal('dshPlatform', platform)
  const c = await start()
  const entry = c.ctx.slots.entries('shell.overlay').find(entry => entry.options.id === 'desktop-onboarding')!
  const injected = (entry.inject!() as object) as DesktopOnboardingInjected
  // Onboarding requests the shared native page through the one host; it holds no
  // bridge of its own.
  if (native) expect(injected.openPlatformPage).toBeDefined()
  else expect(injected.openPlatformPage).toBeUndefined()
  expect(await injected.update({ step: 'credit' })).toBe(false)
  expect(await injected.complete('skipped')).toBe(false)
  expect(await injected.retry()).toBe(false)
  expect(injected.hooks.onboarding.getSnapshot().visible).toBe(false)
  await c.unload(SELF)
  expect(c.ctx.slots.entries('shell.overlay').some(entry => entry.options.id === 'desktop-onboarding')).toBe(false)
  expect(mock.remote.account.getBalance).not.toHaveBeenCalled()
}, 60_000)

it('applies API-key defaults through the desktop slot and shared configuration owners', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const values: Record<string, object> = {
    'ui-settings-account': { version: 1, step: 'welcome', purpose: null, process: null, completion: null, usage: 'compact', developerTools: false },
    'ui-chat': { transcriptView: 'compact', performanceUsage: 'detailed', linkOpening: 'sidebar' },
    'ui-settings': { enabled: false },
  }
  const schemas = { 'ui-settings-account': OnboardingConfig, 'ui-chat': ChatConfig, 'ui-settings': SettingsConfig }
  const namespace = (ns: keyof typeof schemas) => ({ ns, autoGenerate: false, schema: JSON.parse(JSON.stringify(schemas[ns].toJSON())) as JsonValue, value: values[ns] as JsonValue, applies: 'live' as const, secrets: [], revision: 0 })
  mock.remote.settings.describe.mockResolvedValue(ok({
    writable: true, hasDocument: true, namespaces: Object.keys(schemas).map(ns => namespace(ns as keyof typeof schemas)),
  }))
  const hasApiKey = vi.fn(async () => true)
  vi.stubGlobal('dshOnboarding', { hasApiKey })
  mock.remote.settings.mutate.mockImplementation(async (ns, ops) => {
    const key = ns as keyof typeof schemas
    const value: Record<string, unknown> = { ...values[key] }
    for (const op of ops) if (op.op === 'set') value[String(op.path[0])] = op.value
    values[key] = value
    return ok(namespace(key))
  })
  const c = await start()
  const injected = c.ctx.slots.entries('shell.overlay').find(entry => entry.options.id === 'desktop-onboarding')!.inject!() as object as DesktopOnboardingInjected
  await vi.waitFor(() => { expect(injected.hooks.onboarding.getSnapshot().progress.step).toBe('done') })
  expect(hasApiKey).toHaveBeenCalled()
  expect(values['ui-settings']).toEqual({ enabled: true })
  expect(values['ui-chat']).toMatchObject({ transcriptView: 'standard' })
}, 60_000)
