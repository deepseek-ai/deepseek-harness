/** Node half: registers the /api prefix route bridging to the api gateway. */
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { IndexInjection, WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, RpcId, apply, inject, type ClientRequest, type ConnectionConfig, type HostConnectionHandle } from '../src/index.ts'
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from '../src/http-bridge.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): {
  response: ServerResponse
  state: { status?: number; headers?: Record<string, string>; body?: unknown }
} {
  const state: { status?: number; headers?: Record<string, string>; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(config?: ConnectionConfig): Promise<{
  ctx: Context
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  connection: HostConnectionHandle
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  provideBrowserCredentials(ctx)
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    ctx,
    routes,
    upgrades,
    connection: ctx.get('connection') as HostConnectionHandle,
    dispose: () => fiber.dispose(),
  }
}

/** Exchange a service's process token for one authority-bound Cookie header. */
function browserCookie(connection: HostConnectionHandle, authority: string): string {
  const url = new URL(connection.authenticatedUrl(`http://${authority}`))
  const exchanged = fakeResponse()
  connection.authorizeIndex(
    fakeRequest({ host: authority }, `${url.pathname}${url.search}`),
    exchanged.response,
  )
  const setCookie = exchanged.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

describe('connection node half', () => {
  it('injects validated browser recovery timing and withdraws it on disposal', async () => {
    const { ctx, dispose } = await mounted({ recovery: { generationReadyTimeoutMs: 25_000 } })
    try {
      const rows: IndexInjection[] = []
      ctx.emit('webserver/index-inject', rows)
      expect(rows).toEqual([{
        kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: {
          backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 10_000,
          generationReadyWarnMs: 3_000, generationReadyTimeoutMs: 25_000,
        },
      }])
      await dispose()
      const after: IndexInjection[] = []
      ctx.emit('webserver/index-inject', after)
      expect(after).toEqual([])
    } finally {
      await dispose()
    }
  })

  it.each([
    { recovery: { backoffBaseMs: 0 }, error: /backoffBaseMs/ },
    { recovery: { backoffFactor: NaN }, error: /backoffFactor.*finite/ },
  ])('rejects invalid recovery timing before acquiring Host resources: $recovery', async ({ recovery, error }) => {
    const ctx = new Context()
    await expect(apply(ctx, { recovery })).rejects.toThrow(error)
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('reserves enough default carrier capacity for the 200 MiB image batch', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(300 * 1024 * 1024)
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBeGreaterThan(Math.ceil(200 * 1024 * 1024 * 4 / 3) + 1024 * 1024)
  })

  it('fails loud when the carrier cap cannot hold the configured image batch', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    await expect(apply(ctx, { maxRequestBodyBytes: 1024 }))
      .rejects.toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers only the HTTP route and removes it with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades).toHaveLength(0)
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('requires the same browser session for every method on every trusted authority', async () => {
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const methods = [
      'session/openWorkspacePath',
      'llm/discoverModels', 'skills/list', 'settings/openAgentPresetDirectory',
    ]
    for (const method of methods) {
      const denied = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`), denied.response)
      expect([method, denied.state.status, denied.state.body]).toEqual([method, 401, 'unauthorized'])
    }

    const cookie = browserCookie(connection, 'harness.example')
    for (const method of methods) {
      const allowed = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example', cookie }, `${API_PATH}/${method}`),
        allowed.response,
      )
      expect([method, allowed.state.status]).toEqual([method, 404])
    }

    const forged = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'localhost:3080' }), forged.response)
    expect(forged.state).toMatchObject({ status: 401, body: 'unauthorized' })
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: '127.0.0.1:3080',
      cookie: browserCookie(connection, '127.0.0.1:3080'),
    }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // An all-interfaces composition derives port-less LAN IP literals, which
    // pass markerless curl on any port.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: '192.168.1.5:3080',
      cookie: browserCookie(connection, '192.168.1.5:3080'),
    }), lan.response)
    expect(lan.state.status).toBe(404)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080',
      origin: 'http://harness.example:3080',
      'sec-fetch-site': 'same-origin',
      cookie: browserCookie(connection, 'harness.example:3080'),
    }), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })

  it('shares its configured trust and authentication policy with sibling routes', async () => {
    const { connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const loopback = fakeRequest({ host: '127.0.0.1:3080' })
    const declared = fakeRequest({ host: 'harness.example' })

    expect(connection.requestRejection(loopback)).toBe(401)
    expect(connection.requestRejection(declared)).toBe(401)
    expect(connection.requestRejection(fakeRequest({
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }))).toBeUndefined()
    await dispose()
  })

  it('provides a disposable dedicated RPC channel', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({
      host: '127.0.0.1:3080',
      cookie: browserCookie(connection, '127.0.0.1:3080'),
    }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null })))
      .toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([API_PATH])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('dispatches claimed /api endpoints and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { accepted: true } }
      },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    const loopbackCookie = browserCookie(connection, '127.0.0.1:3080')
    await route.handler(fakePost({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(calls).toHaveLength(1)

    const removeAuthenticated = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
    )
    const declared = fakeResponse()
    await route.handler(fakePost({
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }, '/api/goals/create', request), declared.response)
    expect(declared.state.status).toBe(200)
    await removeAuthenticated()
    await fiber.dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.handle('/rpc', async (endpoint) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!
    const harnessHeaders = {
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const unauthenticated = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {}), unauthenticated.response)
    expect(unauthenticated.state).toMatchObject({ status: 401, body: 'unauthorized' })

    const methodMismatch = fakeResponse()
    await route.handler(fakePost(harnessHeaders, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'gateway/bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest(harnessHeaders, '/rpc/goals/create'), 404],
      [fakePost(harnessHeaders, '/outside/goals/create', {}), 404],
      [fakePost(harnessHeaders, '/rpc/goals//create', {}), 404],
      [fakeRawPost(harnessHeaders, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ ...harnessHeaders, 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ ...harnessHeaders, 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost(harnessHeaders, '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'gateway/bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost(harnessHeaders, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'handler failure: Error: handler broke' })

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null })))
      .toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null })))
      .toThrow('invalid or reserved RPC channel')
    await remove()
    await fiber.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string, cookie?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `${API_PATH}/${method}`,
          method: 'GET',
          headers: { host, ...cookie === undefined ? {} : { cookie } },
        },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('requires authentication uniformly over a real HTTP request', async () => {
    // A real IncomingMessage pins the exploit boundary: a client-controlled
    // Host naming loopback passes the rebinding fence but never authenticates.
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const { port, close } = await serve(routes)
    try {
      const methods = [
        'settings/openSettingsDocument',
        'session/openWorkspacePath',
        'llm/discoverModels', 'skills/list',
        'settings/openAgentPresetDirectory',
        'llm/listProviders', 'session/modelCatalog',
      ]
      for (const method of methods) {
        expect([method, await call(port, method, 'localhost')]).toEqual([method, 401])
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 401])
      }
      expect(await call(port, 'settings/openSettingsDocument', 'other.example')).toBe(403)

      const declaredCookie = browserCookie(connection, 'harness.example')
      for (const method of methods) {
        expect([method, await call(port, method, 'harness.example', declaredCookie)]).toEqual([method, 404])
      }
      const loopbackAuthority = `127.0.0.1:${String(port)}`
      expect(await call(
        port,
        'settings/openSettingsDocument',
        loopbackAuthority,
        browserCookie(connection, loopbackAuthority),
      )).toBe(404)
    } finally {
      await close()
      await dispose()
    }
  })
})
