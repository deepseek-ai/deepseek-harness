/** Connectors register their server's account with `ctx.mcpAccounts`, which shows it through the connector account registry. */
import { Context } from '@deepseek-ai/cordis'
import ConnectorAccounts from '@deepseek-ai/dsh-client-ui-connector-account'
import type { ConnectorAccountsView } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { expect, it, onTestFinished } from 'vitest'
import McpAccounts from '../src/index.ts'
import { ATTEMPT, COPY, fakeManager, OPERATION } from './fixture.ts'

async function registry() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const manager = fakeManager([{ name: 'acme', configured: true, status: { state: 'waiting-authorization', reason: 'missing', lastError: 'none' } }])
  ctx.provide('mcpManager', manager)
  await ctx.plugin(ConnectorAccounts)
  const service = ctx.plugin(McpAccounts)
  await service
  return { ctx, manager, service }
}

async function first(ctx: Context): Promise<ConnectorAccountsView> {
  const stream = ctx.connectorAccounts.watch(new AbortController().signal)[Symbol.asyncIterator]()
  const next = await stream.next()
  await stream.return?.()
  if (next.done === true) throw new Error('the registry stream ended')
  return next.value
}

it('registers each server under its key and bundle package and routes the page operations to the manager', async () => {
  const { ctx, manager } = await registry()
  const withdraw = ctx.mcpAccounts.register({ server: 'acme', packageName: '@acme/connector', copy: COPY })
  const [entry] = (await first(ctx)).accounts
  expect(entry).toMatchObject({
    key: 'mcp:acme', packageName: '@acme/connector', copy: { title: 'Acme account', activation: { connect: 'Connect Acme' } },
    display: { phase: 'disconnected', connect: { kind: 'start', operation: 'connect' } },
  })
  await expect(ctx.connectorAccounts.start('mcp:acme', 'connect')).resolves.toBe(OPERATION)
  expect(manager.startAuthorization).toHaveBeenCalledWith('acme')
  await ctx.connectorAccounts.start('mcp:acme', 'sign-out')
  await ctx.connectorAccounts.start('mcp:acme', 'retry')
  expect(manager.signOut).toHaveBeenCalledWith('acme')
  expect(manager.restart).toHaveBeenCalledWith('acme')
  withdraw()
  expect((await first(ctx)).accounts).toEqual([])
})

it('reports the connector notices for the connection and sign-out it registered', async () => {
  const { ctx, manager } = await registry()
  ctx.mcpAccounts.register({ server: 'acme', packageName: '@acme/connector', copy: COPY })
  const signedOut = await ctx.connectorAccounts.start('mcp:acme', 'sign-out')
  expect((await first(ctx)).accounts[0]?.result).toEqual({ id: signedOut, notice: 'Signed out of Acme' })
  const restarted = await ctx.connectorAccounts.start('mcp:acme', 'retry')
  expect((await first(ctx)).accounts[0]?.result).toEqual({ id: restarted })
  manager.servers = [{ ...manager.servers[0]!, authorization: { id: ATTEMPT, phase: 'authorized' } }]
  await ctx.connectorAccounts.start('mcp:acme', 'connect')
  expect((await first(ctx)).accounts[0]?.result).toEqual({ id: OPERATION, notice: 'Acme connected' })
})

it('refuses a second account for one server or one package', async () => {
  const { ctx } = await registry()
  ctx.mcpAccounts.register({ server: 'acme', packageName: '@acme/connector', copy: COPY })
  expect(() => ctx.mcpAccounts.register({ server: 'acme', packageName: '@acme/other', copy: COPY })).toThrow('mcp:acme is already registered')
  expect(() => ctx.mcpAccounts.register({ server: 'other', packageName: '@acme/connector', copy: COPY })).toThrow('@acme/connector already has an account')
})

it('withdraws a connector account when the service unloads and its connector scope ends', async () => {
  const { ctx, service } = await registry()
  ctx.inject(['mcpAccounts'], (scope) => {
    scope.effect(() => scope.mcpAccounts.register({ server: 'acme', packageName: '@acme/connector', copy: COPY }), 'acme: account')
  })
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  expect((await first(ctx)).accounts.map(entry => entry.key)).toEqual(['mcp:acme'])
  await service.dispose()
  expect(ctx.get('mcpAccounts')).toBeUndefined()
  expect((await first(ctx)).accounts).toEqual([])
})
