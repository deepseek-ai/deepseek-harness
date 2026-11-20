/** Remote browser credentials retain their own durable key and fixed authority-scoped expiry. */

import { createHmac, randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteBrowserAuth } from '../src/remote-auth.ts'

const DAY = 86_400_000
const RECORD_KEY = credentialKey('client-remote-connection', 'browser-session')

class RecordCredentials extends CredentialProvider {
  record: CredentialRecord | undefined
  readonly keys: CredentialKey[] = []
  writes = 0
  private tail = Promise.resolve()

  constructor(record?: CredentialRecord) {
    const ctx = new Context()
    super(ctx)
    this.record = record
    onTestFinished(() => ctx.fiber.dispose())
  }

  override resolve(): never { throw new Error('Reference resolution is outside this fixture') }
  override describe(): never { throw new Error('Reference description is outside this fixture') }
  override set(): never { throw new Error('Reference writes are outside this fixture') }
  override unset(): never { throw new Error('Reference removal is outside this fixture') }
  override describeRecord(): never { throw new Error('Record description is outside this fixture') }
  override listRecords(): never { throw new Error('Record enumeration is outside this fixture') }
  override readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(this.record) }
  override deleteRecord(): Promise<void> { this.record = undefined; return Promise.resolve() }

  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.keys.push(key)
    const write = this.tail.then(async () => {
      const next = await mutate(this.record)
      if (next !== undefined) { this.record = next; this.writes++ }
      return this.record
    })
    this.tail = write.then(() => undefined, () => undefined)
    return write
  }
}

function secretRecord(): CredentialRecord {
  return { kind: 'grant', payload: { version: 1, secret: randomBytes(32).toString('base64url') } }
}

function issue(auth: RemoteBrowserAuth, host = 'remote.example', secure = false): { setCookie: string; pair: string; name: string } {
  const setCookie = auth.createSessionCookie({ headers: { host } }, secure)
  if (setCookie === undefined) throw new Error('Expected the test request to identify an audience')
  const pair = setCookie.split(';', 1)[0]!
  return { setCookie, pair, name: pair.slice(0, pair.indexOf('=')) }
}

function signedBody(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('Expected the test credential store to hold a grant')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('Expected the test grant to hold a signing key')
  const signed = `v1.${body}`
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(signed).digest('base64url')
  return `${name}=${signed}.${signature}`
}

