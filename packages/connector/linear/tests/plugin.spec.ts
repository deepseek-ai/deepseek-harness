/** Linear plugin over a real MCP manager profile and a loopback OAuth MCP server. */

import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ConnectorAccounts from '@deepseek-ai/dsh-client-ui-connector-account'
import type { ConnectorAccountsView } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import McpAccounts from '@deepseek-ai/dsh-mcp-account'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { callback, oauthWorld, phase } from '../../../mcp/mcp-client/tests/oauth-fixture.ts'
import { managerProfile } from '../../../mcp/mcp-manager/tests/profile-fixture.ts'
import { COPY } from '../src/locales.ts'
import * as Linear from '../src/index.ts'

// Verbatim pin of the model-visible guidance in src/index.ts.
const GUIDANCE = 'Tools named `mcp__linear__*` come from the Linear plugin. In user-facing replies, call it the Linear plugin (Linear 插件 in Chinese), not MCP.'
  + ' If no `mcp__linear__*` tool appears in your tool list, Linear is not connected yet; ask the user to connect it on the Linear plugin page in Plugins.'

async function fixture(servers: Record<string, unknown> = {}) {
  const world = await oauthWorld()
  await world.ctx.plugin(McpResources)
  await managerProfile(world.ctx, { base: { servers } })
  const view = () => world.ctx.mcpManager.list().find(entry => entry.name === 'linear')
  const state = async (expected: McpManagedServerStatus['state']) => {
    await vi.waitFor(() => { expect(view()?.status.state).toBe(expected) }, { timeout: 5000 })
  }
  const mount = (config: Partial<Linear.Config> = {}) => world.ctx.plugin(Linear, { url: world.origin + '/mcp', ...config })
  const prompt = async () => renderPrompt(await world.ctx.systemPrompt.assemble())
  const ping = () => executeToolFixture(world.ctx, {
    callId: ToolCallId('linear-ping'), name: 'mcp__linear__ping', arguments: {}, signal: new AbortController().signal,
  })
  const grant = async () => (await world.ctx.credentials.describeRecord(parseCredentialKey('mcp-client/linear'))).configured
  const agent = async (): Promise<Agent> => {
    const holder: { ctx?: Context } = {}
    const created = holder as Agent
    await world.ctx.plugin({ inject: ['tools'], apply(inner: Context) { holder.ctx = createScope(inner, created).ctx } })
    await world.ctx.serial('agent/created', { agent: created, source: 'startup' })
    return created
  }
  const authorize = async () => {
    await world.ctx.mcpManager.startAuthorization('linear')
    expect(await callback(await phase(() => view()?.authorization, 'waiting-browser'))).toBe(200)
    await state('connected')
  }
  return { ...world, view, state, mount, prompt, ping, grant, agent, authorize }
}

it('defaults to the hosted Linear endpoint', () => {
  expect(Linear.Config({})).toEqual({ url: 'https://mcp.linear.app/mcp', toolLoading: 'on-demand' })
})

it('registers Linear for the plugin lifetime and reuses the saved grant after reloading', async () => {
  const b = await fixture()
  // Eager tools register for the Host, so the test calls them without an agent.
  const first = b.mount({ toolLoading: 'eager' })
  await first.await()
  await b.state('waiting-authorization')
  expect(b.view()?.status).toMatchObject({ reason: 'missing' })
  expect(await b.prompt()).toContain(GUIDANCE)
  expect(await b.ping()).toMatchObject({ isError: true })

  await b.authorize()
  expect(await b.ping()).toMatchObject({ isError: false })

  await first.dispose()
  expect(b.view()).toBeUndefined()
  expect(await b.prompt()).not.toContain(GUIDANCE)
  expect(await b.ping()).toMatchObject({ isError: true })
  expect(await b.grant()).toBe(true)

  const tokens = b.tokens()
  await b.mount({ toolLoading: 'eager' }).await()
  await b.state('connected')
  expect(await b.ping()).toMatchObject({ isError: false })
  expect(b.view()?.authorization).toBeUndefined()
  expect(b.tokens()).toBe(tokens)
  expect(b.registrations()).toBe(1)
})

it('keeps Linear tools hidden from an agent until it loads them, unless loading is eager', async () => {
  const b = await fixture()
  const agent = await b.agent()
  const onDemand = b.mount()
  await onDemand.await()
  await b.authorize()
  expect(b.ctx.tools.get('mcp__linear__ping', agent)).toBeUndefined()
  expect(b.ctx.tools.get('mcp__linear__load_tools', agent)).toBeDefined()
  expect(await executeToolFixture(b.ctx, {
    callId: ToolCallId('linear-load'), name: 'mcp__linear__load_tools', arguments: { tools: ['ping'] },
    signal: new AbortController().signal, agent,
  })).toMatchObject({ isError: false, value: 'Loaded: mcp__linear__ping.' })
  expect(b.ctx.tools.get('mcp__linear__ping', agent)).toBeDefined()

  await onDemand.dispose()
  const other = await b.agent()
  await b.mount({ toolLoading: 'eager' }).await()
  await b.state('connected')
  expect(b.ctx.tools.get('mcp__linear__ping', other)).toBeDefined()
})

/** Read the account stream until a view satisfies the predicate. */
async function until(
  stream: AsyncIterator<ConnectorAccountsView>, predicate: (view: ConnectorAccountsView) => boolean,
): Promise<ConnectorAccountsView> {
  for (;;) {
    const next = await stream.next()
    if (next.done === true) throw new Error('account stream ended')
    if (predicate(next.value)) return next.value
  }
}

it('shows the Linear account on the Plugins page while the account registry runs, and withdraws it with the plugin', async () => {
  const b = await fixture()
  await b.ctx.plugin(ConnectorAccounts)
  await b.ctx.plugin(McpAccounts)
  const stream = b.ctx.connectorAccounts.watch(new AbortController().signal)[Symbol.asyncIterator]()
  const plugin = b.mount()
  await plugin.await()
  const shown = await until(stream, view => view.accounts[0]?.display.phase === 'disconnected')
  expect(shown.accounts).toHaveLength(1)
  expect(shown.accounts[0]).toMatchObject({
    key: 'mcp:linear', packageName: '@deepseek-ai/dsh-linear',
    copy: { title: COPY.title, activation: { connect: COPY.connect } }, display: { phase: 'disconnected' },
  })
  await plugin.dispose()
  await until(stream, view => view.accounts.length === 0)
})

it('refuses to load when a configured server already uses the Linear name', async () => {
  const b = await fixture({ linear: { transport: 'streamable-http', url: 'https://linear.example/mcp', enabled: false } })
  await expect(b.mount().await()).rejects.toThrow('server "linear" is already configured or registered')
  expect(await b.prompt()).not.toContain(GUIDANCE)
})

it('refuses to load when a configured server already uses the Linear credential key', async () => {
  const b = await fixture({ tracker: { transport: 'streamable-http', url: 'https://tracker.example/mcp', oauth: { credentialKey: 'mcp-client/linear' }, enabled: false } })
  await expect(b.mount().await()).rejects.toThrow('OAuth credentialKey is already assigned to another server')
  expect(await b.prompt()).not.toContain(GUIDANCE)
})
