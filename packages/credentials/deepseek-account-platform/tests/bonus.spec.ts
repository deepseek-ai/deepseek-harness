/** Bonus notification reads and acknowledgements over the real Host HTTP path. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AccountBonusBatch, AccountBonusOrderId, AccountClientMetadata, AccountUserId, AccountView } from '@deepseek-ai/dsh-deepseek-account'
import { PlatformAccount } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

const ORDER = '4c1b0000-0000-4000-8000-000000000000'
const SECOND_ORDER = '5d2c0000-0000-4000-8000-000000000000'
const USER = 'test-user'

/** Client identity supplied with each account operation; only the locale's primary subtag selects the wire locale. */
const clientMetadata = (locale = 'en-US'): AccountClientMetadata => ({ version: '1.2.3', locale, timezoneOffsetSeconds: 28_800 })

interface Recorded {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly token: string | undefined
  readonly locale: string | undefined
  readonly bundleId: string | undefined
  readonly platform: string | undefined
  readonly version: string | undefined
  readonly timezoneOffset: string | undefined
  readonly contentType: string | undefined
  readonly body: string | undefined
}

/** Read one request body; the acknowledgement carries its order id in JSON, so the fixture keeps the exact bytes. */
function requestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('error', reject)
    req.on('end', () => { resolve(body) })
  })
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bonus-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const requests: Recorded[] = []
  let profileId: string | null = USER
  let profileBizCode = 0
  let profileStatus = 200
  let bonusBizCode = 0
  let bonusStatus = 200
  let bonuses: unknown = [
    { order_id: ORDER, campaign: 'dsh_login_bonus', amount: '5.00', currency: 'CNY',
      granted_at: '2026-09-21T12:00:00Z', expires_at: '2026-10-21T12:00:00Z', msg: '已赠送您 5.00 元 DSH 体验赠金。' },
    { order_id: SECOND_ORDER, campaign: 'dsh_login_bonus', amount: '1.50', currency: 'CNY',
      granted_at: '2026-09-20T12:00:00Z', expires_at: '2026-10-20T12:00:00Z', msg: '已赠送您 1.50 元 DSH 体验赠金。' },
  ]
  let ackBizCode = 0
  let ackStatus = 200
  let beforeProfileResponse: (() => Promise<void>) | undefined
  let origin = ''
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    expect(req.headers.authorization).toBeUndefined()
    const body = await requestBody(req)
    requests.push({ method: req.method, url: req.url, token: req.headers['x-dsh-auth-token'] as string | undefined,
      locale: req.headers['x-client-locale'] as string | undefined,
      bundleId: req.headers['x-client-bundle-id'] as string | undefined,
      platform: req.headers['x-client-platform'] as string | undefined,
      version: req.headers['x-client-version'] as string | undefined,
      timezoneOffset: req.headers['x-client-timezone-offset'] as string | undefined,
      contentType: req.headers['content-type'], body: body === '' ? undefined : body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/auth-api/v0/users/current') {
      await beforeProfileResponse?.()
      res.writeHead(profileStatus).end(JSON.stringify({ code: profileStatus === 200 ? 0 : 1, data: { biz_code: profileBizCode,
        biz_data: { id: profileId, email: 't***@example.invalid', id_profile: { name: 'Test', picture: null } } } }))
      return
    }
    if (req.url === '/api/v0/users/get_unnotified_bonuses') {
      res.writeHead(bonusStatus).end(JSON.stringify({ code: bonusStatus === 200 ? 0 : 1,
        data: { biz_code: bonusBizCode, biz_data: bonuses } }))
      return
    }
    // The exact path is the assertion: a query parameter would fall through to the 404 below.
    if (req.url === '/api/v0/users/ack_bonus_notified') {
      res.writeHead(ackStatus).end(JSON.stringify(ackStatus === 200
        ? { code: 0, msg: '', data: { biz_code: ackBizCode, biz_msg: ackBizCode === 0 ? '' : 'BONUS_ORDER_NOT_FOUND', biz_data: null } }
        : { code: 1, msg: 'INTERNAL', data: null }))
      return
    }
    res.writeHead(404).end('{}')
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500).end('{}') }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  origin = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  })
  const ctx = new Context()
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  // The composed client identity is this fixture's choice; `null` is the web profile's documented setting.
  const provider = ctx.plugin(PlatformAccount, {
    platformOrigin: origin, allowLoopbackHttp: true, requestTimeoutMs: 5_000, desktopPlatform: null,
  })
  await provider
  cleanups.push(async () => { await provider.dispose(); await authorization.dispose(); await credentials.dispose() })
  const key = credentialKey('deepseek-account-platform', 'default')
  return {
    account: ctx.deepseekAccount, ctx, requests, key,
    grant: (token: string) => ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant', payload: { version: 1, token, issuer: origin },
    })),
    signOut: () => ctx.credentials.deleteRecord(key),
    profileId: (value: string | null) => { profileId = value },
    failProfile: (bizCode = 17, status = 200) => { profileBizCode = bizCode; profileStatus = status },
    bonuses: (value: unknown) => { bonuses = value },
    failBonuses: (bizCode = 17, status = 200) => { bonusBizCode = bizCode; bonusStatus = status },
    failAck: (bizCode = 0, status = 200) => { ackBizCode = bizCode; ackStatus = status },
    onProfile: (hook: () => Promise<void>) => { beforeProfileResponse = hook },
  }
}