function signedPayload(store: RecordCredentials, name: string, value: unknown): string {
  return signedBody(store, name, Buffer.from(JSON.stringify(value)).toString('base64url'))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Remote browser credentials', () => {
  it('reuses the durable Remote key across instances without storing a runtime Peer', async () => {
    const store = new RecordCredentials()
    const first = await RemoteBrowserAuth.create(store, 30)
    const { pair, setCookie } = issue(first)
    expect(setCookie).toContain('; Max-Age=2592000; Path=/; Expires=')
    expect(setCookie).toMatch(/; HttpOnly; SameSite=Strict$/u)
    expect(pair).toMatch(/^dsh-remote-[A-Za-z0-9_-]+=v1\./u)
    expect(store.record).toMatchObject({ kind: 'grant', payload: { version: 1 } })
    const saved = structuredClone(store.record)
    const restarted = await RemoteBrowserAuth.create(store, 30)
    expect(restarted.isAuthenticated({ headers: { host: 'remote.example', cookie: pair } }, false)).toBe(true)
    expect(store.record).toEqual(saved)
    expect(store.keys).toEqual([RECORD_KEY, RECORD_KEY])
    expect(store.writes).toBe(1)
  })

  it('uses the atomically committed key when two initializations overlap', async () => {
    const store = new RecordCredentials()
    const [first, second] = await Promise.all([
      RemoteBrowserAuth.create(store, 30),
      RemoteBrowserAuth.create(store, 30),
    ])
    expect(store.writes).toBe(1)
    const cookie = issue(first).pair
    expect(second.isAuthenticated({ headers: { host: 'remote.example', cookie } }, false)).toBe(true)

    const committed = secretRecord()
    const competing = new RecordCredentials()
    vi.spyOn(competing, 'modifyRecord').mockImplementationOnce(async (_key, mutate) => {
      await mutate(undefined)
      return committed
    })
    const winner = await RemoteBrowserAuth.create(new RecordCredentials(committed), 30)
    const loser = await RemoteBrowserAuth.create(competing, 30)
    expect(winner.isAuthenticated({ headers: { host: 'remote.example', cookie: issue(loser).pair } }, false)).toBe(true)
  })

  it('retains the absolute expiry after verification and process restart', async () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 10, 12)
    vi.setSystemTime(now)
    const store = new RecordCredentials()
    const first = await RemoteBrowserAuth.create(store, 1)
    const { pair, setCookie } = issue(first)
    expect(setCookie).toContain(`Expires=${new Date(now + DAY).toUTCString()}`)
    const body = pair.split('.')[1]!
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toEqual({
      version: 1, authority: 'http://remote.example', issuedAt: now, expiresAt: now + DAY,
    })
    vi.setSystemTime(now + DAY / 2)
    const restarted = await RemoteBrowserAuth.create(store, 1)
    const request = { headers: { host: 'remote.example', cookie: pair } }
    expect(restarted.isAuthenticated(request, false)).toBe(true)
    vi.setSystemTime(now + DAY - 1)
    expect(restarted.isAuthenticated(request, false)).toBe(true)
    vi.setSystemTime(now + DAY)
    expect(restarted.isAuthenticated(request, false)).toBe(false)
  })

  it('binds both cookie name and signed audience to the listener scheme and normalized Host', async () => {
    const auth = await RemoteBrowserAuth.create(new RecordCredentials(), 30)
    const http = issue(auth, 'Remote.Example:80')
    const https = issue(auth, 'Remote.Example:443', true)
    expect(auth.isAuthenticated({ headers: { host: 'remote.example', cookie: http.pair } }, false)).toBe(true)
    expect(auth.isAuthenticated({ headers: new Headers({ host: 'REMOTE.EXAMPLE:443', cookie: https.pair }) }, true)).toBe(true)
    expect(https.setCookie).toMatch(/; Secure$/u)
    expect(https.name).not.toBe(http.name)
    for (const host of ['other.example', 'remote.example:8080']) {
      expect(auth.isAuthenticated({ headers: { host, cookie: http.pair } }, false)).toBe(false)
    }
    expect(auth.isAuthenticated({ headers: { host: 'remote.example', cookie: http.pair } }, true)).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'remote.example', cookie: http.pair.replace(http.name, https.name) } }, true)).toBe(false)
    const ipv6 = issue(auth, '[::1]:3080')
    expect(auth.isAuthenticated({ headers: { host: '[0:0:0:0:0:0:0:1]:3080', cookie: ipv6.pair } }, false)).toBe(true)
  })

  it('rejects ambiguous Cookie entries while ignoring unrelated cookies', async () => {
    const auth = await RemoteBrowserAuth.create(new RecordCredentials(), 30)
    const { pair, name } = issue(auth)
    const request = (cookie: string) => ({ headers: { host: 'remote.example', cookie } })
    expect(auth.isAuthenticated(request(`unrelated=value; ${pair}; ignored`), false)).toBe(true)
    for (const cookie of [`${pair}; ${pair}`, `${name}=; ${pair}`, `${pair}; ${name}=invalid`, 'unrelated=value']) {
      expect(auth.isAuthenticated(request(cookie), false)).toBe(false)
    }
    expect(auth.isAuthenticated({ headers: { host: 'remote.example', cookie: [pair] } }, false)).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'remote.example' } }, false)).toBe(false)
    expect(auth.isAuthenticated({ headers: new Headers({ host: 'remote.example' }) }, false)).toBe(false)
  })

  it('refuses missing, malformed, and non-authority Host fields', async () => {
    const auth = await RemoteBrowserAuth.create(new RecordCredentials(), 30)
    const { pair } = issue(auth)
    for (const host of ['', 'remote.example/path', 'remote.example?x', 'remote.example#x', 'user@remote.example', ' remote.example', 'remote.example\\path', '[::1']) {
      expect(auth.createSessionCookie({ headers: { host } }, false)).toBeUndefined()
      expect(auth.isAuthenticated({ headers: { host, cookie: pair } }, false)).toBe(false)
    }
    expect(auth.createSessionCookie({ headers: {} }, false)).toBeUndefined()
    expect(auth.createSessionCookie({ headers: { host: ['remote.example'] } }, false)).toBeUndefined()
    expect(auth.isAuthenticated({ headers: { cookie: pair } }, false)).toBe(false)
  })

  it('rejects tampering, malformed encodings, and unsupported cookie versions', async () => {
    const store = new RecordCredentials()
    const auth = await RemoteBrowserAuth.create(store, 30)
    const { pair, name } = issue(auth)
    for (const cookie of [
      `${pair}!`, pair.replace('=v1.', '=v2.'), `${pair}.extra`, `${name}=v1`, `${name}=v1.e30`,
      `${name}=v1.e30.AA`, `${name}=v1.e30.`, `${pair}=`,
      pair.replace('=v1.', '=v1.x'), signedBody(store, name, 'a'), signedBody(store, name, 'e30='),
      signedBody(store, name, 'e31'),
      signedBody(store, name, Buffer.from('not JSON').toString('base64url')),
    ]) {
      expect(auth.isAuthenticated({ headers: { host: 'remote.example', cookie } }, false)).toBe(false)
    }
    const other = await RemoteBrowserAuth.create(new RecordCredentials(), 30)
    expect(other.isAuthenticated({ headers: { host: 'remote.example', cookie: pair } }, false)).toBe(false)
  })

  it('validates signed JSON fields and time bounds before accepting credentials', async () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 10, 12)
    vi.setSystemTime(now)
    const store = new RecordCredentials()
    const auth = await RemoteBrowserAuth.create(store, 1)
    const { name } = issue(auth)
    const valid = { version: 1, authority: 'http://remote.example', issuedAt: now, expiresAt: now + DAY }
    for (const payload of [
      null, [], true, 1, 'credential', {}, { ...valid, extra: true }, { ...valid, version: 2 },
      { ...valid, authority: 1 }, { ...valid, authority: 'http://other.example' },
      { ...valid, issuedAt: 'now' }, { ...valid, issuedAt: -1 }, { ...valid, issuedAt: now + 1 },
      { ...valid, issuedAt: now + 0.5 }, { ...valid, issuedAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, expiresAt: 'later' }, { ...valid, expiresAt: null }, { ...valid, expiresAt: now },
      { ...valid, expiresAt: now - 1 }, { ...valid, expiresAt: now + DAY + 1 },
      { ...valid, expiresAt: now + 0.5 }, { ...valid, expiresAt: 8_640_000_000_000_001 },
    ]) {
      const cookie = signedPayload(store, name, payload)
      expect(auth.isAuthenticated({ headers: { host: 'remote.example', cookie } }, false)).toBe(false)
    }
    const shortened = await RemoteBrowserAuth.create(store, 1)
    const longer = await RemoteBrowserAuth.create(store, 2)
    expect(shortened.isAuthenticated({ headers: { host: 'remote.example', cookie: issue(longer).pair } }, false)).toBe(false)
  })

  it.each<CredentialRecord>([
    { kind: 'api-key', key: 'unrelated' },
    { kind: 'grant', payload: null },
    { kind: 'grant', payload: [] },
    { kind: 'grant', payload: {} },
    { kind: 'grant', payload: { version: 2, secret: randomBytes(32).toString('base64url') } },
    { kind: 'grant', payload: { version: 1, secret: randomBytes(32).toString('base64url'), extra: true } },
    { kind: 'grant', payload: { version: 1, secret: 1 } },
    { kind: 'grant', payload: { version: 1, secret: '' } },
    { kind: 'grant', payload: { version: 1, secret: 'x' } },
    { kind: 'grant', payload: { version: 1, secret: 'AA' } },
    { kind: 'grant', payload: { version: 1, secret: `${randomBytes(32).toString('base64url')}=` } },
  ])('refuses a corrupt stored record without replacing it: %j', async (record) => {
    const store = new RecordCredentials(record)
    await expect(RemoteBrowserAuth.create(store, 30)).rejects.toMatchObject({
      name: 'RemoteAuthenticationError', code: 'REMOTE_AUTH_CREDENTIAL_CORRUPT',
    })
    expect(store.record).toEqual(record)
    expect(store.writes).toBe(0)
  })

  it('reports unavailable storage and preserves structured provider failures', async () => {
    const unavailable = new RecordCredentials()
    vi.spyOn(unavailable, 'modifyRecord').mockResolvedValueOnce(undefined)
    await expect(RemoteBrowserAuth.create(unavailable, 30)).rejects.toMatchObject({
      name: 'RemoteAuthenticationError', code: 'REMOTE_AUTH_CREDENTIAL_UNAVAILABLE',
    })
    const failed = new RecordCredentials()
    const cause = new Error('storage unavailable')
    vi.spyOn(failed, 'modifyRecord').mockRejectedValueOnce(cause)
    await expect(RemoteBrowserAuth.create(failed, 30)).rejects.toMatchObject({
      name: 'RemoteAuthenticationError', code: 'REMOTE_AUTH_CREDENTIAL_FAILED', cause,
    })
    const structured = new RecordCredentials()
    const error = new HarnessError('storage refused the write', 'CREDENTIAL_PERMISSION_DENIED')
    vi.spyOn(structured, 'modifyRecord').mockRejectedValueOnce(error)
    await expect(RemoteBrowserAuth.create(structured, 30)).rejects.toBe(error)
  })

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    'refuses unsupported lifetimes before touching persistent credentials: %s',
    async (days) => {
      const store = new RecordCredentials()
      await expect(RemoteBrowserAuth.create(store, days)).rejects.toMatchObject({
        name: 'RemoteAuthenticationError', code: 'REMOTE_AUTH_INVALID_LIFETIME',
      })
      expect(store.keys).toEqual([])
    },
  )
})
