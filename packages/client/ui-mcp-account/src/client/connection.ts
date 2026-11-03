/** Browser mirror of the registered connector accounts and the Plugins page's account actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { McpManagedServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { McpAuthorizationReason, McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { McpAccountEntry, McpAccountsView } from '../types.ts'
import type { McpAccountFace, McpAccountNotice, McpAccountSnapshot } from './types.ts'

/** What the user sees about the connection, derived from the Host entry alone. */
export type ConnectionPresentation =
  | { readonly phase: 'checking' | 'connected' | 'connecting' }
  | { readonly phase: 'waiting-browser'; readonly attempt: McpOAuthAttemptId; readonly url: string | undefined }
  | { readonly phase: 'authorizing'; readonly attempt: McpOAuthAttemptId }
  | { readonly phase: 'disconnected'; readonly failed: boolean }
  | { readonly phase: 'reconnect'; readonly reason: Exclude<McpAuthorizationReason, 'missing'>; readonly failed: boolean }
  | { readonly phase: 'unavailable'; readonly failed: boolean; readonly retryable: boolean }

function attemptPresentation(attempt: McpOAuthAttemptView): ConnectionPresentation | undefined {
  switch (attempt.phase) {
    case 'waiting-browser': return { phase: 'waiting-browser', attempt: attempt.id, url: attempt.authorizationUrl }
    case 'starting':
    case 'exchanging':
    case 'committing': return { phase: 'authorizing', attempt: attempt.id }
    case 'authorized':
    case 'cancelled':
    case 'failed': return undefined
    /* v8 ignore next -- closed attempt phase union */
    default: return assertNever(attempt.phase)
  }
}

/**
 * Derive the connection the page shows from the manager's entry for the server.
 * @param server - the entry as the manager last reported it.
 * @returns the phase, with the active attempt or the reason a new authorization is needed.
 */
export function presentConnection(server: McpManagedServerView | undefined): ConnectionPresentation {
  if (server === undefined) return { phase: 'checking' }
  const attempt = server.authorization
  const active = attempt === undefined ? undefined : attemptPresentation(attempt)
  if (active !== undefined) return active
  const failed = attempt?.phase === 'failed'
  const status = server.status
  switch (status.state) {
    case 'connected': return { phase: 'connected' }
    case 'connecting':
    case 'reconnecting': return { phase: 'connecting' }
    case 'waiting-authorization':
      return status.reason === 'missing' ? { phase: 'disconnected', failed } : { phase: 'reconnect', reason: status.reason, failed }
    case 'closed': return { phase: 'unavailable', failed, retryable: true }
    // A credential update or re-enabling the entry recovers these; a restart does not.
    case 'waiting-credentials':
    case 'disabled': return { phase: 'unavailable', failed, retryable: false }
    // Only a Host restart recovers incomplete cleanup.
    case 'failed': return { phase: 'unavailable', failed, retryable: status.reason !== 'cleanup' && status.reason !== 'unclosed-generation' }
    /* v8 ignore next -- closed managed status union */
    default: return assertNever(status)
  }
}

function openable(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
}

function openAuthorizationPage(url: string | undefined): void {
  if (url !== undefined && openable(url)) window.open(url, '_blank', 'noopener,noreferrer')
}

async function settle<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** The registry stream the mirror follows. */
export interface McpAccountsRemote {
  watch(signal: AbortSignal): AsyncIterable<McpAccountsView>
}

/** The manager's account actions the page runs. */
export interface McpServersRemote {
  startAuthorization(server: string): Promise<RemoteResult<McpOAuthAttemptView>>
  cancelAuthorization(server: string, id: McpOAuthAttemptId): Promise<RemoteResult<void>>
  signOut(server: string): Promise<RemoteResult<void>>
  restart(server: string): Promise<RemoteResult<void>>
}

/** One Host subscription per browser, shared by every account surface on the Plugins page. */
export class McpAccountsConnection {
  /** Each registered account's snapshot source by bundle package, republished when the Host adds or removes an account. */
  readonly accounts: SnapshotStore<ReadonlyMap<string, SnapshotStore<McpAccountSnapshot>>> =
    createSnapshotStore<ReadonlyMap<string, SnapshotStore<McpAccountSnapshot>>>(new Map())

  private readonly stores = new Map<string, SnapshotStore<McpAccountSnapshot>>()
  /** The attempt each account's latest connect in this browser started; only its authorization page opens here. */
  private readonly started = new Map<string, McpOAuthAttemptId>()
  private readonly opened = new Set<McpOAuthAttemptId>()
  private seq = 0
  private disposed = false
  private readonly stream: RemoteStream<McpAccountsView>
  private readonly observing: Promise<void>

  /**
   * @param ctx - the browser context carrying the Remote client.
   * @param registry - the `mcpAccounts` Remote.
   * @param servers - the manager's `mcpManager` Remote.
   */
  constructor(ctx: Context, registry: McpAccountsRemote, private readonly servers: McpServersRemote) {
    this.stream = ctx.remote.$stream<McpAccountsView>({
      name: 'MCP accounts', open: signal => registry.watch(signal),
      ended: () => new Error('MCP accounts stream ended'),
      carrierFailed: () => { this.setLinked(false) },
    })
    this.observing = this.observe()
  }

