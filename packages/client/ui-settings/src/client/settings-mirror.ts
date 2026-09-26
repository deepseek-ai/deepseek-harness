/**
 * Client mirror of the Host settings document: the one `settings.describe`
 * reader in the browser. Every settings consumer derives from this store —
 * shared entry forms through `ConfigForms.get`, cross-namespace
 * surfaces through the provider's shared describe face — so startup cost and
 * freshness are properties of this class, not of how many features own a
 * preference. The Host stays the fact source: the mirror re-reads on the
 * invalidations its owning plugin subscribes to and folds write answers in
 * through {@link SettingsDescribeMirror.acceptView}.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The full `settings.describe` answer the mirror serves. */
export interface SettingsDescribeView {
  /** Every namespace a live Host plugin registered, as the Host reported it. */
  namespaces: readonly SettingsNamespaceView[]
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Whether a native settings document exists for the Host to open. */
  hasDocument: boolean
}

/** Mirror state every derived settings surface renders from. */
export interface SettingsMirrorSnapshot {
  /**
   * `unavailable` is the terminal non-loopback state; `ready` persists across
   * later failed refreshes (the held view keeps serving); `idle` means no
   * answer is held and no read is running, so `ensure` will start one.
   */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** The last good answer; undefined until the first success. */
  view: SettingsDescribeView | undefined
  /** The latest refresh failure message, cleared by the next success. */
  error: string | null
}

/**
 * The mirror as cross-namespace surfaces consume it: current answer,
 * subscription, first-use read, and the write-answer fold. `load` stays off
 * this face — invalidation refreshes belong to the mirror's owning plugin.
 */
export interface SettingsDescribeFace {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Resolve once an answer is held (or the mirror is terminally unavailable),
   * reading only from `idle`.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void>
  /**
   * Fold one write answer's namespace view into the held view without a wire
   * read, invalidating any older read still in flight.
   * @param view - the namespace view a settings write answered with.
   */
  acceptView(view: SettingsNamespaceView): void
}

/**
 * Serializes every Host `settings.describe` read behind one snapshot store.
 * Concurrent {@link load} calls fold into the in-flight read plus one rerun,
 * so an invalidation arriving mid-read is never lost and never duplicated.
 */
export class SettingsDescribeMirror implements SettingsDescribeFace {
  private readonly store: SnapshotStore<SettingsMirrorSnapshot>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0

  /**
   * @param ctx - the providing plugin's context, whose `remote.settings`
   * namespace answers the describe read.
   * @param persistence - client-selected Host persistence; non-loopback pages may remain process-local.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {
    this.store = createSnapshotStore<SettingsMirrorSnapshot>({
      status: persistence === 'host' ? 'idle' : 'unavailable',
      view: undefined,
      error: null,
    })
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Refresh from the Host. A call during an in-flight read marks one rerun
   * after it settles instead of racing a second wire read.
   * @returns settlement after this call's freshness is reflected.
   */
  load(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    // Own the slot before the loading publication can synchronously reenter load().
    const run = Promise.resolve().then(() => this.run())
    this.inFlight = run
    return run
  }

  /**
   * Resolve once an answer is held (or the mirror is terminally unavailable),
   * reading only from `idle`. The cheap idempotent entry for surfaces that
   * render on first use.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) return this.inFlight
    if (this.getSnapshot().status === 'idle') return this.load()
    return Promise.resolve()
  }

  /**
   * Fold one write answer's namespace view into the held view without a wire
   * read, and invalidate any read still in flight. With no held document, the
   * answer is not published as a partial document; an in-flight read reruns so
   * it cannot publish a document fetched before the write committed.
   * @param view - the namespace view a settings write answered with.
   */
  acceptView(view: SettingsNamespaceView): void {
    const before = this.store.getSnapshot()
    this.generation += 1
    if (this.inFlight !== undefined) this.rerun = true
    if (before.view === undefined) return
    const namespaces = before.view.namespaces.some(row => row.ns === view.ns)
      ? before.view.namespaces.map(row => row.ns === view.ns ? view : row)
      : [...before.view.namespaces, view]
    this.store.set({ ...before, view: { ...before.view, namespaces } })
  }

  /**
   * Convenience row lookup on the held view.
   * @param ns - namespace identity.
   * @returns the namespace view, or undefined while unanswered or unregistered.
   */
  namespace(ns: string): SettingsNamespaceView | undefined {
    return this.store.getSnapshot().view?.namespaces.find(row => row.ns === ns)
  }

  private async run(): Promise<void> {
    // The in-flight slot must clear in the same synchronous segment that
    // observes `rerun` false (and on abrupt exit): a `.finally()` on the
    // returned promise runs one microtask later, and a `load()` landing in
    // that gap would mark a rerun nobody reads, losing the read.
    try {
      do {
        const before = this.store.getSnapshot()
        if (before.status === 'idle') this.store.set({ ...before, status: 'loading' })
        // Cleared immediately before the wire read goes out: a load() marked
        // earlier (including one reentering from the loading publish above)
        // is covered by this very read, while one landing after needs the
        // rerun.
        this.rerun = false
        const generation = ++this.generation
        let outcome: { view: SettingsDescribeView } | { failure: string }
        try {
          const response = await this.ctx.remote.settings.describe()
          outcome = response.ok
            ? { view: response.value }
            : { failure: response.error.message }
        } catch (error) {
          outcome = { failure: error instanceof Error ? error.message : String(error) }
        }
        // A write answer invalidates a document read before that write committed.
        if (generation !== this.generation) continue
        if ('view' in outcome) {
          this.store.set({ status: 'ready', view: outcome.view, error: null })
        } else {
          const held = this.store.getSnapshot()
          // No answer yet: fall back to idle so `ensure` retries; with one, the
          // held view keeps serving and only the error field reports the miss.
          this.store.set({
            status: held.view === undefined ? 'idle' : 'ready',
            view: held.view,
            error: outcome.failure,
          })
        }
      } while (this.shouldRerun())
    } finally {
      this.inFlight = undefined
    }
  }

  private shouldRerun(): boolean {
    return this.rerun
  }
}
