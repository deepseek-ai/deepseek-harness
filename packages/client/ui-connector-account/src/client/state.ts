/**
 * The page's one subscription to the registered accounts, and what only this browser knows about them: the operations
 * it started, whose authorization pages open here, and the notice to show.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ConnectorAccountEntry, ConnectorAccountsView, ConnectorOperationId } from '../types.ts'
import type { ConnectorAccountNotice, ConnectorAccountsState } from './types.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Open an authorization page in a new tab when it is HTTPS, or HTTP on a loopback address such as a local
 * authorization server.
 * @param url - the page an operation waits on; other values open nothing.
 */
export function openAuthorizationPage(url: string | undefined): void {
  if (url === undefined || !URL.canParse(url)) return
  const parsed = new URL(url)
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** One Host subscription per browser, shared by every account surface on the page. */
export class BrowserAccounts {
  /** The accounts, stream state, and notice every surface on the page reads. */
  readonly state: SnapshotStore<ConnectorAccountsState> = createSnapshotStore<ConnectorAccountsState>({
    accounts: new Map(), linked: true, notice: undefined,
  })

  /**
   * The operation each account's latest start in this browser returned, with the pages already opened for it. It lasts
   * until the stream delivers its result or the account leaves.
   */
  private readonly followed = new Map<string, { readonly id: ConnectorOperationId; readonly opened: Set<string> }>()
  private seq = 0
  private disposed = false
  private readonly stream: RemoteStream<ConnectorAccountsView>
  private readonly observing: Promise<void>

  /**
   * @param ctx - the browser context carrying the Remote client.
   * @param remote - the `connectorAccounts` Remote.
   */
  constructor(private readonly ctx: Context, remote: Pick<ClientRemote['connectorAccounts'], 'watch'>) {
    this.stream = ctx.remote.$stream<ConnectorAccountsView>({
      name: 'Connector accounts', open: signal => remote.watch(signal),
      ended: () => new Error('Connector accounts stream ended'),
      carrierFailed: () => { this.patch({ linked: false }) },
    })
    this.observing = this.observe()
  }

  /**
   * Follow an operation this browser started, replacing the account's previous one.
   * @param key - the account key.
   * @param id - the operation the Host started.
   */
  follow(key: string, id: ConnectorOperationId): void {
    if (this.disposed) return
    this.followed.set(key, { id, opened: new Set() })
    // The stream may have delivered the operation before the start call answered.
    const entry = this.state.getSnapshot().accounts.get(key)
    if (entry !== undefined) this.track(entry)
  }

  /** Report that a Remote call this browser made did not finish; the Host keeps the diagnostic. */
  failed(): void {
    this.notify({ kind: 'action-failed' })
  }

  /** Clear the notice once it has been shown. */
  dismissNotice(): void {
    this.patch({ notice: undefined })
  }

  /**
   * Stop observing the Host; afterwards the page opens no page and reports nothing more. Host-owned operations keep
   * running.
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
    } catch (error) {
      // A terminal failure, such as a Host without the registry, leaves the buttons disabled until the page reloads.
      if (this.disposed) return
      this.patch({ linked: false })
      this.ctx.logger.warn('connector accounts stream failed; reload the page to reconnect: %s', error)
    }
  }

  private show(entries: readonly ConnectorAccountEntry[]): void {
    const accounts = new Map(entries.map(entry => [entry.key, entry]))
    for (const key of [...this.followed.keys()]) if (!accounts.has(key)) this.followed.delete(key)
    this.patch({ accounts, linked: true })
    for (const entry of entries) this.track(entry)
  }

  /** Open each new page of the account's followed operation once, and report its success once its result arrives. */
  private track(entry: ConnectorAccountEntry): void {
    const followed = this.followed.get(entry.key)
    if (followed === undefined) return
    const url = entry.operation?.id === followed.id ? entry.operation.authorizationUrl : undefined
    if (url !== undefined && !followed.opened.has(url)) {
      followed.opened.add(url)
      openAuthorizationPage(url)
    }
    const result = entry.result
    if (result?.id !== followed.id) return
    this.followed.delete(entry.key)
    if (result.notice !== undefined) this.notify({ kind: 'succeeded', text: result.notice })
  }

  private notify(
    notice: { readonly kind: 'succeeded'; readonly text: LocalizedText } | { readonly kind: 'action-failed' },
  ): void {
    if (this.disposed) return
    this.seq += 1
    const next: ConnectorAccountNotice = { ...notice, seq: this.seq }
    this.patch({ notice: next })
  }

  private patch(change: Partial<ConnectorAccountsState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...change })
  }
}
