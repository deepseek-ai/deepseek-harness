/**
 * CLI account surfaces, Host half. CLI app plugins register their accounts with `ctx.cliAccounts`; the Plugins page
 * follows every registered account through the `cliAccounts` Remote and starts or cancels operations through it.
 * @module @deepseek-ai/dsh-client-ui-cli-account
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AnyCliAccountView, CliAccountEntry, CliAccountRegistration, CliAccountsView, CliOperationId,
} from '@deepseek-ai/dsh-cli-account/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** CLI app plugin accounts on the Plugins page. */
    cliAccounts: CliAccounts
  }
}

interface Registered {
  readonly entry: () => CliAccountEntry
  readonly refresh: () => void
  readonly start: (operation: string) => CliOperationId
  readonly cancel: (id: CliOperationId) => Promise<void>
}

function registeredOf<View extends AnyCliAccountView>(registration: CliAccountRegistration<View>): Registered {
  const { packageName, source, operations, copy, present } = registration
  return {
    entry: () => {
      const view = source.snapshot()
      const { operation, result } = view
      const notice = result?.outcome === 'succeeded' ? operations.find(candidate => candidate.kind === result.kind)?.notice : undefined
      return {
        packageName, copy, display: present(view),
        ...operation === undefined ? {} : {
          operation: {
            id: operation.id, cancellable: operation.cancellable,
            ...operation.authorizationUrl === undefined ? {} : { authorizationUrl: operation.authorizationUrl },
          },
        },
        ...result === undefined ? {} : { result: { id: result.id, outcome: result.outcome, ...notice === undefined ? {} : { notice } } },
      }
    },
    refresh: () => { source.refresh() },
    start: (operation) => {
      const kind = operations.find(candidate => candidate.kind === operation)?.kind
      if (kind === undefined) throw new Error(`cliAccounts: ${packageName} has no page operation ${operation}`)
      return source.start(kind)
    },
    cancel: id => source.cancel(id),
  }
}

/** Holds the registered accounts and serves them to the Plugins page. */
export default class CliAccounts extends TypertRemoteService {
  private readonly accounts = new Map<string, Registered>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private subscribers = 0

  /** @param ctx - the Host context the registry serves the page from. */
  constructor(ctx: Context) {
    super(ctx, 'cliAccounts')
    ctx.effect(() => () => { this.lifetime.abort(new Error('cliAccounts: registry disposed')) })
  }

  /**
   * Show one account on the Plugins page for as long as the returned disposer has not run.
   * @param registration - the bundle package, the account source, the page operations, and the presentation.
   * @returns an idempotent disposer that withdraws the account.
   * @throws when another account already uses the package.
   */
  register<View extends AnyCliAccountView>(registration: CliAccountRegistration<View>): () => void {
    const { packageName } = registration
    if (this.accounts.has(packageName)) throw new Error(`cliAccounts: ${packageName} is already registered`)
    this.accounts.set(packageName, registeredOf(registration))
    const stop = registration.source.observe(() => { this.changed() })
    // A page that already follows the accounts checks a newly registered one, as it checks each account it subscribes to.
    if (this.subscribers > 0) registration.source.refresh()
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      stop()
      this.accounts.delete(packageName)
      this.changed()
    }
  }

  /**
   * Follow every registered account; each new subscriber starts a check of each account that runs no operation.
   * @param signal - the Client's observation lifetime; disposal also ends the stream.
   * @returns the current accounts, then each changed set, coalescing changes that arrive before the next read.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<CliAccountsView> {
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
   * @param packageName - the account's bundle package.
   * @param operation - the operation kind.
   * @returns the operation identity.
   * @throws for an unknown package or operation, while another operation runs, or after the account's disposal.
   */
  @Remote
  start(packageName: string, operation: string): CliOperationId {
    return this.account(packageName).start(operation)
  }

  /**
   * Cancel one operation while its phase is cancellable, and wait for it to settle.
   * @param packageName - the account's bundle package.
   * @param id - the operation to cancel; a finished one or a phase that is not cancellable is ignored.
   * @returns after the operation settles, or at once when nothing is cancelled.
   * @throws for an unknown package.
   */
  @Remote
  cancel(packageName: string, id: CliOperationId): Promise<void> {
    return this.account(packageName).cancel(id)
  }

  private account(packageName: string): Registered {
    const account = this.accounts.get(packageName)
    if (account === undefined) throw new Error(`cliAccounts: ${packageName} is not registered`)
    return account
  }

  private changed(): void {
    for (const notify of this.listeners) notify()
  }
}
