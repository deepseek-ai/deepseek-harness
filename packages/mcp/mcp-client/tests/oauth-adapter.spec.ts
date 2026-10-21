/** OAuth adapter failures at the SDK and authorization service interfaces. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { auth } from '@modelcontextprotocol/client'
import { McpOAuthAuthorization } from '../src/oauth.ts'
import { callback, captureLogs, oauthWorld, phase } from './oauth-fixture.ts'

const { sdkAuth } = vi.hoisted(() => ({ sdkAuth: vi.fn<typeof auth>() }))
vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(), auth: sdkAuth,
}))

it('refuses token persistence before callback and issuer-less client persistence', async () => {
  const world = await oauthWorld()
  sdkAuth.mockImplementation(async (provider) => {
    await expect(provider.clientInformation()).rejects.toThrow('issuer is unavailable')
    await expect(provider.saveClientInformation!({ client_id: 'unbound' })).rejects.toThrow('issuer is unavailable')
    expect(() => provider.saveTokens({ access_token: 'uncommitted', token_type: 'Bearer' })).toThrow('callback before committing')
    expect(() => provider.codeVerifier()).toThrow('verifier is unavailable')
    await provider.saveCodeVerifier('fixture-verifier')
    expect(await provider.codeVerifier()).toBe('fixture-verifier')
    throw new Error('private-upstream-error')
  })
  const owner = world.owner()
  await owner.start()
  expect((await phase(() => owner.current(), 'failed')).lastError).toBe('MCP OAuth request failed')
  expect(await world.ctx.credentials.listRecords()).toEqual([])
})

it('logs an Authorization rejection that the attempt reports only as a failed request', async () => {
  const world = await oauthWorld()
  const logs = captureLogs(world.ctx)
  const register = world.ctx.authorization.registerFlow.bind(world.ctx.authorization)
  const spy = vi.spyOn(world.ctx.authorization, 'registerFlow').mockImplementation(flow => register({ ...flow, run: async () => undefined }))
  onTestFinished(() => { spy.mockRestore() })
  const owner = world.owner()
  await owner.start()
  expect((await phase(() => owner.current(), 'failed')).lastError).toBe('MCP OAuth request failed')
  expect(logs.join('\n')).toContain('explicit authorization: AuthorizationError: authorization flow for "mcp-client/oauth" resolved without committing')
})

it('refuses exchange when the SDK has not supplied the authorization context', async () => {
  const world = await oauthWorld()
  sdkAuth.mockImplementation(async (provider) => {
    const url = new URL(world.origin + '/authorize')
    url.searchParams.set('redirect_uri', String(provider.redirectUrl))
    url.searchParams.set('state', await provider.state!())
    await provider.redirectToAuthorization(url)
    return 'REDIRECT'
  })
  const owner = world.owner()
  await owner.start()
  await callback(await phase(() => owner.current(), 'waiting-browser'))
  expect((await phase(() => owner.current(), 'failed')).lastError).toContain('context is incomplete')
  expect(world.tokens()).toBe(0)
})

it('settles cancellation before flow execution and contains flow-disposer failures', async () => {
  const world = await oauthWorld()
  const register = world.ctx.authorization.registerFlow.bind(world.ctx.authorization)
  const spy = vi.spyOn(world.ctx.authorization, 'registerFlow').mockImplementation((flow) => {
    const unregister = register({ ...flow, run: async (session) => {
      session.notify({ message: 'notice' })
      await expect(session.prompt({ kind: 'text', message: 'text' })).rejects.toThrow('does not request text input')
      world.ctx.authorization.cancel(flow.key)
      await flow.run(session)
    } })
    return () => { unregister(); throw new Error('private-cleanup-error') }
  })
  onTestFinished(() => { spy.mockRestore() })
  const owner = new McpOAuthAuthorization(world.ctx, world.config, () => undefined)
  onTestFinished(async () => {
    expect(await owner.dispose()).toEqual({ closeConfirmed: true, cleanupError: 'MCP OAuth cleanup failed' })
  })
  await owner.start()
  const failed = await phase(() => owner.current(), 'failed')
  expect(failed.lastError).toBe('MCP OAuth cleanup failed')
  expect(world.requests).toHaveLength(0)
  await expect(owner.cancel(failed.id)).rejects.toThrow('MCP OAuth cleanup failed')
  await expect(owner.start()).rejects.toThrow('MCP OAuth cleanup failed')
})
