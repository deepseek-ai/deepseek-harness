/**
 * MCP account surfaces, Host half. Connector plugins register their OAuth server's account with `ctx.mcpAccounts`; the
 * Plugins page follows every registered account, with the MCP manager's view of its server, through the `mcpAccounts`
 * Remote, and authorizes, cancels, signs out, and retries through the manager's own Remote.
 * @module @deepseek-ai/dsh-client-ui-mcp-account
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { McpAccountRegistration, McpAccountsView } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connector accounts on the Plugins page. */
    mcpAccounts: McpAccounts
  }
}

/** Holds the registered accounts and serves them, with their servers' manager views, to the Plugins page. */
export default class McpAccounts extends TypertRemoteService {
  static inject = ['mcpManager']

  private readonly accounts = new Map<string, McpAccountRegistration>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - the Host context carrying the MCP manager. */
  constructor(ctx: Context) {
    super(ctx, 'mcpAccounts')
    ctx.effect(() => () => { this.lifetime.abort(new Error('mcpAccounts: registry disposed')) })
  }

  /**
   * Show one account on the Plugins page for as long as the returned disposer has not run.
   * @param registration - the server name, the bundle package, and the connector's text.
   * @returns an idempotent disposer that withdraws the account.
   * @throws when another account already uses the package or the server.
   */
  register(registration: McpAccountRegistration): () => void {
    const { server, packageName } = registration
    for (const account of this.accounts.values()) {
      if (account.packageName === packageName) throw new Error(`mcpAccounts: ${packageName} is already registered`)
      if (account.server === server) throw new Error(`mcpAccounts: server ${server} is already registered`)
    }
    this.accounts.set(packageName, registration)
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.accounts.delete(packageName)
      this.changed()
    }
  }

  /**
   * Follow every registered account with the manager's view of its server.
   * @param signal - the Client's observation lifetime; disposal also ends the stream.
   * @returns the accounts once the manager lists its servers, then after each change of either, coalescing changes that
   *   arrive before the next read; ends with the manager's stream.
   * @throws what the manager's stream throws.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<McpAccountsView> {
    const stop = new AbortController()
    const ended = AbortSignal.any([signal, this.lifetime.signal, stop.signal])
    let servers: readonly McpManagedServerView[] | undefined
    let failure: { readonly error: unknown } | undefined
    let wake = Promise.withResolvers<void>()
    let dirty = true
    const notify = (): void => { dirty = true; wake.resolve() }
    this.listeners.add(notify)
    ended.addEventListener('abort', notify, { once: true })
    const following = (async () => {
      try {
        for await (const next of this.ctx.mcpManager.watch(ended)) {
          servers = next
          notify()
        }
      } catch (error) {
        failure = { error }
      } finally {
        stop.abort()
      }
    })()
    try {
      for (;;) {
        if (!dirty) await wake.promise
        if (failure !== undefined) throw failure.error
        if (ended.aborted) break
        wake = Promise.withResolvers<void>()
        dirty = false
        if (servers === undefined) continue
        const listed = servers
        yield {
          accounts: [...this.accounts.values()].map((account) => {
            const view = listed.find(server => server.name === account.server)
            return view === undefined ? account : { ...account, view }
          }),
        }
      }
    } finally {
      this.listeners.delete(notify)
      ended.removeEventListener('abort', notify)
      stop.abort()
      await following
    }
  }

  private changed(): void {
    for (const notify of this.listeners) notify()
  }
}