it('reads the identity once, then sends one call\'s client identity headers on both bonus requests', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  const client = { version: '3.0.0', locale: 'zh-TW', timezoneOffsetSeconds: -18_000 }
  await f.account.getUnnotifiedBonuses(client)
  await f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, client)
  expect(f.requests.map(request => [
    request.url, request.bundleId, request.platform, request.version, request.locale, request.timezoneOffset,
  ])).toEqual([
    ['/auth-api/v0/users/current', '', 'web', '3.0.0', 'zh_CN', '-18000'],
    ['/api/v0/users/get_unnotified_bonuses', '', 'web', '3.0.0', 'zh_CN', '-18000'],
    ['/api/v0/users/ack_bonus_notified', '', 'web', '3.0.0', 'zh_CN', '-18000'],
  ])
})

it('queries the account identity once even across repeated reads and acknowledgements', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  await f.account.getUnnotifiedBonuses(clientMetadata('en'))
  await f.account.getUnnotifiedBonuses(clientMetadata('en'))
  await f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en'))
  expect(f.requests.filter(request => request.url === '/auth-api/v0/users/current')).toHaveLength(1)
})

it('does not reuse a cached identity from another grant', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  expect(await f.account.getProfile(clientMetadata())).toMatchObject({ status: 'ready' })
  await f.grant('rotated-token')
  await f.account.getUnnotifiedBonuses(clientMetadata('en'))
  expect(f.requests.map(request => [request.url, request.token])).toEqual([
    ['/auth-api/v0/users/current', 'test-account-token'],
    ['/auth-api/v0/users/current', 'rotated-token'],
    ['/api/v0/users/get_unnotified_bonuses', 'rotated-token'],
  ])
})

it('publishes the identity a bonus read resolved, so the session can scope account storage', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  const lifetime = new AbortController()
  const states: AccountView[] = []
  const watching = (async () => { for await (const state of f.account.watch(lifetime.signal)) states.push(state) })()
  try {
    await expect.poll(() => states.length).toBe(1)
    expect(await f.account.getUnnotifiedBonuses(clientMetadata('en'))).toMatchObject({ accountId: USER })
    // The bonus read names the account, so identity consumers re-read the session snapshot.
    await expect.poll(() => states.length).toBe(2)
    expect(await f.account.getPlatformSession()).toMatchObject({ userId: USER, token: 'test-account-token' })
  } finally {
    lifetime.abort()
    await watching
  }
})

it('reads unnotified bonuses with the platform origin, grant header, and locale header', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  const batch = await f.account.getUnnotifiedBonuses(clientMetadata('zh-CN'))
  expect(batch).toEqual<AccountBonusBatch>({
    accountId: USER as AccountUserId,
    bonuses: [
      { orderId: ORDER as AccountBonusOrderId, campaign: 'dsh_login_bonus', amount: '5.00', currency: 'CNY',
        grantedAt: '2026-09-21T12:00:00Z', expiresAt: '2026-10-21T12:00:00Z', message: '已赠送您 5.00 元 DSH 体验赠金。' },
      { orderId: SECOND_ORDER as AccountBonusOrderId, campaign: 'dsh_login_bonus', amount: '1.50', currency: 'CNY',
        grantedAt: '2026-09-20T12:00:00Z', expiresAt: '2026-10-20T12:00:00Z', message: '已赠送您 1.50 元 DSH 体验赠金。' },
    ],
  })
  expect(f.requests).toEqual([
    { method: 'GET', url: '/auth-api/v0/users/current', token: 'test-account-token', locale: 'zh_CN',
      bundleId: '', platform: 'web', version: '1.2.3', timezoneOffset: '28800' },
    { method: 'GET', url: '/api/v0/users/get_unnotified_bonuses', token: 'test-account-token', locale: 'zh_CN',
      bundleId: '', platform: 'web', version: '1.2.3', timezoneOffset: '28800' },
  ])
})

