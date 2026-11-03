/** The registry serves every registered account to the Plugins page with the MCP manager's view of its server. */
import { Context } from '@deepseek-ai/cordis'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import McpAccounts from '../src/index.ts'
import type { McpAccountCopy, McpAccountRegistration, McpAccountsView } from '../src/types.ts'

const COPY: McpAccountCopy = {
  title: { en: 'Docs account', zh: 'Docs 账号' },
  connect: 'Connect Docs',
  activation: { title: 'Connect Docs', body: 'Docs is on.' },
  detail: {
    disconnected: 'Not connected.', waitingBrowser: 'Finish in the browser.', authorizing: 'Authorizing.', connecting: 'Connecting.',
    connected: 'Connected.', rejected: 'Docs rejected the grant.', scope: 'Docs needs more permissions.',
  },
  signOut: { title: 'Sign out of Docs?', body: 'Removes the grant.' },
  notice: { connected: 'Docs connected', signedOut: 'Signed out of Docs' },
}

const DOCS: McpAccountRegistration = { server: 'docs', packageName: '@acme/docs', copy: COPY }
const WIKI: McpAccountRegistration = { server: 'wiki', packageName: '@acme/wiki', copy: COPY }

function view(name: string, toolCount = 1): McpManagedServerView {
  return { name, configured: true, status: { state: 'connected', toolCount, connectedAt: 1 } }
}

/** A manager whose stream yields the lists the test publishes, until the subscriber stops it, it fails, or it ends. */
function manager() {
  const lists: McpManagedServerView[][] = []
  const signals: AbortSignal[] = []
  let wake: (() => void) | undefined
  let failure: Error | undefined
  let ended = false
  const service = {
    async *watch(signal: AbortSignal): AsyncIterable<McpManagedServerView[]> {
      signals.push(signal)
      signal.addEventListener('abort', () => { wake?.() }, { once: true })
      for (;;) {
        if (signal.aborted) return
        if (failure !== undefined) throw failure
        const next = lists.shift()
        if (next !== undefined) { yield next; continue }
        if (ended) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
  return {
    service, signals,
    list(...servers: McpManagedServerView[]) { lists.push(servers); wake?.() },
    fail(error: Error) { failure = error; wake?.() },
    end() { ended = true; wake?.() },
  }
}

async function registry(servers = manager()) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('mcpManager', servers.service)
  const fiber = ctx.plugin(McpAccounts)
  await fiber
  return { ctx, fiber, servers }
}

function watch(ctx: Context, signal = new AbortController().signal): AsyncIterator<McpAccountsView> {
  return ctx.mcpAccounts.watch(signal)[Symbol.asyncIterator]()
}

it('publishes the accounts once the manager lists its servers, then after each change of either', async () => {
  const { ctx, servers } = await registry()
  const withdraw = ctx.mcpAccounts.register(DOCS)
  const controller = new AbortController()
  const stream = watch(ctx, controller.signal)
  let read = false
  const reading = stream.next().finally(() => { read = true })
  await vi.waitFor(() => { expect(servers.signals).toHaveLength(1) })
  expect(read).toBe(false)
  servers.list(view('docs'), view('other'))
  expect((await reading).value).toEqual({ accounts: [{ ...DOCS, view: view('docs') }] })

  // An account whose server the manager does not list carries no view.
  ctx.mcpAccounts.register(WIKI)
  expect((await stream.next()).value).toEqual({ accounts: [{ ...DOCS, view: view('docs') }, WIKI] })
  servers.list(view('docs', 3), view('wiki'))
  expect((await stream.next()).value).toEqual({ accounts: [{ ...DOCS, view: view('docs', 3) }, { ...WIKI, view: view('wiki') }] })

  withdraw()
  withdraw()
  expect((await stream.next()).value).toEqual({ accounts: [{ ...WIKI, view: view('wiki') }] })
  controller.abort()
  expect((await stream.next()).done).toBe(true)
  expect(servers.signals[0]!.aborted).toBe(true)
})

it('publishes the accounts registered before the manager lists in one view', async () => {
  const { ctx, servers } = await registry()
  const stream = watch(ctx)
  const reading = stream.next()
  ctx.mcpAccounts.register(DOCS)
  ctx.mcpAccounts.register(WIKI)
  servers.list()
  expect((await reading).value).toEqual({ accounts: [DOCS, WIKI] })
})

it('refuses a second account for a package or a server', async () => {
  const { ctx } = await registry()
  ctx.mcpAccounts.register(DOCS)
  expect(() => ctx.mcpAccounts.register({ ...WIKI, packageName: DOCS.packageName })).toThrow('mcpAccounts: @acme/docs is already registered')
  expect(() => ctx.mcpAccounts.register({ ...WIKI, server: DOCS.server })).toThrow('mcpAccounts: server docs is already registered')
})

it('rethrows what the manager stream throws', async () => {
  const { ctx, servers } = await registry()
  const stream = watch(ctx)
  servers.list()
  await stream.next()
  servers.fail(new Error('manager offline'))
  await expect(stream.next()).rejects.toThrow('manager offline')
})

it('ends with the manager stream', async () => {
  const { ctx, servers } = await registry()
  const stream = watch(ctx)
  servers.list()
  await stream.next()
  servers.end()
  expect((await stream.next()).done).toBe(true)
})

it('ends every stream when the registry unloads', async () => {
  const { ctx, fiber, servers } = await registry()
  const stream = watch(ctx)
  servers.list()
  await stream.next()
  const pending = stream.next()
  await fiber.dispose()
  expect((await pending).done).toBe(true)
  expect(servers.signals[0]!.aborted).toBe(true)
})
