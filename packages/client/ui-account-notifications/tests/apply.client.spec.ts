// @vitest-environment jsdom
/** Notification integration shares the account plugin's single state stream. */
import { afterEach, beforeEach, expect, onTestFinished, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { AccountNotificationBatch, AccountNotificationId, AccountDetails, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountSectionInjected } from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { AccountNotificationsInjected } from '../src/client/AccountNotifications.tsx'
import { NOTIFICATIONS_CONFIG_GLOBAL } from '../src/config.ts'
import { notification } from './notification-fixture.ts'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-account'
const view: AccountView = { status: 'signed-out', attempt: null,
  links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }
const stored: AccountView = { ...view, status: 'credential-stored' }
function bonus(orderId: string, message = 'Awarded 5.00'): AccountNotificationBatch {
  return { nextPollAfterSeconds: 300, notifications: [notification(orderId, { body: message, displayUntil: '2099-01-01T00:00:00Z' })] }
}
function operations(c: TestClient): AccountSectionInjected {
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  return injected as AccountSectionInjected
}
function notificationOperations(c: TestClient): AccountNotificationsInjected {
  const injected: object = c.ctx.slots.entries('settings.launcher.notifications')[0]!.inject!()
  return injected as AccountNotificationsInjected
}
beforeEach(() => { vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('reads the unnotified bonus in the active locale and acknowledges only after the card renders', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus(orderId)))
  c.mock.remote.account.reportNotificationEvent.mockResolvedValue(ok(true))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await vi.waitFor(() => {
    expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]).toMatchObject({ id: orderId, body: 'Awarded 5.00' })
  })
  expect(c.mock.remote.account.getNotifications).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
  // A successful read is not a display, so nothing may be acknowledged yet.
  expect(c.mock.remote.account.reportNotificationEvent).not.toHaveBeenCalled()
  notificationOperations(c).shown(orderId as AccountNotificationId)
  await vi.waitFor(() => {
    expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledWith(orderId, 'displayed', expect.objectContaining({ locale: 'en' }))
  })
  notificationOperations(c).ctaClicked(orderId as AccountNotificationId)
  expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledWith(
    orderId, 'cta_clicked', expect.objectContaining({ locale: 'en' }))
  expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]?.id).toBe(orderId)
  notificationOperations(c).dismiss(orderId as AccountNotificationId)
  expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]).toBeUndefined()
  await vi.waitFor(() => {
    expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledWith(orderId, 'dismissed', expect.objectContaining({ locale: 'en' }))
  })
}, 60_000)

it('starts one notification poll across the credential commit and login-success frames', async ({ start }) => {
  const c = await start()
  c.mock.remote.session.initializeDefaultModel.mockResolvedValue(ok(undefined))
  const reads = c.mock.remote.account.getNotifications
  const id = 'one-login' as SignInAttemptId
  c.mock.streams.push('account/watch', { type: 'snapshot', state: { ...stored, attempt: { id, phase: 'committing' } } })
  await c.flush()
  expect(reads).toHaveBeenCalledTimes(1)
  c.mock.streams.push('account/watch', { type: 'snapshot', state: { ...stored, attempt: { id, phase: 'succeeded' } } })
  await c.flush()
  expect(reads).toHaveBeenCalledTimes(1)
  c.mock.streams.push('account/watch', { type: 'snapshot', state: { ...stored, attempt: { id, phase: 'succeeded' } } })
  await c.flush()
  expect(reads).toHaveBeenCalledTimes(1)
}, 60_000)

for (const outcome of ['null', 'failure'] as const) it(`queries a replacement credential without adopting the old ${outcome} reply`, async ({ start }) => {
  const c = await start()
  const previous = Promise.withResolvers<ReturnType<typeof ok<AccountNotificationBatch | null>>>()
  const reads = c.mock.remote.account.getNotifications
  reads.mockReturnValueOnce(previous.promise)
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  reads.mockResolvedValueOnce(ok(bonus('replacement-notice')))
  c.mock.streams.push('account/watch', { type: 'credentials-changed', state: stored })
  await c.flush()
  expect(reads).toHaveBeenCalledTimes(2)
  expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]?.id).toBe('replacement-notice')
  if (outcome === 'null') previous.resolve(ok(null))
  else previous.reject(new Error('obsolete credential'))
  await c.flush()
  expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]?.id).toBe('replacement-notice')
}, 60_000)

