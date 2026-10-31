/** Browser mirror of the registered CLI accounts and the Plugins page's account actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { CliAccountCommand, CliAccountEntry, CliAccountsView, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CliAccountFace, CliAccountNotice, CliAccountSnapshot } from './types.ts'

/** The `cliAccounts` Remote methods the mirror uses. */
export interface CliAccountsRemote {
  watch(signal: AbortSignal): AsyncIterable<CliAccountsView>
  start(packageName: string, operation: string): Promise<RemoteResult<CliOperationId>>
  cancel(packageName: string, id: CliOperationId): Promise<RemoteResult<void>>
}

function openAuthorizationPage(url: string | undefined): void {
  if (url !== undefined && URL.canParse(url) && new URL(url).protocol === 'https:') window.open(url, '_blank', 'noopener,noreferrer')
}

async function settle<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** One Host subscription per browser, shared by every account surface on the Plugins page. */
export class CliAccountsConnection {
  /** Each registered account's snapshot source by bundle package, republished when the Host adds or removes an account. */
  readonly accounts: SnapshotStore<ReadonlyMap<string, SnapshotStore<CliAccountSnapshot>>> =
    createSnapshotStore<ReadonlyMap<string, SnapshotStore<CliAccountSnapshot>>>(new Map())

  private readonly stores = new Map<string, SnapshotStore<CliAccountSnapshot>>()
  /**
   * The operation each account's latest start in this browser returned, with the links already opened for it; only its
   * links open a window here. It lasts until the stream delivers its result; each start attempt drops it first.
   */
  private readonly started = new Map<string, { readonly id: CliOperationId; readonly opened: Set<string> }>()
  private stopped = false
  private seq = 0
  private disposed = false
  private stream!: RemoteStream<CliAccountsView>
  private observing!: Promise<void>

  /**
   * @param ctx - the browser context carrying the Remote client.
   * @param remote - the `cliAccounts` Remote.
   */
  constructor(private readonly ctx: Context, private readonly remote: CliAccountsRemote) {
    this.subscribe()
  }

  /**
   * Bind one account's page actions.
   * @param packageName - the account's bundle package.
   * @returns the actions a surface entry injects.
   */
  actions(packageName: string): Pick<CliAccountFace, 'run' | 'retry' | 'dismissNotice'> {
    return {
      run: (command) => { this.run(packageName, command) },
      retry: () => { this.retry() },
      dismissNotice: () => { this.patch(packageName, { notice: undefined }) },
    }
  }

  /**
   * Stop observing the Host; afterwards the page opens no link, reports nothing more, and a pending retry opens no
   * stream. Host-owned operations keep running.
   * @returns after the stream closes.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stream.dispose()
    await this.observing
  }

  private run(packageName: string, command: CliAccountCommand): void {
    const entry = this.stores.get(packageName)?.getSnapshot().entry
    if (entry === undefined) return
    switch (command.kind) {
      case 'start':
        void this.act(packageName, async () => {
          this.started.delete(packageName)
          const id = await settle(this.remote.start(packageName, command.operation))
          if (this.disposed) return
          this.started.set(packageName, { id, opened: new Set() })
          const current = this.stores.get(packageName)?.getSnapshot().entry
          if (current !== undefined) this.follow(current)
        })
        return
      case 'cancel': {
        const operation = entry.operation
        if (operation === undefined) return
        void this.act(packageName, async () => { await settle(this.remote.cancel(packageName, operation.id)) })
        return
      }
      case 'open': openAuthorizationPage(entry.operation?.authorizationUrl); return
    }
  }

  /** Reopen the Host stream after it stopped; ignored while it runs, while a reopen is pending, or after disposal. */
  private retry(): void {
    if (this.disposed || !this.stopped) return
    // Clearing `stopped` before the reopen awaits claims it, so a second retry finds nothing to reopen.
    this.stopped = false
    for (const packageName of this.stores.keys()) this.patch(packageName, { stopped: false })
    void this.reopen()
  }

  private subscribe(): void {
    this.stream = this.ctx.remote.$stream<CliAccountsView>({
      name: 'CLI accounts', open: signal => this.remote.watch(signal),
      ended: () => new Error('CLI accounts stream ended'),
      carrierFailed: () => { this.setLinked(false) },
    })
    this.observing = this.observe(this.stream)
  }

  private async observe(stream: RemoteStream<CliAccountsView>): Promise<void> {
    try {
      for await (const item of stream) {
        // An item the stream yielded just before disposal must not reach the disposed page.
        if (this.disposed) return
        this.show(item.value.accounts)
        item.accept()
      }
    } catch {
      // A terminal failure, such as a Host without the registry, ends the stream; a disposed page shows nothing.
      if (this.disposed) return
      this.stopped = true
      this.setLinked(false)
      for (const packageName of this.stores.keys()) this.patch(packageName, { stopped: true })
    }
  }

  private async reopen(): Promise<void> {
    await this.stream.dispose()
    await this.observing
    if (!this.disposed) this.subscribe()
  }

  private show(entries: readonly CliAccountEntry[]): void {
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
        this.stores.set(entry.packageName, createSnapshotStore<CliAccountSnapshot>({
          entry, linked: true, stopped: false, busy: false, notice: undefined,
        }))
        changed = true
      } else {
        store.set({ ...store.getSnapshot(), entry, linked: true, stopped: false })
      }
      this.follow(entry)
    }
    if (changed) this.accounts.set(new Map(this.stores))
  }

  /** Open each new link of the account's followed operation once, and show the Host's notice once the entry carries its result. */
  private follow(entry: CliAccountEntry): void {
    const started = this.started.get(entry.packageName)
    if (started === undefined) return
    const url = entry.operation?.id === started.id ? entry.operation.authorizationUrl : undefined
    if (url !== undefined && !started.opened.has(url)) {
      started.opened.add(url)
      openAuthorizationPage(url)
    }
    const result = entry.result
    if (result?.id !== started.id) return
    this.started.delete(entry.packageName)
    if (result.notice !== undefined) this.notify(entry.packageName, { kind: 'succeeded', text: result.notice })
  }

  private async act(packageName: string, operation: () => Promise<void>): Promise<void> {
    if (this.stores.get(packageName)?.getSnapshot().busy !== false) return
    this.patch(packageName, { busy: true })
    try {
      await operation()
    } catch {
      // The Host keeps the diagnostic; the page reports one retryable outcome.
      this.notify(packageName, { kind: 'action-failed' })
    } finally {
      this.patch(packageName, { busy: false })
    }
  }

  private setLinked(linked: boolean): void {
    for (const packageName of this.stores.keys()) this.patch(packageName, { linked })
  }

  private patch(packageName: string, change: Partial<CliAccountSnapshot>): void {
    const store = this.stores.get(packageName)
    if (store !== undefined) store.set({ ...store.getSnapshot(), ...change })
  }

  private notify(
    packageName: string, notice: { readonly kind: 'succeeded'; readonly text: LocalizedText } | { readonly kind: 'action-failed' },
  ): void {
    if (this.disposed) return
    this.seq += 1
    const next: CliAccountNotice = { ...notice, seq: this.seq }
    this.patch(packageName, { notice: next })
  }
}