  /**
   * Bind one account's page actions; each runs without awaiting so slot handlers stay synchronous.
   * @param packageName - the account's bundle package.
   * @returns the actions a surface entry injects.
   */
  actions(packageName: string): Pick<McpAccountFace, 'connect' | 'cancel' | 'signOut' | 'retry' | 'openAuthorization' | 'dismissNotice'> {
    return {
      connect: () => { void this.connect(packageName) },
      cancel: () => { void this.cancel(packageName) },
      signOut: () => {
        void this.run(packageName, async (server) => {
          await settle(this.servers.signOut(server))
          this.notify(packageName, 'signed-out')
        })
      },
      retry: () => { void this.run(packageName, async (server) => { await settle(this.servers.restart(server)) }) },
      openAuthorization: () => {
        const shown = presentConnection(this.stores.get(packageName)?.getSnapshot().entry.view)
        if (shown.phase === 'waiting-browser') openAuthorizationPage(shown.url)
      },
      dismissNotice: () => { this.patch(packageName, { notice: undefined }) },
    }
  }

  /**
   * Stop observing the Host; afterwards the page opens no page and reports nothing more. Host-owned attempts keep running.
   * @returns after the stream closes.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stream.dispose()
    await this.observing
  }

  private async observe(): Promise<void> {
    try {
      for await (const item of this.stream) {
        // An item the stream yielded just before disposal must not reach the disposed page.
        if (this.disposed) return
        this.show(item.value.accounts)
        item.accept()
      }
    } catch {
      // The carrier already reported the failure; a disposed page has nothing left to show.
      if (!this.disposed) this.setLinked(false)
    }
  }

  private show(entries: readonly McpAccountEntry[]): void {
    const names = new Set(entries.map(entry => entry.packageName))
    let changed = false
    for (const packageName of [...this.stores.keys()]) {
      if (names.has(packageName)) continue
      this.stores.delete(packageName)
      this.started.delete(packageName)
      changed = true
    }
    for (const entry of entries) {
      const store = this.stores.get(entry.packageName)
      if (store === undefined) {
        this.stores.set(entry.packageName, createSnapshotStore<McpAccountSnapshot>({ entry, linked: true, busy: false, notice: undefined }))
        changed = true
      } else {
        store.set({ ...store.getSnapshot(), entry, linked: true })
      }
      this.follow(entry)
    }
    if (changed) this.accounts.set(new Map(this.stores))
  }

  /** Open the authorization page of the attempt this browser started once, and report its outcome. */
  private follow(entry: McpAccountEntry): void {
    const attempt = entry.view?.authorization
    if (attempt === undefined || attempt.id !== this.started.get(entry.packageName)) return
    if (attempt.phase === 'waiting-browser' && !this.opened.has(attempt.id)) {
      this.opened.add(attempt.id)
      openAuthorizationPage(attempt.authorizationUrl)
    }
    if (attempt.phase === 'authorized') this.notify(entry.packageName, 'connected')
    if (attempt.phase === 'authorized' || attempt.phase === 'cancelled' || attempt.phase === 'failed') this.started.delete(entry.packageName)
  }

  private async connect(packageName: string): Promise<void> {
    await this.run(packageName, async (server) => {
      const attempt = await settle(this.servers.startAuthorization(server))
      const current = this.stores.get(packageName)?.getSnapshot().entry
      // A disposed page or an account the Host withdrew meanwhile follows nothing.
      if (this.disposed || current === undefined) return
      this.started.set(packageName, attempt.id)
      // The stream may have reported this attempt before the call answered.
      this.follow(current)
    })
  }

  private async cancel(packageName: string): Promise<void> {
    const shown = presentConnection(this.stores.get(packageName)?.getSnapshot().entry.view)
    if (shown.phase !== 'waiting-browser' && shown.phase !== 'authorizing') return
    await this.run(packageName, async (server) => { await settle(this.servers.cancelAuthorization(server, shown.attempt)) })
  }

  private async run(packageName: string, operation: (server: string) => Promise<void>): Promise<void> {
    const snapshot = this.stores.get(packageName)?.getSnapshot()
    if (snapshot === undefined || snapshot.busy) return
    this.patch(packageName, { busy: true })
    try {
      await operation(snapshot.entry.server)
    } catch {
      // The Host keeps the diagnostic; the page reports one retryable outcome.
      this.notify(packageName, 'action-failed')
    } finally {
      this.patch(packageName, { busy: false })
    }
  }

  private setLinked(linked: boolean): void {
    for (const packageName of this.stores.keys()) this.patch(packageName, { linked })
  }

  private patch(packageName: string, change: Partial<McpAccountSnapshot>): void {
    const store = this.stores.get(packageName)
    if (store !== undefined) store.set({ ...store.getSnapshot(), ...change })
  }

  private notify(packageName: string, kind: McpAccountNotice['kind']): void {
    if (this.disposed) return
    this.seq += 1
    this.patch(packageName, { notice: { seq: this.seq, kind } })
  }
}
