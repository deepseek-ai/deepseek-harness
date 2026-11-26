/** OAuth management through the real profile loader, SDK, and durable credential provider. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Client, UnauthorizedError } from '@modelcontextprotocol/client'
import { McpOAuthCredentials } from '@deepseek-ai/dsh-mcp-client/src/oauth-credentials.ts'
import { callback, oauthWorld, phase } from '../../mcp-client/tests/oauth-fixture.ts'
import { managerProfile } from './profile-fixture.ts'
import type { McpManagedServerView } from '../src/types.ts'

async function managed(layer: 'base' | 'user' = 'base') {
  const world = await oauthWorld()
  const servers = { oauth: { ...world.config, enabled: true } }
  await managerProfile(world.ctx, layer === 'base' ? { base: { servers } } : { base: { servers: {} }, user: { servers } })
  const manager = world.ctx.mcpManager
  const view = () => manager.list().find(entry => entry.name === 'oauth')!
  const state = async (expected: string) => {
    await vi.waitFor(() => { expect(view().status.state).toBe(expected) }, { timeout: 5000 })
  }
  const login = async () => {
    await manager.startAuthorization('oauth')
    expect(await callback(await phase(() => view().authorization, 'waiting-browser'))).toBe(200)
    await phase(() => view().authorization, 'authorized')
    await state('connected')
  }
  const invoke = () => executeToolFixture(world.ctx, { callId: ToolCallId('oauth-call'), name: 'mcp__oauth__ping', arguments: {}, signal: new AbortController().signal })
  const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
  return { ...world, manager, view, state, login, invoke, store }
}

it.each(['signOut', 'restart'] as const)('notifies authorization removal from a disabled entry after %s', async (operation) => {
  const world = await oauthWorld()
  await managerProfile(world.ctx, { base: { servers: { oauth: { ...world.config, enabled: false } } } })
  const manager = world.ctx.mcpManager
  const view = () => manager.list()[0]!
  await manager.startAuthorization('oauth')
  expect(await callback(await phase(() => view().authorization, 'waiting-browser'))).toBe(200)
  await phase(() => view().authorization, 'authorized')
  let observed = view()
  const unwatch = world.ctx.on('mcp-manager/status', () => { observed = view() })
  onTestFinished(() => { unwatch() })
  await manager[operation]('oauth')
  expect(view().authorization).toBeUndefined()
  expect(observed.authorization).toBeUndefined()
  expect(observed.status.state).toBe('disabled')
  const store = new McpOAuthCredentials(world.ctx, world.config.oauth)
  expect(await world.ctx.credentials.readRecord(store.key) !== undefined).toBe(operation === 'restart')
})

it('cancels only the selected attempt and retires authorization when a disabled entry changes', async () => {
  const world = await oauthWorld()
  await managerProfile(world.ctx, { base: { servers: { oauth: { ...world.config, enabled: false } } } })
  const manager = world.ctx.mcpManager
  const view = () => manager.list()[0]!.authorization
  const first = await manager.startAuthorization('oauth')
  await manager.cancelAuthorization('missing', first.id)
  await manager.cancelAuthorization('oauth', first.id)
  const second = await manager.startAuthorization('oauth')
  await manager.cancelAuthorization('oauth', first.id)
  const waiting = await phase(view, 'waiting-browser')
  expect(waiting.id).toBe(second.id)
  await world.ctx.settings.update('mcp', { servers: { oauth: { url: world.origin + '/changed' } } })
  await vi.waitFor(() => { expect(view()).toBeUndefined() })
  expect(await callback(waiting)).toBe(404)
})

it.each([false, true])('preserves the grant when authorization cleanup exceeds its deadline (queued restart: %s)', async (restart) => {
  const world = await managed()
  await world.login()
  const old = await world.ctx.credentials.readRecord(world.store.key)
  const entered = world.barrier()
  const gate = world.barrier()
  const read = world.ctx.credentials.readRecord.bind(world.ctx.credentials)
  const spy = vi.spyOn(world.ctx.credentials, 'readRecord').mockImplementation(async (key) => {
    if (String(key).includes('-client-')) { entered.resolve(); await gate.promise }
    return read(key)
  })
  onTestFinished(() => { spy.mockRestore(); vi.useRealTimers() })
  const attempt = await world.manager.startAuthorization('oauth')
  await entered.promise
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const restarting = restart ? expect(world.manager.restart('oauth')).rejects.toThrow('cleanup') : Promise.resolve()
    const signout = world.manager.signOut('oauth')
    const rejected = expect(signout).rejects.toThrow('completed connection and authorization cleanup')
    await phase(() => world.view().authorization, 'cancelled')
    await vi.advanceTimersByTimeAsync(world.config.closeTimeoutMs + 1)
    await restarting
    if (restart) await vi.advanceTimersByTimeAsync(world.config.closeTimeoutMs + 1)
    await rejected
    expect(world.view().status).toEqual({
      state: 'failed', reason: 'cleanup', result: { closeConfirmed: true, cleanupError: 'MCP OAuth cleanup did not settle' },
    })
    expect(await read(world.store.key)).toEqual(old)
    await expect(world.manager.startAuthorization('oauth')).rejects.toThrow()
  } finally {
    gate.resolve()
    vi.useRealTimers()
    await world.manager.cancelAuthorization('oauth', attempt.id)
  }
})

it('records authorization cleanup that settles with a failure as failed cleanup, matching the attempt view', async () => {
  const world = await managed()
  const register = world.ctx.authorization.registerFlow.bind(world.ctx.authorization)
  const spy = vi.spyOn(world.ctx.authorization, 'registerFlow').mockImplementation((flow) => {
    const unregister = register(flow)
    return () => { unregister(); throw new Error('private-cleanup-error') }
  })
  onTestFinished(() => { spy.mockRestore() })
  await world.manager.startAuthorization('oauth')
  await phase(() => world.view().authorization, 'waiting-browser')
  await expect(world.manager.restart('oauth')).rejects.toThrow('cleanup for "oauth" is incomplete')
  expect(world.view().status).toEqual({
    state: 'failed', reason: 'cleanup', result: { closeConfirmed: true, cleanupError: 'MCP OAuth cleanup failed' },
  })
  expect(world.view().authorization).toMatchObject({ phase: 'failed', lastError: 'MCP OAuth cleanup failed' })
  expect(JSON.stringify(world.manager.list())).not.toContain('private-cleanup-error')
})

it('ignores stale authorization errors and finishes sign-out while a failed connection is closing', async () => {
  const world = await managed()
  await world.login()
  const entered = world.barrier()
  const gate = world.barrier()
  // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted client as receiver.
  const close = Client.prototype.close
  const spy = vi.spyOn(Client.prototype, 'close').mockImplementation(async function (this: Client) {
    entered.resolve()
    await gate.promise
    await close.call(this)
  })
  onTestFinished(() => { spy.mockRestore() })
  world.behavior.rejection = { status: 401 }
  const invocation = world.invoke()
  try {
    await entered.promise
    const client = spy.mock.contexts[0] as Client
    client.onerror?.(new UnauthorizedError())
    const signout = world.manager.signOut('oauth')
    gate.resolve()
    await signout
    expect(await invocation).toMatchObject({ isError: true })
    expect(await world.ctx.credentials.readRecord(world.store.key)).toBeUndefined()
    expect(world.ctx.tools.getAll()).toEqual([])
  } finally { gate.resolve(); await invocation }
})

it.each([false, true])('preserves an unreconciled entry until its queued sign-out completes (enabled: %s)', async (enabled) => {
  const world = await managed()
  await world.login()
  const entered = world.barrier()
  const gate = world.barrier()
  // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted client as receiver.
  const close = Client.prototype.close
  const spy = vi.spyOn(Client.prototype, 'close').mockImplementation(async function (this: Client) {
    entered.resolve()
    await gate.promise
    await close.call(this)
  })
  onTestFinished(() => { spy.mockRestore() })
  const restarting = world.manager.restart('oauth')
  try {
    await entered.promise
    await world.ctx.settings.update('mcp', { servers: { added: {
      ...world.config, enabled, oauth: { ...world.config.oauth, credentialKey: 'mcp-client/added' },
    } } })
    const statuses: string[] = []
    const unwatch = world.ctx.on('mcp-manager/status', (name, status) => { if (name === 'added') statuses.push(status.state) })
    onTestFinished(() => { unwatch() })
    await world.manager.startAuthorization('added')
    expect(world.manager.list().find(entry => entry.name === 'added')?.status.state).toBe(enabled ? 'connecting' : 'disabled')
    expect(statuses).toEqual([enabled ? 'connecting' : 'disabled'])
    const signingOut = world.manager.signOut('added')
    gate.resolve()
    await restarting
    await signingOut
    expect(world.manager.list().find(entry => entry.name === 'added')?.authorization).toBeUndefined()
  } finally { gate.resolve(); await restarting }
})

it('signs out an unchanged entry after an already queued restart', async () => {
  const world = await managed()
  await world.login()
  const restarting = world.manager.restart('oauth')
  const signingOut = world.manager.signOut('oauth')
  await Promise.all([restarting, signingOut])
  expect(await world.ctx.credentials.readRecord(world.store.key)).toBeUndefined()
  await world.state('waiting-authorization')
  expect(world.ctx.tools.getAll()).toEqual([])
})

it('preserves the grant when configuration changes before a queued sign-out', async () => {
  const world = await managed()
  await world.login()
  const old = await world.ctx.credentials.readRecord(world.store.key)
  const entered = world.barrier()
  const gate = world.barrier()
  // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted client as receiver.
  const close = Client.prototype.close
  const spy = vi.spyOn(Client.prototype, 'close').mockImplementation(async function (this: Client) {
    entered.resolve()
    await gate.promise
    await close.call(this)
  })
  onTestFinished(() => { spy.mockRestore() })
  const restarting = world.manager.restart('oauth')
  const signingOut = world.manager.signOut('oauth')
  const rejected = expect(signingOut).rejects.toThrow('configuration changed before sign-out')
  try {
    await entered.promise
    await world.ctx.settings.update('mcp', { servers: { oauth: { enabled: false } } })
    gate.resolve()
    await Promise.all([restarting, rejected])
    await world.state('disabled')
    expect(await world.ctx.credentials.readRecord(world.store.key)).toEqual(old)
    await world.manager.startAuthorization('oauth')
  } finally { gate.resolve(); await restarting }
})

it('preserves the grant when a rename keeps its credential key during sign-out cleanup', async () => {
  const world = await managed('user')
  await world.login()
  const old = await world.ctx.credentials.readRecord(world.store.key)
  const entered = world.barrier()
  const gate = world.barrier()
  // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted client as receiver.
  const close = Client.prototype.close
  const spy = vi.spyOn(Client.prototype, 'close').mockImplementation(async function (this: Client) {
    entered.resolve()
    await gate.promise
    await close.call(this)
  })
  onTestFinished(() => { spy.mockRestore() })
  const signingOut = world.manager.signOut('oauth')
  const rejected = expect(signingOut).rejects.toThrow('configuration changed before sign-out')
  try {
    await entered.promise
    await world.ctx.settings.replace('mcp', { servers: { renamed: { ...world.config, enabled: true } } })
    gate.resolve()
    await rejected
    expect(await world.ctx.credentials.readRecord(world.store.key)).toEqual(old)
    await vi.waitFor(() => {
      expect(world.manager.list()).toMatchObject([{ name: 'renamed', status: { state: 'connected' } }])
    }, { timeout: 5000 })
  } finally { gate.resolve() }
})

it('signs out through the profile while retaining registration and excluding starts and probes until deletion settles', async () => {
  const world = await managed()
  await world.state('waiting-authorization')
  expect(world.requests).toHaveLength(0)
  await world.login()
  expect(await world.invoke()).toMatchObject({ isError: false })
  const deletion = world.barrier()
  const entered = world.barrier()
  const remove = world.ctx.credentials.deleteRecord.bind(world.ctx.credentials)
  const spy = vi.spyOn(world.ctx.credentials, 'deleteRecord').mockImplementation(async (key) => {
    if (key === world.store.key) { entered.resolve(); await deletion.promise }
    await remove(key)
  })
  onTestFinished(() => { spy.mockRestore() })
  const signout = world.manager.signOut('oauth')
  await entered.promise
  await expect(world.manager.startAuthorization('oauth')).rejects.toThrow('mcp-manager: configuration for "oauth" is changing')
  await expect(world.manager.probe('oauth')).rejects.toThrow('changing')
  expect(world.ctx.tools.getAll()).toEqual([])
  deletion.resolve()
  await signout
  await world.state('waiting-authorization')
  expect(await world.ctx.credentials.readRecord(world.store.key)).toBeUndefined()
  expect((await world.ctx.credentials.listRecords()).length).toBe(1)
  await world.login()
  expect(world.registrations()).toBe(1)
  expect(await world.invoke()).toMatchObject({ isError: false })
})

it('cancels connection refresh before draining authorization commit queued on the same credential document', async () => {
  const world = await managed()
  await world.login()
  await world.manager.startAuthorization('oauth')
  const waiting = await phase(() => world.view().authorization, 'waiting-browser')
  const old = await world.store.read(world.config.url, new AbortController().signal)
  await world.ctx.credentials.modifyRecord(world.store.key, async () => ({ kind: 'grant', payload: { ...old, expiresAt: 0 } }))
  const refreshing = world.barrier()
  const disconnected = world.barrier()
  world.behavior.token = async (request) => {
    if (request.form.get('grant_type') === 'refresh_token') {
      const closed = new Promise<void>((resolve) => { request.response.once('close', resolve) })
      refreshing.resolve()
      await closed
      disconnected.resolve()
    } else request.response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      access_token: 'replacement-access', refresh_token: 'replacement-refresh', token_type: 'Bearer', expires_in: 3600,
    }))
  }
  const call = world.invoke()
  await refreshing.promise
  expect(await callback(waiting)).toBe(200)
  await phase(() => world.view().authorization, 'committing')
  await world.manager.signOut('oauth')
  await disconnected.promise
  expect(await call).toMatchObject({ isError: true })
  await world.state('waiting-authorization')
  expect(await world.ctx.credentials.readRecord(world.store.key)).toBeUndefined()
  expect(world.ctx.tools.getAll()).toEqual([])
  expect((await world.ctx.credentials.listRecords()).length).toBe(1)
})

it.each(['unauthorized', 'invalid-grant', 'scope', 'forbidden'] as const)('handles a live %s response without interactive authorization', async (reason) => {
  const world = await managed()
  await world.login()
  if (reason === 'invalid-grant') {
    const old = await world.store.read(world.config.url, new AbortController().signal)
    await world.ctx.credentials.modifyRecord(world.store.key, async () => ({ kind: 'grant', payload: { ...old, expiresAt: 0 } }))
    world.behavior.token = async ({ response }) => {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }))
    }
  } else world.behavior.rejection = reason === 'unauthorized' ? { status: 401 }
    : reason === 'scope' ? { status: 403, challenge: 'Bearer error="insufficient_scope", scope="more"' } : { status: 403 }
  expect(await world.invoke()).toMatchObject({ isError: true })
  if (reason === 'forbidden') {
    expect(world.view().status.state).toBe('connected')
    expect(world.ctx.tools.getAll()).toHaveLength(2)
  } else {
    await world.state('waiting-authorization')
    expect(world.view().status).toMatchObject({ reason: reason === 'scope' ? 'scope' : 'rejected' })
    expect(world.ctx.tools.getAll()).toEqual([])
  }
  expect(world.registrations()).toBe(1)
  expect(world.view().authorization?.phase).toBe('authorized')
})

it('registers an OAuth server, streams its authorization, and redacts its access token from tool errors', async () => {
  const world = await oauthWorld()
  await managerProfile(world.ctx, { base: { servers: {} } })
  const manager = world.ctx.mcpManager
  manager.register('oauth', {
    transport: 'streamable-http', url: world.origin + '/mcp', oauth: { credentialKey: 'mcp-client/oauth' }, reconnect: { enabled: false },
  })
  const subscriber = new AbortController()
  onTestFinished(() => { subscriber.abort() })
  const stream = manager.watch(subscriber.signal)[Symbol.asyncIterator]()
  const next = async (accept: (view: McpManagedServerView | undefined) => boolean): Promise<McpManagedServerView> => {
    for (;;) {
      const result = await stream.next()
      if (result.done === true) throw new Error('watch ended')
      if (accept(result.value[0])) return result.value[0]!
    }
  }
  await next(view => view?.status.state === 'waiting-authorization')
  await manager.startAuthorization('oauth')
  const waiting = await next(view => view?.authorization?.phase === 'waiting-browser')
  expect(await callback(waiting.authorization!)).toBe(200)
  await next(view => view?.status.state === 'connected')
  const result = await executeToolFixture(world.ctx, {
    callId: ToolCallId('oauth-reject'), name: 'mcp__oauth__reject', arguments: {}, signal: new AbortController().signal,
  })
  if (!result.isError) throw new Error('expected the fixture to reject the call')
  expect(result.error.message).toBe('rejected Bearer [redacted]')
})

it('refuses a registration whose OAuth credential key a configured entry already owns', async () => {
  const world = await oauthWorld()
  await managerProfile(world.ctx, { base: { servers: { configured: { ...world.config, enabled: false } } } })
  expect(() => world.ctx.mcpManager.register('registered', {
    transport: 'streamable-http', url: world.origin + '/mcp', oauth: { credentialKey: 'mcp-client/oauth' },
  })).toThrow('OAuth credentialKey is already assigned to another server')
  expect(world.ctx.mcpManager.list().map(view => view.name)).toEqual(['configured'])
})
