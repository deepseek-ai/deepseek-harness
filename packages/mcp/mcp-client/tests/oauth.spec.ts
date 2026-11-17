/** OAuth lifecycle regressions against the real SDK, callback server, and file-backed store. */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Client, UnauthorizedError } from '@modelcontextprotocol/client'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { apply, type Config } from '../src/index.ts'
import { probeServer } from '../src/probe.ts'
import { connectionStatusIn as connectionStatusOf } from '../src/status.ts'
import { McpTemplateBinding } from '../src/credentials.ts'
import { McpOAuthCredentials, oauthRecord } from '../src/oauth-credentials.ts'
import { authorize, callback, captureLogs, oauthWorld, phase } from './oauth-fixture.ts'

// The HTTP request deadline is 10 s; no test relies on waiting for that deadline.
describe('MCP OAuth', () => {
  it('requires interactive services only for explicit authorization and rejects mixed Authorization configuration', async () => {
    const world = await oauthWorld(false)
    const owner = world.owner()
    expect(owner.current()).toBeUndefined()
    await expect(owner.start()).rejects.toThrow('authorization and WebServer')
    expect(await probeServer(world.ctx, world.config)).toMatchObject({ ok: false, closeConfirmed: true })
    const conflicting = { ...world.config, headers: { aUtHoRiZaTiOn: 'private' } }
    await expect(apply(world.ctx, conflicting)).rejects.toThrow('cannot be configured together')
    expect(world.requests).toHaveLength(0)
    await owner.dispose()
    await expect(owner.start()).rejects.toThrow('owner is closed')
  })

  it('shares concurrent starts and ignores cancellation from an older attempt', async () => {
    const world = await oauthWorld()
    const owner = world.owner()
    const first = await owner.start()
    expect((await owner.start()).id).toBe(first.id)
    await owner.cancel(first.id)
    const [next, same] = await Promise.all([owner.start(), owner.start()])
    expect(next.id).not.toBe(first.id)
    expect(same.id).toBe(next.id)
    await owner.cancel(first.id)
    await phase(() => owner.current(), 'waiting-browser')
    await owner.cancel(next.id)
    expect(owner.current()?.phase).toBe('cancelled')
  })

  it('uses the SDK fallback endpoints without metadata, issuer response, or token expiry', async () => {
    const world = await oauthWorld()
    world.behavior.metadata = false
    world.behavior.token = async ({ response }) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'fallback', token_type: 'Bearer' }))
    }
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    const authorization = new URL(waiting.authorizationUrl!)
    expect(authorization.searchParams.has('scope')).toBe(false)
    const url = new URL(authorization.searchParams.get('redirect_uri')!)
    url.searchParams.set('state', authorization.searchParams.get('state')!)
    url.searchParams.set('code', 'fixture-code')
    expect((await fetch(url)).status).toBe(200)
    await phase(() => owner.current(), 'authorized')
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    const grant = await store.read(world.config.url, new AbortController().signal)
    expect(grant).not.toHaveProperty('metadata')
    expect(grant).not.toHaveProperty('resource')
    expect(grant).not.toHaveProperty('expiresAt')
  })

  it('receives the callback at the Web server origin when it listens on IPv6 loopback', async () => {
    const world = await oauthWorld(true, '::1')
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    const authorization = new URL(waiting.authorizationUrl!)
    const url = new URL(authorization.searchParams.get('redirect_uri')!)
    expect(url.origin).toBe(world.ctx.webServer.getOrigin())
    expect(url.hostname).toBe('[::1]')
    url.searchParams.set('state', authorization.searchParams.get('state')!)
    url.searchParams.set('iss', authorization.origin)
    url.searchParams.set('code', 'fixture-code')
    expect((await fetch(url)).status).toBe(200)
    await phase(() => owner.current(), 'authorized')
  })

  it('fails before publishing a plaintext authorization page outside loopback', async () => {
    const world = await oauthWorld()
    world.behavior.authorizationEndpoint = 'http://auth.example.invalid/authorize'
    const phases: string[] = []
    const owner = world.owner()
    await owner.start()
    await vi.waitFor(() => {
      const view = owner.current()
      if (view !== undefined) phases.push(view.phase)
      expect(view?.phase).toBe('failed')
    })
    expect(owner.current()).toMatchObject({ lastError: 'MCP OAuth requires HTTPS except for loopback HTTP' })
    expect(owner.current()).not.toHaveProperty('authorizationUrl')
    expect(phases).not.toContain('waiting-browser')
    expect(world.tokens()).toBe(0)
  })

  it('answers the browser with a static completion page that never echoes the callback', async () => {
    const world = await oauthWorld()
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    const authorization = new URL(waiting.authorizationUrl!)
    const url = new URL(authorization.searchParams.get('redirect_uri')!)
    url.searchParams.set('state', 'fixture-wrong-state')
    url.searchParams.set('code', 'fixture-code')
    const rejected = await fetch(url)
    expect(rejected.status).toBe(400)
    expect(rejected.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(rejected.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    const rejectedPage = await rejected.text()
    expect(rejectedPage).toContain('Authorization was not completed.')
    expect(rejectedPage).not.toContain('fixture-')
    url.searchParams.set('state', authorization.searchParams.get('state')!)
    url.searchParams.set('iss', authorization.origin)
    const received = await fetch(url)
    expect(received.status).toBe(200)
    expect(await received.text()).toContain('Authorization received.')
    await phase(() => owner.current(), 'authorized')
  })

  it('accepts the cross-site return from the authorization server while Connection refuses other cross-site requests', async () => {
    const world = await oauthWorld()
    await world.ctx.plugin(Connection)
    const stop = world.ctx.webServer.register({ kind: 'exact', path: '/public', auth: 'anonymous', handler: (_req, res) => { res.end('public') } })
    onTestFinished(stop)
    const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    const authorization = new URL(waiting.authorizationUrl!)
    const url = new URL(authorization.searchParams.get('redirect_uri')!)
    expect((await fetch(new URL('/public', url), { headers })).status).toBe(403)
    url.searchParams.set('state', 'wrong-state')
    url.searchParams.set('iss', authorization.origin)
    url.searchParams.set('code', 'fixture-code')
    expect((await fetch(url, { headers })).status).toBe(400)
    expect(world.tokens()).toBe(0)
    url.searchParams.set('state', authorization.searchParams.get('state')!)
    expect((await fetch(url, { headers })).status).toBe(200)
    await phase(() => owner.current(), 'authorized')
    expect(world.tokens()).toBe(1)
  })

  it('leaves requests for another authority or path, and malformed targets, to the Web server', async () => {
    const world = await oauthWorld()
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    const authorization = new URL(waiting.authorizationUrl!)
    const redirect = new URL(authorization.searchParams.get('redirect_uri')!)
    redirect.searchParams.set('state', authorization.searchParams.get('state')!)
    redirect.searchParams.set('iss', authorization.origin)
    redirect.searchParams.set('code', 'fixture-code')
    const target = redirect.pathname + redirect.search
    for (const input of [
      { url: target, host: undefined },
      { url: target, host: '[' },
      { url: target, host: 'untrusted.invalid' },
      { url: 'http://untrusted.invalid' + target },
      { url: '/mcp/oauth/callback/other' + redirect.search },
      { url: undefined },
    ]) {
      const socket = new Socket()
      const req = new IncomingMessage(socket)
      req.method = 'GET'
      req.url = input.url
      req.headers.host = 'host' in input ? input.host : redirect.host
      const res = new ServerResponse(req)
      const next = vi.fn(async () => {})
      try {
        await world.ctx.waterfall(world.ctx.webServer, 'webserver/request', req, res, next)
        expect(next).toHaveBeenCalledOnce()
        expect(res.writableEnded).toBe(false)
      } finally { res.destroy(); socket.destroy() }
    }
    expect(owner.current()?.phase).toBe('waiting-browser')
    expect(await callback(waiting)).toBe(200)
    await phase(() => owner.current(), 'authorized')
  })

  it('uses configured scope and accepts only one callback while its exchange is pending', async () => {
    const world = await oauthWorld()
    const gate = world.barrier()
    const entered = world.barrier()
    world.behavior.token = async ({ response }) => {
      entered.resolve()
      await gate.promise
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'one', token_type: 'Bearer' }))
    }
    const owner = world.owner({ ...world.config, oauth: { ...world.config.oauth, scope: 'configured' } })
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    expect(new URL(waiting.authorizationUrl!).searchParams.get('scope')).toBe('configured')
    expect(await callback(waiting)).toBe(200)
    await entered.promise
    expect(await callback(waiting)).toBe(410)
    gate.resolve()
    await phase(() => owner.current(), 'authorized')
    expect(world.tokens()).toBe(1)
  })

  it.each([undefined, 'static-client'])('selects compatible registrations when configured scope changes (clientId=%s)', async (clientId) => {
    const world = await oauthWorld()
    const signal = new AbortController().signal
    for (const [index, scope] of ['tools', 'tools more', 'tools'].entries()) {
      const config = { ...world.config, oauth: { ...world.config.oauth, scope, ...clientId === undefined ? {} : { clientId } } }
      const owner = world.owner(config)
      await owner.start()
      const waiting = await phase(() => owner.current(), 'waiting-browser')
      expect(await callback(waiting)).toBe(200)
      await phase(() => owner.current(), 'authorized')
      const store = new McpOAuthCredentials(world.ctx, config.oauth)
      const grant = await store.read(config.url, signal)
      const client = await store.client(parseCredentialKey(grant.clientKey), grant.issuer)
      const expectedClientId = clientId ?? (index === 1 ? 'client-2' : 'client-1')
      expect(grant.clientId).toBe(expectedClientId)
      expect(client).toMatchObject({ client_id: expectedClientId, ...clientId === undefined ? { scope } : {} })
      expect(world.registrations()).toBe(clientId === undefined ? Math.min(index + 1, 2) : 0)
      const authorization = new URL(waiting.authorizationUrl!)
      expect(authorization.searchParams.get('scope')).toBe(scope)
      expect(authorization.searchParams.get('client_id')).toBe(expectedClientId)
      await owner.dispose()
    }
  })

  it('expires a browser attempt and removes its callback without committing a grant', async () => {
    const world = await oauthWorld()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    await vi.advanceTimersByTimeAsync(world.config.oauth.authorizationTimeoutMs)
    vi.useRealTimers()
    await phase(() => owner.current(), 'failed')
    await owner.dispose()
    expect(owner.current()?.lastError).toContain('timed out')
    expect(await callback(waiting)).toBe(404)
    expect(world.tokens()).toBe(0)
  })

  it('retires an owner while a retry waits for cancelled work to settle', async () => {
    const world = await oauthWorld()
    const { ctx, config, barrier } = world
    const gate = barrier()
    const entered = barrier()
    const read = ctx.credentials.readRecord.bind(ctx.credentials)
    const spy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async (key) => {
      if (String(key).includes('-client-')) { entered.resolve(); await gate.promise }
      return read(key)
    })
    const register = vi.spyOn(ctx.authorization, 'registerFlow')
    onTestFinished(() => { spy.mockRestore(); register.mockRestore() })
    const owner = world.owner()
    const attempt = await owner.start()
    await entered.promise
    const cancellation = owner.cancel(attempt.id)
    await phase(() => owner.current(), 'cancelled')
    const retry = owner.start()
    const rejected = expect(retry).rejects.toThrow('owner is closed')
    owner.retire()
    gate.resolve()
    await rejected
    await cancellation
    expect(register).toHaveBeenCalledTimes(1)
    expect(world.registrations()).toBe(0)
    expect(await ctx.credentials.readRecord(new McpOAuthCredentials(ctx, config.oauth).key)).toBeUndefined()
  })

  it('bounds retries after cancellation times out behind another grant refresh, then recovers after cleanup', async () => {
    const world = await oauthWorld()
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    await authorize(world.owner())
    const signal = new AbortController().signal
    const grant = await store.read(world.config.url, signal)
    await world.ctx.credentials.modifyRecord(store.key, async () => oauthRecord({ ...grant, expiresAt: 0 }))
    const refreshing = world.barrier()
    const release = world.barrier()
    world.behavior.token = async ({ response }) => {
      refreshing.resolve()
      await release.promise
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        access_token: 'renewed', refresh_token: 'renewed-refresh', token_type: 'Bearer', expires_in: 3600,
      }))
    }
    const refresh = store.transport(grant, signal, fetch).authProvider.token()
    await refreshing.promise
    const queued = world.barrier()
    const modify = world.ctx.credentials.modifyRecord.bind(world.ctx.credentials)
    const spy = vi.spyOn(world.ctx.credentials, 'modifyRecord').mockImplementation((key, mutate) => {
      const result = modify(key, mutate)
      if (String(key).startsWith('mcp-client/pending-client-')) queued.resolve()
      return result
    })
    onTestFinished(() => { spy.mockRestore(); vi.useRealTimers() })
    const owner = world.owner({ ...world.config, oauth: { ...world.config.oauth, credentialKey: 'mcp-client/pending' } })
    let retry: Promise<void> | undefined
    let retryError: unknown
    try {
      const attempt = await owner.start()
      await queued.promise
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const cancelled = expect(owner.cancel(attempt.id)).rejects.toThrow('cleanup did not settle')
      await vi.advanceTimersByTimeAsync(world.config.closeTimeoutMs + 1)
      await cancelled
      expect(owner.current()?.phase).toBe('cancelled')
      retry = owner.start().then(() => undefined, (error: unknown) => { retryError = error })
      await vi.advanceTimersByTimeAsync(world.config.closeTimeoutMs + 1)
      expect(retryError).toBeInstanceOf(Error)
      expect(String(retryError)).toContain('cleanup did not settle')
      vi.useRealTimers()
      release.resolve()
      await refresh
      await owner.cancel(attempt.id)
      delete world.behavior.token
      await authorize(owner)
      expect(owner.current()?.id).not.toBe(attempt.id)
    } finally {
      owner.retire()
      vi.useRealTimers()
      release.resolve()
      await Promise.allSettled([refresh, retry])
    }
  })

  it('keeps the old grant on cancellation and failure, then replaces it only after a successful retry', async () => {
    const world = await oauthWorld()
    const owner = world.owner()
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    await authorize(owner)
    const old = await store.read(world.config.url, new AbortController().signal)
    for (const result of [{ error: 'access_denied' }, { error: 'server_error' }]) {
      await owner.start()
      const waiting = await phase(() => owner.current(), 'waiting-browser')
      expect(await callback(waiting, result)).toBe(200)
      await phase(() => owner.current(), result.error === 'access_denied' ? 'cancelled' : 'failed')
      expect(await store.read(world.config.url, new AbortController().signal)).toEqual(old)
    }
    await authorize(owner)
    const next = await store.read(world.config.url, new AbortController().signal)
    expect(next.id).not.toBe(old.id)
    expect(world.registrations()).toBe(1)
    const oldTransport = store.transport(old, new AbortController().signal, fetch)
    await expect(oldTransport.authProvider.token()).rejects.toThrow('binding')
    const authRequests = world.requests.filter(request => request.path !== '/mcp')
    expect(authRequests.every(request => request.headers['x-resource-only'] === undefined && request.headers.authorization === undefined)).toBe(true)
    const exchange = world.requests.find(request => request.path === '/token')!
    expect(exchange.form.get('client_secret')).toBe('fixture-client-secret')
  })

  it.each(['callback', 'token'] as const)('re-registers an invalid dynamic client on the next explicit attempt (%s)', async (source) => {
    const world = await oauthWorld()
    const owner = world.owner()
    await authorize(owner)
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    const old = await world.ctx.credentials.readRecord(store.key)
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    if (source === 'token') world.behavior.token = async ({ response }) => {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client', error_description: 'private-upstream-text' }))
    }
    await callback(waiting, source === 'callback' ? { error: 'invalid_client' } : { code: 'fixture-code' })
    await phase(() => owner.current(), 'failed')
    expect(owner.current()?.lastError).not.toContain('private-upstream-text')
    expect(await world.ctx.credentials.readRecord(store.key)).toEqual(old)
    expect(world.registrations()).toBe(1)
    delete world.behavior.token
    await authorize(owner)
    expect(world.registrations()).toBe(2)
  })

  it('logs the network failure behind a failed token exchange', async () => {
    const world = await oauthWorld()
    const logs = captureLogs(world.ctx)
    world.behavior.token = async ({ response }) => { response.socket?.destroy() }
    const owner = world.owner()
    await owner.start()
    await callback(await phase(() => owner.current(), 'waiting-browser'))
    expect((await phase(() => owner.current(), 'failed')).lastError).toBe('MCP OAuth request failed')
    expect(logs.join('\n')).toContain('mcp-client(oauth): explicit authorization: TypeError: fetch failed')
  })

  it('logs an authorization-server error without the authorization code, client secret, or verifier it echoes', async () => {
    const world = await oauthWorld()
    const logs = captureLogs(world.ctx)
    const echoed: string[] = []
    world.behavior.token = async ({ form, response }) => {
      echoed.push(...['code', 'client_secret', 'code_verifier'].map(name => form.get(name) ?? 'missing'))
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: 'invalid_request',
        error_description: `unexpected ${echoed.join(' ')} from ${world.origin}/token?code=${encodeURIComponent(echoed[0]!)}`,
      }))
    }
    const owner = world.owner()
    await owner.start()
    await callback(await phase(() => owner.current(), 'waiting-browser'), { code: 'private-authorization-code' })
    expect((await phase(() => owner.current(), 'failed')).lastError).toBe('MCP OAuth request failed')
    const output = logs.join('\n')
    expect(output).toContain(`OAuthError: unexpected [redacted] [redacted] [redacted] from ${world.origin}/token?code=[redacted]`)
    expect(echoed).toEqual(['private-authorization-code', 'fixture-client-secret', expect.any(String)])
    for (const secret of echoed) expect(output).not.toContain(secret)
  })

  it('logs a failed grant commit without the issued tokens', async () => {
    const world = await oauthWorld()
    const logs = captureLogs(world.ctx)
    world.behavior.token = async ({ response }) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer',
      }))
    }
    const modify = world.ctx.credentials.modifyRecord.bind(world.ctx.credentials)
    const spy = vi.spyOn(world.ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      if (key !== world.config.oauth.credentialKey) return modify(key, mutate)
      throw new Error(`cannot store ${JSON.stringify(await mutate(undefined))}`)
    })
    onTestFinished(() => { spy.mockRestore() })
    const owner = world.owner()
    await owner.start()
    await callback(await phase(() => owner.current(), 'waiting-browser'))
    expect((await phase(() => owner.current(), 'failed')).lastError).toBe('MCP OAuth request failed')
    const output = logs.join('\n')
    expect(output).toContain('"access_token":"[redacted]"')
    expect(output).toContain('"refresh_token":"[redacted]"')
    expect(output).not.toMatch(/private-(access|refresh)-token/)
  })

  it('retains static client identity after invalid_client', async () => {
    const world = await oauthWorld()
    const owner = world.owner({ ...world.config, oauth: { ...world.config.oauth, clientId: 'static-client' } })
    await owner.start()
    await callback(await phase(() => owner.current(), 'waiting-browser'), { error: 'invalid_client' })
    await phase(() => owner.current(), 'failed')
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    expect(new URL(waiting.authorizationUrl!).searchParams.get('client_id')).toBe('static-client')
    expect(world.registrations()).toBe(0)
    expect((await world.ctx.credentials.listRecords()).length).toBe(1)
  })

  it('serializes concurrent refreshes and preserves the grant identity and client authentication method', async () => {
    const world = await oauthWorld()
    const owner = world.owner()
    await authorize(owner)
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    const signal = new AbortController().signal
    const old = await store.read(world.config.url, signal)
    await world.ctx.credentials.modifyRecord(store.key, async (record) => {
      if (record?.kind !== 'grant') throw new Error('Missing grant')
      return { ...record, payload: { ...old, expiresAt: 0 } }
    })
    const transport = store.transport(old, signal, fetch)
    expect(await Promise.all([transport.authProvider.token(), transport.authProvider.token()])).toEqual(['access-2', 'access-2'])
    expect(world.tokens()).toBe(2)
    expect((await store.read(world.config.url, signal)).id).toBe(old.id)
    const refresh = world.requests.find(request => request.form.get('grant_type') === 'refresh_token')!
    expect(refresh.form.get('client_secret')).toBe('fixture-client-secret')
    expect(refresh.headers.authorization).toBeUndefined()
  })

  it('sends an advertised resource without a path verbatim in authorization, exchange, and refresh', async () => {
    const world = await oauthWorld()
    world.behavior.resource = world.origin
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    expect(new URL(waiting.authorizationUrl!).searchParams.get('resource')).toBe(world.origin)
    expect(await callback(waiting)).toBe(200)
    await phase(() => owner.current(), 'authorized')
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    const signal = new AbortController().signal
    const grant = await store.read(world.config.url, signal)
    await world.ctx.credentials.modifyRecord(store.key, async () => oauthRecord({ ...grant, expiresAt: 0 }))
    expect(await store.transport(grant, signal, fetch).authProvider.token()).toBe('access-2')
    expect(world.requests.filter(request => request.path === '/token').map(request => request.form.get('resource')))
      .toEqual([world.origin, world.origin])
  })

  it('keeps passive probes noninteractive and connects with a committed grant', async () => {
    const world = await oauthWorld()
    const missing = await probeServer(world.ctx, world.config)
    expect(missing).toMatchObject({ ok: false, stage: 'connect', closeConfirmed: true })
    if (missing.ok) throw new Error('Expected a missing authorization failure')
    expect(missing.message).toContain('authorization: missing')
    expect(world.requests).toHaveLength(0)
    const owner = world.owner()
    await authorize(owner)
    expect(await probeServer(world.ctx, world.config)).toMatchObject({ ok: true, closeConfirmed: true })
    const passive = await oauthWorld(false)
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    const grant = await store.read(world.config.url, new AbortController().signal)
    await passive.ctx.credentials.modifyRecord(store.key, async () => oauthRecord(grant))
    expect(await probeServer(passive.ctx, world.config)).toMatchObject({ ok: true, closeConfirmed: true })
    expect(passive.ctx.get('authorization')).toBeUndefined()
    expect(passive.ctx.get('webServer')).toBeUndefined()
    expect(world.registrations()).toBe(1)
  })

  it.each([false, true])('settles an asynchronous probe error according to its authorization classification (%s)', async (unauthorized) => {
    const world = await oauthWorld()
    await authorize(world.owner())
    const caps = vi.spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue(undefined)
    const spy = vi.spyOn(Client.prototype, 'getServerVersion').mockImplementation(function (this: Client) {
      this.onerror?.(unauthorized ? new UnauthorizedError() : new Error('private-transport-error'))
      return { name: 'oauth-fixture', version: '1.0.0' }
    })
    onTestFinished(() => { caps.mockRestore(); spy.mockRestore() })
    const result = await probeServer(world.ctx, world.config)
    expect(result).toMatchObject({ ok: !unauthorized, closeConfirmed: true })
    if (!result.ok) expect(result.message).toContain('authorization')
  })

  it('withholds observer error details for OAuth connections', async () => {
    const world = await oauthWorld()
    await authorize(world.owner())
    await apply(world.ctx, world.config)
    const warnings = vi.spyOn(world.ctx.logger, 'warn').mockImplementation(() => undefined)
    onTestFinished(() => { warnings.mockRestore() })
    connectionStatusOf(world.ctx.fiber)!.onChange(() => { throw new Error('private-observer-error') })
    const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
    await world.ctx.credentials.deleteRecord(store.key)
    await vi.waitFor(() => { expect(warnings).toHaveBeenCalled() })
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-observer-error')
  })

  it('replaces a connected generation after reauthorization without publishing waiting-authorization', async () => {
    const world = await oauthWorld()
    const owner = world.owner()
    await authorize(owner)
    await apply(world.ctx, world.config)
    const cell = connectionStatusOf(world.ctx.fiber)!
    const states: string[] = [cell.current().state]
    const reconnected = world.barrier()
    cell.onChange((status) => {
      states.push(status.state === 'waiting-authorization' ? `waiting-authorization:${status.reason}` : status.state)
      if (status.state === 'connected') reconnected.resolve()
    })
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    // The commit's credential refresh is the next template resolution; holding it keeps the old generation current.
    const entered = world.barrier()
    const release = world.barrier()
    let held = false
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted binding as receiver.
    const resolve: (this: McpTemplateBinding, signal: AbortSignal) => Promise<Config> = McpTemplateBinding.prototype.resolve
    const spy = vi.spyOn(McpTemplateBinding.prototype, 'resolve').mockImplementation(async function (this: McpTemplateBinding, signal) {
      if (!held) {
        held = true
        entered.resolve()
        await release.promise
      }
      return resolve.call(this, signal)
    })
    onTestFinished(() => { spy.mockRestore() })
    expect(await callback(waiting)).toBe(200)
    await entered.promise
    const call = await executeToolFixture(world.ctx, { callId: ToolCallId('stale-grant'), name: 'mcp__oauth__ping', arguments: {}, signal: new AbortController().signal })
    expect(call).toMatchObject({ isError: true })
    release.resolve()
    await reconnected.promise
    expect(states).toEqual(['connected', 'connecting', 'connected'])
    expect(await executeToolFixture(world.ctx, { callId: ToolCallId('fresh-grant'), name: 'mcp__oauth__ping', arguments: {}, signal: new AbortController().signal }))
      .toMatchObject({ isError: false })
  })

  it('rejects mismatched or duplicate callback state and issuer before accepting a single valid callback', async () => {
    const world = await oauthWorld()
    const owner = world.owner()
    await owner.start()
    const waiting = await phase(() => owner.current(), 'waiting-browser')
    const authorization = new URL(waiting.authorizationUrl!)
    const url = new URL(authorization.searchParams.get('redirect_uri')!)
    url.searchParams.set('code', 'fixture-code')
    expect((await fetch(url)).status).toBe(400)
    url.searchParams.set('state', 'wrong-state')
    url.searchParams.set('iss', world.origin)
    expect((await fetch(url)).status).toBe(400)
    url.searchParams.set('state', authorization.searchParams.get('state')!)
    url.searchParams.append('state', authorization.searchParams.get('state')!)
    expect((await fetch(url)).status).toBe(400)
    url.searchParams.delete('state')
    url.searchParams.set('state', authorization.searchParams.get('state')!)
    url.searchParams.set('iss', 'https://wrong-issuer.invalid')
    expect((await fetch(url)).status).toBe(400)
    expect(world.tokens()).toBe(0)
    expect(await callback(waiting)).toBe(200)
    await phase(() => owner.current(), 'authorized')
    expect(await callback(waiting)).not.toBe(200)
    expect(world.tokens()).toBe(1)
  })
})
