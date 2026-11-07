/** Notification destinations are independent of Platform account and browser destinations. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AccountNotificationId } from '@deepseek-ai/dsh-deepseek-account'
import { DeepSeekAccount, type Config } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function fixture(issuer: string, config: Config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-account-origin-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, token: 'fixture-token', issuer },
  }))
  await ctx.plugin(DeepSeekAccount, config)
  return ctx.deepseekAccount
}

it('routes only notification APIs to Harness while account APIs and pages stay on Platform', async () => {
  const account = await fixture('https://platform.deepseek.com')
  expect(await account.getState()).toMatchObject({ status: 'credential-stored', links: {
    usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up',
  } })
  expect(await account.getPlatformSession()).toMatchObject({ origin: 'https://platform.deepseek.com', token: 'fixture-token' })
  const id = 'f487920c-a8d5-59b6-90f0-b787adc97980' as AccountNotificationId
  const content = { id, created_at: '2026-10-28T06:12:11Z', display_until: null, title: 'News', body: 'Content', actions: [] }
  const requests: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (typeof input !== 'string') throw new Error('expected a URL string')
    const url = input
    requests.push(url)
    const path = new URL(url).pathname
    const payload = path === '/auth-api/v0/users/current' ? { id: 'account', email: '' }
      : path === '/api/v0/users/get_user_summary' ? { normal_wallets: [], bonus_wallets: [] }
        : path.endsWith('/list') ? { notifications: [content], next_poll_after: 600 }
          : path.endsWith('/content') ? content : { acked: true }
    return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: payload } }))
  })
  const client = { version: 'test', locale: 'en', timezoneOffsetSeconds: 0 }
  expect(await account.getProfile(client)).toMatchObject({ status: 'ready' })
  expect(await account.getBalance(client)).toMatchObject({ status: 'ready' })
  expect((await account.getNotifications(client))?.notifications[0]?.id).toBe(id)
  expect((await account.getNotificationContent(id, client))?.id).toBe(id)
  expect(await account.reportNotificationEvent(id, 'dismissed', client)).toBe(true)
  expect(requests).toEqual([
    'https://platform.deepseek.com/auth-api/v0/users/current',
    'https://platform.deepseek.com/api/v0/users/get_user_summary',
    'https://harness.deepseek.com/api/v0/users/notifications/list',
    `https://harness.deepseek.com/api/v0/users/notifications/content?id=${id}`,
    'https://harness.deepseek.com/api/v0/users/notifications/events',
  ])
})

it('keeps private grants and embedded pages on Platform while allowing a notification origin override', async () => {
  const rejected = await fixture('https://platform.deepseek.com', { platformOrigin: 'https://private.example' })
  expect(await rejected.getState()).toMatchObject({ status: 'signed-out' })
  const account = await fixture('https://private.example', {
    platformOrigin: 'https://private.example', harnessOrigin: 'https://notifications.example',
    requestHeaders: { 'x-deployment': 'base' }, accountRequestHeaders: { 'x-account': 'account' },
  })
  expect(await account.getPlatformSession()).toMatchObject({
    origin: 'https://private.example', token: 'fixture-token',
    requestHeaders: { 'x-deployment': 'base', 'x-account': 'account' },
  })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input).toBe('https://notifications.example/api/v0/users/notifications/list')
    expect(init?.headers).toMatchObject({ 'x-deployment': 'base', 'x-account': 'account', 'x-dsh-auth-token': 'fixture-token' })
    return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { notifications: [], next_poll_after: 600 } } }))
  })
  await account.getNotifications({ version: 'test', locale: 'en', timezoneOffsetSeconds: 0 })
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each(['http://remote.example', 'https://notifications.example/path'])(
  'rejects the invalid notification origin %s during initialization', async (harnessOrigin) => {
    await expect(fixture('https://platform.deepseek.com', { harnessOrigin })).rejects.toThrow('harnessOrigin')
  },
)
