/** The MCP client host: configuration validation, instances below the host, probes, and authorization owners. */

import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'
import { McpClientHost, type ConfigInput } from '@deepseek-ai/dsh-mcp-client'
import { authorize, oauthWorld } from './oauth-fixture.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

async function hosted() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.setRoot(new NativeToolRegistry())
  const entry = ctx.plugin(McpClientHost)
  await entry
  const server = await startHttpMcpFixture()
  onTestFinished(server.close)
  return { ctx, entry, host: ctx.get('mcpClientHost')!, url: server.url }
}

it('resolves server defaults and names every refused field after the server path', async () => {
  const { host } = await hosted()
  expect(host.validate({ transport: 'stdio', serverName: 'local', command: 'echo' }, ['servers', 'local'])).toMatchObject({
    transport: 'stdio', args: [], env: {}, cwd: '', toolCallTimeoutMs: 60_000, closeTimeoutMs: 5_000, expandTemplates: false,
  })
  const http = { transport: 'streamable-http', serverName: 'remote', url: 'https://example.invalid/mcp' } as const
  expect(() => host.validate({ ...http, serverName: 'bad name' }, ['servers', 'bad name']))
    .toThrow('servers.bad name: server name must match')
  expect(() => host.validate({ ...http, closeTimeoutMs: 0 }, ['servers', 'remote']))
    .toThrow('servers.remote.closeTimeoutMs expected number >= 1 but got 0')
  expect(() => host.validate({ ...http, oauth: { credentialKey: 'mcp-client/remote' }, headers: { authorization: 'x' } }, ['servers', 'remote']))
    .toThrow('servers.remote: OAuth and an Authorization header cannot be configured together')
  expect(() => host.validate({ ...http, reconnect: { initialDelayMs: 5_000, maxDelayMs: 100 } }, ['servers', 'remote']))
    .toThrow('servers.remote.reconnect.initialDelayMs must be less than or equal to maxDelayMs')
})

it('checks template tokens by field only when expansion is enabled', async () => {
  const { host } = await hosted()
  const stdio: ConfigInput = { transport: 'stdio', serverName: 'local', command: 'echo', args: ['${credential:A}', '${env:B}'] }
  expect(() => host.validate({ ...stdio, expandTemplates: true }, ['servers', 'local'])).toThrow('servers.local.args[1]')
  expect(host.validate(stdio, ['servers', 'local'])).toMatchObject({ args: ['${credential:A}', '${env:B}'] })
  expect(() => host.validate({
    transport: 'streamable-http', serverName: 'remote', url: 'https://example.invalid/mcp', headers: { 'x-token': '${vault:C}' }, expandTemplates: true,
  }, ['servers', 'remote'])).toThrow('servers.remote.headers.x-token')
})

it('mounts an instance below the host, reports its status, and returns its cleanup result on disposal', async () => {
  const { ctx, host, url } = await hosted()
  const instance = host.mount(host.validate({ transport: 'streamable-http', serverName: 'fixture', url }, ['fixture']))
  const status = await instance.ready
  expect(status.current()).toMatchObject({ state: 'connected', toolCount: 1 })
  expect(ctx.tools.get('mcp__fixture__ping')).toBeDefined()
  expect(await instance.dispose()).toEqual({ closeConfirmed: true })
  expect(ctx.tools.get('mcp__fixture__ping')).toBeUndefined()
})

it('rejects activation that fails before the instance registers status, and disposes it without a cleanup result', async () => {
  const { host, url } = await hosted()
  const config = host.validate({ transport: 'streamable-http', serverName: 'fixture', url, oauth: { credentialKey: 'mcp-client/fixture' } }, ['fixture'])
  if (config.transport !== 'streamable-http') throw new Error('expected a Streamable HTTP configuration')
  const instance = host.mount({ ...config, headers: { Authorization: 'x' } })
  await expect(instance.ready).rejects.toThrow('MCP OAuth and an Authorization header cannot be configured together')
  expect(await instance.dispose()).toBeUndefined()
})

it('probes without registering tools', async () => {
  const { ctx, host, url } = await hosted()
  expect(await host.probe(host.validate({ transport: 'streamable-http', serverName: 'fixture', url }, ['fixture']))).toMatchObject({
    ok: true, toolNames: ['ping'], closeConfirmed: true,
  })
  expect(ctx.tools.get('mcp__fixture__ping')).toBeUndefined()
})

it('creates authorization owners that commit a grant through the host context', async () => {
  const world = await oauthWorld()
  await world.ctx.plugin(McpClientHost)
  const owner = world.ctx.get('mcpClientHost')!.authorization(world.config, () => undefined)
  expect(owner.current()).toBeUndefined()
  await authorize(owner)
  expect(await world.ctx.credentials.listRecords()).toHaveLength(2)
  expect(await owner.dispose()).toEqual({ closeConfirmed: true })
})

it('withdraws the host and every instance it mounted when its owner is disposed', async () => {
  const { ctx, entry, host, url } = await hosted()
  await host.mount(host.validate({ transport: 'streamable-http', serverName: 'fixture', url }, ['fixture'])).ready
  expect(ctx.tools.get('mcp__fixture__ping')).toBeDefined()
  await entry.dispose()
  expect(ctx.get('mcpClientHost')).toBeUndefined()
  expect(ctx.tools.get('mcp__fixture__ping')).toBeUndefined()
})
