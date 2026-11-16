/**
 * Connector account surfaces, Host half. CLI app plugins and MCP connectors register their accounts with
 * `ctx.connectorAccounts`; the Plugins page follows every registered account through the `connectorAccounts` Remote and
 * starts or cancels operations through it, so the browser never learns how an account connects.
 * @module @deepseek-ai/dsh-client-ui-connector-account
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AnyConnectorAccountView, ConnectorAccountEntry, ConnectorAccountRegistration, ConnectorAccountsView, ConnectorOperationId,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connector accounts on the Plugins page. */
    connectorAccounts: ConnectorAccounts
  }
}

interface Registered {
  readonly packageName: string | undefined
  readonly entry: () => ConnectorAccountEntry
  readonly refresh: () => void
  readonly start: (operation: string) => ConnectorOperationId | Promise<ConnectorOperationId>
  readonly cancel: (id: ConnectorOperationId) => Promise<void>
}

function registeredOf<View extends AnyConnectorAccountView>(registration: ConnectorAccountRegistration<View>): Registered {
  const { key, packageName, source, operations, copy, present } = registration
  return {
    packageName,
    entry: () => {
      const view = source.snapshot()
      const { operation, result } = view
      const notice = result?.outcome === 'succeeded' ? operations.find(candidate => candidate.kind === result.kind)?.notice : undefined
      return {
        key, ...packageName === undefined ? {} : { packageName }, copy, display: present(view),
        ...operation === undefined ? {} : {
          operation: {
            id: operation.id, ...operation.authorizationUrl === undefined ? {} : { authorizationUrl: operation.authorizationUrl },
          },
        },
        ...result === undefined ? {} : { result: { id: result.id, ...notice === undefined ? {} : { notice } } },
      }
    },
    refresh: () => { source.refresh() },
    start: (operation) => {
      const kind = operations.find(candidate => candidate.kind === operation)?.kind
      if (kind === undefined) throw new Error(`connectorAccounts: ${key} has no page operation ${operation}`)
      return source.start(kind)
    },
    cancel: id => source.cancel(id),
  }
}

/** Holds the registered accounts and serves them to the Plugins page. */
export default class ConnectorAccounts extends TypertRemoteService {
  private readonly accounts = new Map<string, Registered>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private subscribers = 0

  /** @param ctx - the Host context the registry serves the page from. */
  constructor(ctx: Context) {
    super(ctx, 'connectorAccounts')
    ctx.effect(() => () => { this.lifetime.abort(new Error('connectorAccounts: registry disposed')) })
  }

  /**
   * Show one account on the Plugins page for as long as the returned disposer has not run.
   * @param registration - the account key, its bundle package, the account source, the page operations, and the
   *   presentation.
   * @returns an idempotent disposer that withdraws the account.
   * @throws when another account already uses the key or the package.
   */
  register<View extends AnyConnectorAccountView>(registration: ConnectorAccountRegistration<View>): () => void {
    const { key, packageName } = registration
    if (this.accounts.has(key)) throw new Error(`connectorAccounts: ${key} is already registered`)
    if (packageName !== undefined && [...this.accounts.values()].some(account => account.packageName === packageName)) {
      throw new Error(`connectorAccounts: ${packageName} already has an account`)
    }
    this.accounts.set(key, registeredOf(registration))
    const stop = registration.source.observe(() => { this.changed() })
    // A page that already follows the accounts checks a newly registered one, as it checks each account it subscribes to.
    if (this.subscribers > 0) registration.source.refresh()
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      stop()
      this.accounts.delete(key)
      this.changed()
    }
  }

  /**
   * Follow every registered account; each new subscriber starts a check of each account that runs no operation.
   * @param signal - the Client's observation lifetime; disposal also ends the stream.
   * @returns the current accounts, then each changed set, coalescing changes that arrive before the next read.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<ConnectorAccountsView> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let wake = Promise.withResolvers<void>()
    let changed = true
    const notify = (): void => { changed = true; wake.resolve() }
    this.listeners.add(notify)
    combined.addEventListener('abort', notify, { once: true })
    this.subscribers += 1
    try {
      for (const account of this.accounts.values()) account.refresh()
      for (;;) {
        if (!changed) await wake.promise
        if (combined.aborted) break
        wake = Promise.withResolvers<void>()
        changed = false
        yield { accounts: [...this.accounts.values()].map(account => account.entry()) }
      }
    } finally {
      this.subscribers -= 1
      this.listeners.delete(notify)
      combined.removeEventListener('abort', notify)
    }
  }

  /**
   * Start one of the operations the account registered as page actions.
   * @param key - the account key.
   * @param operation - the operation kind.
   * @returns the operation identity once the account's source has started it.
   * @throws for an unknown account or operation, or whatever the account's source refuses, such as a second operation.
   */
  @Remote
  async start(key: string, operation: string): Promise<ConnectorOperationId> {
    return await this.account(key).start(operation)
  }

  /**
   * Cancel one operation while its phase is cancellable, and wait for it to settle.
   * @param key - the account key.
   * @param id - the operation to cancel; a finished one or a phase that is not cancellable is ignored.
   * @returns after the operation settles, or at once when nothing is cancelled.
   * @throws for an unknown account.
   */
  @Remote
  cancel(key: string, id: ConnectorOperationId): Promise<void> {
    return this.account(key).cancel(id)
  }

  private account(key: string): Registered {
    const account = this.accounts.get(key)
    if (account === undefined) throw new Error(`connectorAccounts: ${key} is not registered`)
    return account
  }

  private changed(): void {
    for (const notify of this.listeners) notify()
  }
}
