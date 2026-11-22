/** Durable OAuth validation and refresh through the real SDK and credential store. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef, parseCredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { expect, it, onTestFinished, vi } from 'vitest'
import { McpOAuthCredentials, oauthFetch, oauthRecord } from '../src/oauth-credentials.ts'
import { probeServer } from '../src/probe.ts'
import { authorize, oauthWorld, phase } from './oauth-fixture.ts'

async function credentials() {
  const world = await oauthWorld()
  await authorize(world.owner())
  const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
  const signal = new AbortController().signal
  const grant = await store.read(world.config.url, signal)
  const replace = (record: CredentialRecord) => world.ctx.credentials.modifyRecord(store.key, async () => record)
  return { ...world, store, signal, grant, replace }
}

it('requires the configured credential provider', async () => {
  const world = await oauthWorld()
  expect(() => new McpOAuthCredentials(new Context(), world.config.oauth)).toThrow('credentials provider')
})

it('refuses credential keys owned by other plugins', async () => {
  const world = await oauthWorld()
  const key = parseCredentialKey('deepseek-account-platform/default')
  const record = { kind: 'grant', payload: { version: 1, token: 'platform-token', issuer: 'https://platform.deepseek.com' } } satisfies CredentialRecord
  await world.ctx.credentials.modifyRecord(key, async () => record)
  expect(() => new McpOAuthCredentials(world.ctx, { ...world.config.oauth, credentialKey: key })).toThrow('mcp-client')
  expect(await world.ctx.credentials.readRecord(key)).toEqual(record)
})

it('rejects incompatible durable grants and changed endpoint, client, or scope without sending requests', async () => {
  const world = await credentials()
  const { store, signal, grant, replace, config } = world
  const records: CredentialRecord[] = [
    { kind: 'api-key', key: 'private' }, { kind: 'grant', payload: {} },
    oauthRecord({ ...grant, clientKey: 'invalid-key' }),
    oauthRecord({ ...grant, serverUrl: world.origin + '/another' }),
    oauthRecord({ ...grant, configuredClientId: 'different' }),
    oauthRecord({ ...grant, configuredScope: 'different' }),
  ]
  const count = world.requests.length
  for (const record of records) {
    await replace(record)
    await expect(store.read(config.url, signal)).rejects.toThrow('binding')
  }
  expect(world.requests).toHaveLength(count)
})

it('refuses to read or overwrite incompatible client records, but can update compatible registrations', async () => {
  const { store, ctx, grant, signal } = await credentials()
  const key = parseCredentialKey(grant.clientKey)
  for (const record of [{ kind: 'api-key', key: 'private' }, { kind: 'grant', payload: {} }] satisfies CredentialRecord[]) {
    await ctx.credentials.modifyRecord(key, async () => record)
    await expect(store.client(key, grant.issuer)).rejects.toThrow('binding')
    await expect(store.saveClient(key, grant.issuer, { client_id: 'replacement' }, signal)).rejects.toThrow('incompatible')
  }
  await ctx.credentials.deleteRecord(key)
  await store.saveClient(key, grant.issuer, { client_id: 'replacement' }, signal)
  await expect(store.client(key, 'https://other.invalid')).rejects.toThrow('binding')
  await store.saveClient(key, grant.issuer, { client_id: 'updated' }, signal)
  expect(await store.client(key, grant.issuer)).toMatchObject({ client_id: 'updated' })
  await expect(store.saveClient(key, grant.issuer, { client_id: 'cancelled' }, AbortSignal.abort())).rejects.toThrow()
  expect(await store.client(key, grant.issuer)).toMatchObject({ client_id: 'updated' })
})

it.each(['no-refresh-token', 'missing-client', 'different-client'] as const)('requires explicit authorization when refresh cannot use its registration (%s)', async (reason) => {
  const { store, signal, grant, replace, ctx, tokens } = await credentials()
  if (reason === 'no-refresh-token') {
    const { refresh_token: _refresh, ...tokens } = grant.tokens
    await replace(oauthRecord({ ...grant, expiresAt: 0, tokens }))
  } else {
    await replace(oauthRecord({ ...grant, expiresAt: 0 }))
    const key = parseCredentialKey(grant.clientKey)
    if (reason === 'missing-client') await ctx.credentials.deleteRecord(key)
    else await store.saveClient(key, grant.issuer, { client_id: 'different' }, signal)
  }
  await expect(store.transport(grant, signal, fetch).authProvider.token()).rejects.toThrow(reason === 'no-refresh-token' ? 'expired' : 'binding')
  expect(tokens()).toBe(1)
})

it('preserves refresh token and scope when refresh omits them, and removes stale expiry', async () => {
  const { store, signal, grant, replace, behavior, config } = await credentials()
  const { metadata: _metadata, resource: _resource, ...minimal } = grant
  await replace(oauthRecord({ ...minimal, expiresAt: 0 }))
  behavior.token = async ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'renewed', token_type: 'Bearer' }))
  }
  const transport = store.transport(grant, signal, fetch)
  expect(await transport.authProvider.token()).toBe('renewed')
  expect(await store.read(config.url, signal)).toMatchObject({ id: grant.id, tokens: { refresh_token: grant.tokens.refresh_token, scope: 'tools' } })
  expect(await store.read(config.url, signal)).not.toHaveProperty('expiresAt')
  expect(await transport.authProvider.token()).toBe('renewed')
})

it('persists a received refresh rotation before reporting cancellation', async () => {
  const { store, signal, grant, replace, behavior, config, tokens } = await credentials()
  await replace(oauthRecord({ ...grant, expiresAt: 0 }))
  behavior.token = async ({ form, response }) => {
    expect(form.get('refresh_token')).toBe(grant.tokens.refresh_token)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600,
    }))
  }
  const lifetime = new AbortController()
  const send = globalThis.fetch
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const response = await send(url, init)
    if ((url instanceof URL ? url.href : url) === grant.issuer + '/token') {
      const json = response.json.bind(response)
      response.json = async () => {
        const result: unknown = await json()
        lifetime.abort()
        return result
      }
    }
    return response
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(store.transport(grant, lifetime.signal, send).authProvider.token()).rejects.toThrow()
  const saved = await store.read(config.url, signal)
  expect(saved).toMatchObject({ id: grant.id, tokens: { access_token: 'rotated-access', refresh_token: 'rotated-refresh' } })
  expect(await store.transport(saved, signal, send).authProvider.token()).toBe('rotated-access')
  expect(tokens()).toBe(2)
})

it.each(['http://example.invalid/mcp', 'http://192.0.2.1/mcp', 'http://localhost.example.invalid/mcp', 'ftp://localhost/mcp'])(
  'refuses OAuth requests and resource credentials over an insecure URL: %s', async (url) => {
    const { store, signal, grant } = await credentials()
    const send = vi.fn<typeof fetch>()
    await expect(oauthFetch(signal, 10_000)(url)).rejects.toThrow('requires HTTPS')
    await expect(store.transport(grant, signal, send).fetch(url, { headers: { authorization: 'Bearer private' } })).rejects.toThrow('requires HTTPS')
    expect(send).not.toHaveBeenCalled()
  },
)

it.each(['https://example.invalid/mcp', 'http://localhost/mcp', 'http://[::1]/mcp'])(
  'accepts HTTPS and loopback resource URLs: %s', async (url) => {
    const { store, signal, grant } = await credentials()
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response())
    await store.transport(grant, signal, send).fetch(url, { headers: { authorization: 'Bearer private' } })
    expect(send).toHaveBeenCalledOnce()
  },
)

it.each([false, true])('rejects insecure authorization and probe endpoints before sending (template: %s)', async (template) => {
  const world = await credentials()
  const url = 'http://example.invalid/mcp'
  await world.ctx.credentials.set(credentialRef('MCP_ENDPOINT'), url)
  await world.replace(oauthRecord({ ...world.grant, serverUrl: url }))
  const config = { ...world.config, expandTemplates: true, url: template ? '${credential:MCP_ENDPOINT}' : url }
  const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected insecure request'))
  onTestFinished(() => { send.mockRestore() })
  const owner = world.owner(config)
  await owner.start()
  expect(await phase(() => owner.current(), 'failed')).toMatchObject({ lastError: 'MCP OAuth requires HTTPS except for loopback HTTP' })
  const result = await probeServer(world.ctx, config)
  expect(result).toMatchObject({ ok: false, closeConfirmed: true })
  expect(send).not.toHaveBeenCalled()
})

it('rejects a 401 from an older grant and requests without a bearer binding', async () => {
  const { store, signal, grant, config, replace, behavior, tokens } = await credentials()
  const transport = store.transport(grant, signal, fetch)
  const context = { serverUrl: new URL(config.url), fetchFn: fetch }
  await expect(transport.fetch(config.url)).rejects.toThrow('no bearer token')
  await expect(transport.authProvider.onUnauthorized({ ...context, response: new Response(null, { status: 401 }) })).rejects.toThrow('no credential binding')
  behavior.rejection = { status: 401 }
  const response = await transport.fetch(config.url, { headers: { authorization: 'Bearer ' + grant.tokens.access_token } })
  await response.arrayBuffer()
  await replace(oauthRecord({ ...grant, id: randomUUID() }))
  await expect(transport.authProvider.onUnauthorized({ ...context, response })).rejects.toThrow('binding')
  await expect(transport.fetch(config.url, { headers: { authorization: 'Bearer old' } })).rejects.toThrow('binding')
  expect(tokens()).toBe(1)
})

it('honors request cancellation before sending an OAuth request', async () => {
  const world = await oauthWorld()
  await expect(oauthFetch(new AbortController().signal, 10_000)(world.origin + '/token', { signal: AbortSignal.abort() })).rejects.toThrow()
  await expect(oauthFetch(AbortSignal.abort(), 10_000)(world.origin + '/token')).rejects.toThrow()
  expect(world.requests).toHaveLength(0)
})
