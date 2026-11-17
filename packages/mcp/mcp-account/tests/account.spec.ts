/** One server's account follows the MCP manager, runs the page's operations through it, and shows the shared section. */
import { Context } from '@deepseek-ai/cordis'
import type { McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { expect, it, onTestFinished, vi } from 'vitest'
import { present, sectionCopy, ServerAccount, type McpAccountView } from '../src/account.ts'
import { ATTEMPT, COPY, fakeManager, OPERATION } from './fixture.ts'

const server = (status: McpManagedServerStatus, authorization?: McpOAuthAttemptView): McpManagedServerView =>
  ({ name: 'acme', configured: true, status, ...authorization === undefined ? {} : { authorization } })

const shown = (account: McpManagedServerView | undefined) => present({ account } satisfies McpAccountView, COPY)
const labels = (account: McpManagedServerView | undefined) => shown(account).buttons.map(button => button.label)
/** Matches shared copy by the languages a case names. */
const text = (languages: Readonly<Record<string, string>>): LocalizedText => expect.objectContaining(languages) as LocalizedText
const missing: McpManagedServerStatus = { state: 'waiting-authorization', reason: 'missing', lastError: 'none' }

function bench(servers: McpManagedServerView[] = []) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const manager = fakeManager(servers)
  ctx.provide('mcpManager', manager)
  return { ctx, manager, account: new ServerAccount(ctx, 'acme') }
}

it('shows checking until the manager lists the server, then each status with its shared copy and the connector text', () => {
  expect(shown(undefined)).toMatchObject({ phase: 'checking', buttons: [] })
  expect(shown(undefined).badge).toBeUndefined()
  expect(shown(server({ state: 'connecting', attempt: 0 }))).toMatchObject({ phase: 'connecting', detail: 'Connecting to Acme.', buttons: [] })
  expect(shown(server({ state: 'reconnecting', attempt: 1, maxAttempts: 3, nextRetryAtMs: 0, lastError: 'x' }))).toMatchObject({ phase: 'connecting' })
  const connected = shown(server({ state: 'connected', toolCount: 1, connectedAt: 0 }))
  expect(connected).toMatchObject({ phase: 'connected', badge: { zh: '已连接' }, detail: 'Ask the agent to use Acme.' })
  expect(connected.buttons).toEqual([
    { label: text({ en: 'Authorize again', zh: '重新授权' }), command: { kind: 'start', operation: 'connect' } },
    {
      label: text({ en: 'Sign out', zh: '退出登录' }), command: { kind: 'start', operation: 'sign-out' },
      confirm: { title: 'Sign out of Acme?', body: 'The saved grant is removed.', label: text({ en: 'Sign out' }) },
    },
  ])
})

it('offers Connect while no grant exists and shows a grant that needs reconnection as disconnected with its reason', () => {
  expect(shown(server(missing))).toMatchObject({
    phase: 'disconnected', detail: 'Connect to use Acme.', connect: { kind: 'start', operation: 'connect' },
    buttons: [{ label: 'Connect Acme', command: { kind: 'start', operation: 'connect' }, variant: 'primary' }],
  })
  const reconnect = (reason: 'expired' | 'binding' | 'rejected' | 'scope') =>
    shown(server({ state: 'waiting-authorization', reason, lastError: 'x' }))
  expect(reconnect('rejected')).toMatchObject({ phase: 'disconnected', status: { zh: '需要重新连接' }, detail: 'Acme rejected the grant.' })
  expect(reconnect('scope').detail).toBe('Acme needs a permission.')
  expect(reconnect('expired').detail).toMatchObject({ zh: '授权已过期，请重新连接。' })
  expect(reconnect('binding').detail).toMatchObject({ en: 'The authorization no longer matches the current settings. Connect again.' })
  expect(reconnect('expired')).toMatchObject({ connect: { kind: 'start', operation: 'connect' }, buttons: [{ label: { en: 'Connect again' } }] })
})

it('follows a running authorization with its page and Cancel, and reports a failed one under the section', () => {
  const waiting = shown(server(missing, { id: ATTEMPT, phase: 'waiting-browser', authorizationUrl: 'https://acme.example/authorize' }))
  expect(waiting).toMatchObject({ phase: 'connecting', status: { zh: '等待你在浏览器中确认' }, detail: 'Confirm in the Acme page.' })
  expect(waiting.buttons.map(button => button.command)).toEqual([{ kind: 'open' }, { kind: 'cancel' }])
  for (const phase of ['starting', 'exchanging', 'committing'] as const) {
    expect(shown(server(missing, { id: ATTEMPT, phase }))).toMatchObject({ phase: 'connecting', detail: 'Saving the Acme grant.', buttons: [{ command: { kind: 'cancel' } }] })
  }
  expect(shown(server(missing, { id: ATTEMPT, phase: 'failed' })).failure).toMatchObject({ text: { zh: '授权未完成，请重试' } })
  expect(shown(server(missing, { id: ATTEMPT, phase: 'cancelled' })).failure).toBeUndefined()
})