it('clears notification cards and ignores old event failures when credentials change despite a failed replacement list', async ({ start }) => {
  const c = await start()
  const id = '4c1b0000-0000-4000-8000-000000000000' as AccountNotificationId
  const event = Promise.withResolvers<ReturnType<typeof ok<boolean>>>()
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus(id)))
  c.mock.remote.account.reportNotificationEvent.mockReturnValueOnce(event.promise)
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    notificationOperations(c).shown(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledTimes(1)
    c.mock.remote.account.getNotifications.mockRejectedValueOnce(new Error('replacement offline'))
    c.mock.streams.push('account/watch', { type: 'credentials-changed', state: stored })
    await c.flush()
    expect(notificationOperations(c).hooks.notices.getSnapshot()).toEqual([])
    event.reject(new Error('old request failed'))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledTimes(1)
    expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('[deepseek-account] notification read failed; retaining cards and retrying on the next poll')
  } finally { vi.useRealTimers() }
}, 60_000)

it('keeps the notice without retrying its event across repeated signed-in frames', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const orderId = '4c1b0000-0000-4000-8000-000000000000' as AccountNotificationId
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus(orderId)))
  c.mock.remote.account.reportNotificationEvent.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    notificationOperations(c).shown(orderId)
    await vi.advanceTimersByTimeAsync(0)
    c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
    c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
    await c.flush()
    await vi.advanceTimersByTimeAsync(60_000)
    notificationOperations(c).shown(orderId)
    expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]).toMatchObject({ id: orderId })
    expect(c.mock.remote.account.getNotifications).toHaveBeenCalledOnce()
    expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      '[deepseek-account] notification event report failed; keeping local state without retry', { event: 'displayed' })
  } finally { vi.useRealTimers() }
}, 60_000)

it('keeps the notice absent when the bonus read is refused, then shows the next read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getNotifications.mockResolvedValueOnce({
    ok: false, error: new RemoteError('gateway/internal', 'offline', {}),
  })
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await vi.waitFor(() => { expect(c.mock.remote.account.getNotifications).toHaveBeenCalledOnce() })
  expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]).toBeUndefined()
  expect(c.mock.remote.account.reportNotificationEvent).not.toHaveBeenCalled()
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus(orderId)))
  await actions.refreshAccount()
  await vi.waitFor(() => {
    expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]).toMatchObject({ id: orderId, body: 'Awarded 5.00' })
  })
}, 60_000)

it('drops the previous account notice and stops reading after sign-out', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus('4c1b0000-0000-4000-8000-000000000001')))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await vi.waitFor(() => {
    expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]?.body).toBe('Awarded 5.00')
  })
  c.mock.streams.push('account/watch', { type: 'snapshot', state: view })
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(view) })
  expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]).toBeUndefined()
  // Signing out ends the lifecycle, so no further read follows.
  const reads = c.mock.remote.account.getNotifications.mock.calls.length
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  expect(c.mock.remote.account.getNotifications.mock.calls.length).toBe(reads)
}, 60_000)

it('refreshes balances and notifications immediately on Settings entry', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const balance: AccountDetails['balance'] = {
    status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  }
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance))
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  // Account activation starts with an immediate read.
  await vi.waitFor(() => { expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(1) })
  // Signing in already read the wallet once through the details refresh.
  const balances = c.mock.remote.account.getBalance.mock.calls.length
  await actions.refreshAccount()
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(balances + 1)
  expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(2)
  // The bonus read carries the active UI language.
  expect(c.mock.remote.account.getNotifications).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en' }))
}, 60_000)

it('replaces polling on startup, sign-in and Settings entry and stops on sign-out or unload', async ({ start }) => {
  vi.stubGlobal(NOTIFICATIONS_CONFIG_GLOBAL, { notificationPollIntervalMs: 1_000 })
  const c = await start()
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  vi.useFakeTimers()
  try {
    await c.reload(SELF)
    await c.flush()
    const actions = operations(c)
    const reads = c.mock.remote.account.getNotifications
    reads.mockClear()
    // Startup receives the stored account in its initial stream snapshot.
    c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
    await c.flush()
    expect(reads).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    await actions.refreshAccount()
    expect(reads).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(reads).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(reads).toHaveBeenCalledTimes(3)
    c.mock.streams.push('account/watch', { type: 'snapshot', state: view })
    await c.flush()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(reads).toHaveBeenCalledTimes(3)
    c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
    await c.flush()
    expect(reads).toHaveBeenCalledTimes(4)
    await c.unload(SELF)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(reads).toHaveBeenCalledTimes(4)
  } finally { vi.useRealTimers() }
}, 60_000)

it('publishes a failed balance from a Settings entry without dropping the bonus read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getBalance.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await vi.waitFor(() => { expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(1) })
  await actions.refreshAccount()
  expect(actions.hooks.account.getSnapshot().details?.balance).toEqual({ status: 'failed' })
  // The bonus read still ran: a failed wallet read does not cancel it.
  expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(2)
}, 60_000)