it('accepts exponent and full-precision bonus amounts through the Platform numeric grammar', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.bonuses([
    { order_id: ORDER, campaign: 'dsh_login_bonus', amount: '5.0000000000000000', currency: 'CNY',
      granted_at: '2026-09-21T12:00:00Z', expires_at: '2026-10-21T12:00:00Z', msg: 'fixture' },
    { order_id: SECOND_ORDER, campaign: 'dsh_login_bonus', amount: '1E+3', currency: 'CNY',
      granted_at: '2026-09-20T12:00:00Z', expires_at: '2026-10-20T12:00:00Z', msg: 'fixture' },
  ])
  const batch = await f.account.getUnnotifiedBonuses(clientMetadata('en'))
  expect(batch?.bonuses.map(bonus => bonus.amount)).toEqual(['5.0000000000000000', '1E+3'])
})

it.each([
  ['zh-CN', 'zh_CN'],
  ['en-US', 'en_US'],
])('selects %s copy through the locale header and never a language query', async (locale, wireLocale) => {
  const f = await fixture()
  await f.grant('test-account-token')
  await f.account.getUnnotifiedBonuses(clientMetadata(locale))
  expect(f.requests.map(request => request.locale)).toEqual([wireLocale, wireLocale])
  expect(f.requests.map(request => request.url)).toEqual([
    '/auth-api/v0/users/current',
    '/api/v0/users/get_unnotified_bonuses',
  ])
})

it.each([
  ['a non-UUID order id', [{ order_id: 'order', campaign: 'c', amount: '5.00', currency: 'CNY', granted_at: 'a', expires_at: 'b', msg: 'm' }]],
  ['a non-decimal amount', [{ order_id: ORDER, campaign: 'c', amount: 'five', currency: 'CNY', granted_at: 'a', expires_at: 'b', msg: 'm' }]],
  ['an unknown currency', [{ order_id: ORDER, campaign: 'c', amount: '5.00', currency: 'EUR', granted_at: 'a', expires_at: 'b', msg: 'm' }]],
  ['a missing message', [{ order_id: ORDER, campaign: 'c', amount: '5.00', currency: 'CNY', granted_at: 'a', expires_at: 'b' }]],
  ['a payload that is not a list', { bonuses: [] }],
])('rejects a malformed unnotified payload: %s', async (_name, payload) => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.bonuses(payload)
  await expect(f.account.getUnnotifiedBonuses(clientMetadata('en'))).rejects.toThrow('account: protocol')
})

it('acknowledges a displayed bonus with the grant, locale, and a JSON body', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  expect(await f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('zh-CN'))).toBe(true)
  expect(f.requests).toEqual([
    { method: 'GET', url: '/auth-api/v0/users/current', token: 'test-account-token', locale: 'zh_CN',
      bundleId: '', platform: 'web', version: '1.2.3', timezoneOffset: '28800' },
    { method: 'POST', url: '/api/v0/users/ack_bonus_notified', token: 'test-account-token', locale: 'zh_CN',
      bundleId: '', platform: 'web', version: '1.2.3', timezoneOffset: '28800',
      contentType: 'application/json', body: `{"order_id":"${ORDER}"}` },
  ])
})

it.each([
  ['the unnotified read', (f: Awaited<ReturnType<typeof fixture>>) => {
    f.failBonuses(0, 401)
    return f.account.getUnnotifiedBonuses(clientMetadata('en'))
  }, null],
  ['the acknowledgement', (f: Awaited<ReturnType<typeof fixture>>) => {
    f.failAck(0, 401)
    return f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en'))
  }, false],
])('expires the rejected grant when %s returns HTTP 401', async (_name, run, signedOutOutcome) => {
  const f = await fixture()
  await f.grant('test-account-token')
  const expired = vi.fn()
  f.ctx.on('deepseek-account/session-expired', expired)
  // A rejected authenticated request names an invalid credential, so the provider drops it locally
  // exactly as the profile and balance reads do; the caller sees its signed-out outcome.
  expect(await run(f)).toBe(signedOutOutcome)
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out' })
  expect(expired).toHaveBeenCalledOnce()
})