it('offers Retry only where restarting the server recovers it', () => {
  const retry = [{ label: text({ en: 'Retry' }), command: { kind: 'start', operation: 'retry' } }]
  expect(shown(server({ state: 'closed', result: { closeConfirmed: true } }))).toMatchObject({ phase: 'unavailable', detail: { zh: '已保留现有授权，可以稍后重试。' } })
  expect(shown(server({ state: 'closed', result: { closeConfirmed: true } })).buttons).toEqual(retry)
  expect(shown(server({ state: 'failed', reason: 'gave-up' })).buttons).toEqual(retry)
  expect(shown(server({ state: 'failed', reason: 'load', lastError: 'x' })).buttons).toEqual(retry)
  for (const status of [
    { state: 'waiting-credentials', lastError: 'x' }, { state: 'disabled' }, { state: 'failed', reason: 'unclosed-generation' },
    { state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } },
  ] satisfies McpManagedServerStatus[]) {
    expect(labels(server(status))).toEqual([])
    expect(shown(server(status)).phase).toBe('unavailable')
  }
  expect(shown(server({ state: 'disabled' }, { id: ATTEMPT, phase: 'failed' })).failure).toBeDefined()
})

it('fills the section copy with the connector text and the shared line on where authorization completes', () => {
  expect(sectionCopy(COPY)).toEqual({
    title: 'Acme account', hint: text({ zh: '授权需要在运行 DSH 的这台电脑上的浏览器中完成。' }),
    activation: { title: 'Connect Acme?', body: 'The connector is on.', connect: 'Connect Acme' },
  })
  expect(Object.keys(sectionCopy(COPY).hint)).toEqual(['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])
})

it('publishes a running authorization as the operation and a finished one as the result', () => {
  const { manager, account } = bench()
  expect(account.snapshot()).toEqual({ account: undefined })
  manager.servers = [server(missing, { id: ATTEMPT, phase: 'waiting-browser', authorizationUrl: 'https://acme.example/authorize' })]
  expect(account.snapshot().operation).toEqual({
    id: OPERATION, kind: 'connect', phase: 'waiting-browser', cancellable: true, authorizationUrl: 'https://acme.example/authorize',
  })
  manager.servers = [server(missing, { id: ATTEMPT, phase: 'exchanging' })]
  expect(account.snapshot().operation).toEqual({ id: OPERATION, kind: 'connect', phase: 'exchanging', cancellable: true })
  for (const [phase, outcome] of [['authorized', 'succeeded'], ['cancelled', 'cancelled'], ['failed', 'failed']] as const) {
    manager.servers = [server(missing, { id: ATTEMPT, phase })]
    expect(account.snapshot()).toMatchObject({ result: { id: OPERATION, kind: 'connect', outcome } })
    expect(account.snapshot().operation).toBeUndefined()
  }
})

it('starts an authorization through the manager and answers with its attempt identity', async () => {
  const { manager, account } = bench([server(missing)])
  await expect(account.start('connect')).resolves.toBe(OPERATION)
  expect(manager.startAuthorization).toHaveBeenCalledWith('acme')
  manager.startAuthorization.mockRejectedValueOnce(new Error('mcp-manager: OAuth is not configured for this server'))
  await expect(account.start('connect')).rejects.toThrow('OAuth is not configured')
  await account.cancel(OPERATION)
  expect(manager.cancelAuthorization).toHaveBeenCalledWith('acme', ATTEMPT)
  account.refresh()
})

it('reports a finished sign-out or restart as its own result until the next authorization starts', async () => {
  const { manager, account } = bench([server(missing, { id: ATTEMPT, phase: 'authorized' })])
  const changed = vi.fn()
  const stop = account.observe(changed)
  const signedOut = await account.start('sign-out')
  expect(manager.signOut).toHaveBeenCalledWith('acme')
  expect(changed).toHaveBeenCalledOnce()
  expect(account.snapshot().result).toEqual({ id: signedOut, kind: 'sign-out', outcome: 'succeeded' })
  const restarted = await account.start('retry')
  expect(manager.restart).toHaveBeenCalledWith('acme')
  expect(account.snapshot().result).toEqual({ id: restarted, kind: 'retry', outcome: 'succeeded' })
  manager.servers = [server(missing)]
  expect(account.snapshot().result).toEqual({ id: restarted, kind: 'retry', outcome: 'succeeded' })
  await account.start('connect')
  expect(account.snapshot().result).toBeUndefined()
  manager.signOut.mockRejectedValueOnce(new Error('mcp-manager: server configuration changed before sign-out'))
  await expect(account.start('sign-out')).rejects.toThrow('configuration changed')
  expect(account.snapshot().result).toBeUndefined()
  stop()
  await account.start('retry')
  expect(changed).toHaveBeenCalledTimes(2)
})

it('observes status changes of its own server only, until the disposer runs', async () => {
  const { ctx, account } = bench()
  const changed = vi.fn()
  const stop = account.observe(changed)
  await ctx.parallel('mcp-manager/status', 'other', { state: 'disabled' })
  expect(changed).not.toHaveBeenCalled()
  await ctx.parallel('mcp-manager/status', 'acme', { state: 'disabled' })
  expect(changed).toHaveBeenCalledOnce()
  stop()
  await ctx.parallel('mcp-manager/status', 'acme', { state: 'disabled' })
  expect(changed).toHaveBeenCalledOnce()
})