it('refreshes consumed notification content on a locale change without reading the unconsumed list again', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const id = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus(id)))
  c.mock.remote.account.reportNotificationEvent.mockResolvedValue(ok(true))
  c.mock.remote.account.getNotificationContent.mockResolvedValue(ok(notification(id, { title: '公告', body: '新的中文内容' })))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await vi.waitFor(() => { expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]?.id).toBe(id) })
  notificationOperations(c).shown(id as AccountNotificationId)
  await vi.waitFor(() => { expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledTimes(1) })
  const reads = c.mock.remote.account.getNotifications.mock.calls.length
  c.mock.remote.settings.mutate.mockResolvedValue(ok({
    ns: 'locale', autoGenerate: false, schema: { type: 'object' }, value: { preference: 'zh' },
    applies: 'live', secrets: [], revision: 1,
  }))
  c.ctx.locale.setLocale('zh')
  await vi.waitFor(() => { expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]?.body).toBe('新的中文内容') })
  expect(c.mock.remote.account.getNotificationContent).toHaveBeenCalledWith( id, expect.objectContaining({ locale: 'zh' }))
  expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(reads)
  expect(c.mock.remote.account.reportNotificationEvent).toHaveBeenCalledTimes(1)
}, 60_000)

it('retains notification content when the localization RPC is refused', async ({ start }) => {
  const c = await start()
  const id = '4c1b0000-0000-4000-8000-000000000000'
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus(id)))
  c.mock.remote.account.getNotificationContent.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  c.mock.remote.settings.mutate.mockResolvedValue(ok({
    ns: 'locale', autoGenerate: false, schema: { type: 'object' }, value: { preference: 'zh' },
    applies: 'live', secrets: [], revision: 1,
  }))
  c.ctx.locale.setLocale('zh')
  await vi.waitFor(() => { expect(output).toHaveBeenCalledWith('[deepseek-account] notification content read failed') })
  expect(notificationOperations(c).hooks.notices.getSnapshot()?.[0]?.body).toBe('Awarded 5.00')
}, 60_000)

it('clears notifications and stops polling when the account carrier fails', async ({ start }) => {
  const c = await start()
  const open = c.ctx.remote.$stream.bind(c.ctx.remote)
  let fail: (() => void) | undefined
  vi.spyOn(c.ctx.remote, '$stream').mockImplementation((options) => {
    if (options.name === 'account') fail = () => {
      options.carrierFailed?.(Object.assign(new Error('connection lost'), { code: 'gateway/carrier-lost' as const }))
    }
    return open(options)
  })
  await c.reload(SELF)
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus('4c1b0000-0000-4000-8000-000000000000')))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  expect(notificationOperations(c).hooks.notices.getSnapshot()).toHaveLength(1)
  const reads = c.mock.remote.account.getNotifications.mock.calls.length
  vi.useFakeTimers()
  try {
    fail?.()
    expect(notificationOperations(c).hooks.notices.getSnapshot()).toEqual([])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(reads)
  } finally { vi.useRealTimers() }
}, 60_000)

it('reloads notifications without opening another account stream', async ({ start }) => {
  const c = await start()
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus('retained')))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  const stream = vi.spyOn(c.ctx.remote, '$stream')
  const before = c.mock.remote.account.getNotifications.mock.calls.length
  await c.reload('@deepseek-ai/dsh-client-ui-account-notifications')
  await c.flush()
  expect(stream).not.toHaveBeenCalled()
  expect(c.mock.remote.account.getNotifications).toHaveBeenCalledTimes(before + 1)
  expect(notificationOperations(c).hooks.notices.getSnapshot()[0]?.id).toBe('retained')
})

it('publishes notification changes through one stable source and releases its subscribers', async ({ start }) => {
  const c = await start()
  const source = notificationOperations(c).hooks.notices
  expect(notificationOperations(c).hooks.notices).toBe(source)
  const listener = vi.fn()
  const dispose = source.subscribe(listener)
  onTestFinished(dispose)
  c.mock.remote.account.getNotifications.mockResolvedValue(ok(bonus('first')))
  c.mock.streams.push('account/watch', { type: 'snapshot', state: stored })
  await c.flush()
  expect(source.getSnapshot()[0]?.id).toBe('first')
  expect(listener).toHaveBeenCalled()
  dispose()
  listener.mockClear()
  c.mock.streams.push('account/watch', { type: 'snapshot', state: view })
  await c.flush()
  expect(source.getSnapshot()).toEqual([])
  expect(listener).not.toHaveBeenCalled()
})