it.each([
  ['read', (f: Awaited<ReturnType<typeof fixture>>) => f.account.getUnnotifiedBonuses(clientMetadata('en')), null],
  ['acknowledgement', (f: Awaited<ReturnType<typeof fixture>>) =>
    f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en')), false],
])('ignores a bonus %s rejection whose response cleanup overlaps a credential replacement', async (_name, run, outcome) => {
  const f = await fixture()
  await f.grant('test-account-token')
  await f.account.getProfile(clientMetadata())
  const response = new Response('', { status: 401 })
  const cancel = response.body!.cancel.bind(response.body)
  // Credential changes can arrive while the response reader releases a rejected response body.
  const cleanup = vi.spyOn(response.body!, 'cancel').mockImplementation(async () => {
    await f.grant('replacement-token')
    await cancel()
  })
  const fetchResponse = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response)
  const expired = vi.fn()
  f.ctx.on('deepseek-account/session-expired', expired)
  try {
    expect(await run(f)).toBe(outcome)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(expired).not.toHaveBeenCalled()
    expect(await f.ctx.credentials.readRecord(f.key)).toMatchObject({ payload: { token: 'replacement-token' } })
    expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
  } finally { cleanup.mockRestore(); fetchResponse.mockRestore() }
})

it('retains the grant when an acknowledgement returns HTTP 500', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.failAck(0, 500)
  await expect(f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en')))
    .rejects.toThrow('account: network')
  expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
})

it('rejects the supplied BONUS_ORDER_NOT_FOUND envelope as a business failure', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.failAck(1)
  await expect(f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en')))
    .rejects.toThrow('account: protocol')
  expect(f.requests[1]).toMatchObject({
    method: 'POST', url: '/api/v0/users/ack_bonus_notified', locale: 'en_US',
    contentType: 'application/json', body: `{"order_id":"${ORDER}"}`,
  })
})

it.each([
  ['a business failure', 1, 200, 'account: protocol'],
  ['an HTTP failure', 0, 500, 'account: network'],
])('surfaces %s as a retryable acknowledgement failure', async (_name, bizCode, status, message) => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.failAck(bizCode, status)
  await expect(f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en'))).rejects.toThrow(message)
})

it('does not acknowledge a notification from another account', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  expect(await f.account.ackBonusNotified('other-user' as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en'))).toBe(false)
  expect(f.requests.map(request => request.url)).toEqual(['/auth-api/v0/users/current'])
})

it('returns signed-out outcomes without any request', async () => {
  const f = await fixture()
  expect(await f.account.getUnnotifiedBonuses(clientMetadata('en'))).toBeNull()
  expect(await f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en'))).toBe(false)
  expect(f.requests).toEqual([])
})

it('discards a read that a credential change invalidated before it published', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.onProfile(async () => { await f.grant('rotated-token') })
  expect(await f.account.getUnnotifiedBonuses(clientMetadata('en'))).toBeNull()
  expect(f.requests.map(request => request.url)).toEqual(['/auth-api/v0/users/current'])
})

it('reports an unknown identity as retryable and an absent id as a protocol failure', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.failProfile()
  await expect(f.account.getUnnotifiedBonuses(clientMetadata('en'))).rejects.toThrow('account: network')
  const absent = await fixture()
  await absent.grant('test-account-token')
  absent.profileId(null)
  await expect(absent.account.getUnnotifiedBonuses(clientMetadata('en'))).rejects.toThrow('account: protocol')
})

it('reuses a cached identity for the same credential after a failed query', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  expect(await f.account.getProfile(clientMetadata())).toMatchObject({ status: 'ready' })
  f.failProfile()
  await expect(f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en'))).resolves.toBe(true)
})

it('refuses a cached identity that carries no Platform id', async () => {
  const f = await fixture()
  await f.grant('test-account-token')
  f.profileId(null)
  expect(await f.account.getProfile(clientMetadata())).toMatchObject({ status: 'ready' })
  f.failProfile()
  await expect(f.account.ackBonusNotified(USER as AccountUserId, ORDER as AccountBonusOrderId, clientMetadata('en'))).rejects.toThrow('account: protocol')
})
