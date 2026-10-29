/** Binds change requests to the Session that created, pushed, or tracked them, and watches the bound ones. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestKey, ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { sameChangeRequestUrl } from './commands.ts'
import { BINDING_RECORD, forgeChangeRequestsProjection } from './projection.ts'
import { observeReferences } from './reference-lookup.ts'
import type { BindingState, Config, ForgeChangeRequestsState, SessionChangeRequest, SessionChangeRequestsListener } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    forgeSession: ForgeSessionService
  }
}

/** Watchers of one Session and the change request watches they share. */
interface SessionWatch {
  readonly listeners: Set<SessionChangeRequestsListener>
  /** Projection bindings that `forgeWatches` and the last notification reflect. */
  bindings: readonly BindingState[]
  readonly forgeWatches: Map<ChangeRequestKey, () => void>
}

/**
 * Session-scoped change request bindings. The `forgeChangeRequests`
 * projection derives them from `gh pr create`, `gh pr view`, `gh pr edit`,
 * `gh pr checkout`, and `git push` results and from
 * `plugin:forge-session/binding` records. After each push result, and when a
 * caller reports the branch a Session works on, the service looks up open
 * change requests whose head is that branch and records the unbound ones as
 * discovered. Watching a Session polls its visible change requests through
 * `ctx.forge`.
 */
export class ForgeSessionService extends Service {
  static inject = ['forge', 'sessions', 'sessionProjections']

  static Config: z<Config> = z.object({
    discoveryTimeoutMs: z.number().default(30_000),
  })

  private readonly home: Context
  private readonly discoveryTimeoutMs: number
  private readonly watches = new Map<Session, SessionWatch>()
  private readonly discoveries = new Set<Promise<void>>()
  private readonly sessionLifetimes = new WeakMap<Session, AbortController>()
  private readonly lifetime = new AbortController()
  private projection!: ProjectionHandle<ForgeChangeRequestsState>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'forgeSession')
    const { discoveryTimeoutMs } = config as Required<Config>
    if (!Number.isSafeInteger(discoveryTimeoutMs) || discoveryTimeoutMs <= 0 || discoveryTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`forge-session: discoveryTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    this.home = ctx
    this.discoveryTimeoutMs = discoveryTimeoutMs
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('forge-session service disposed'))
      await Promise.allSettled(this.discoveries)
    }, 'forge-session: stop discovery')
  }

  /**
   * List the change requests bound to a Session and not dismissed.
   * @param session - Session whose bindings are read.
   * @returns visible bindings in first-recorded order, each with its latest polling result.
   */
  changeRequests(session: Session): SessionChangeRequest[] {
    return this.entries(this.state(session).bindings)
  }

  /**
   * Bind a change request to a Session by URL, or restore a dismissed binding.
   * Appends a `track` record with the provider's canonical URL unless the
   * change request is already visible.
   * @param session - Session that receives the binding.
   * @param url - web URL of the change request.
   * @throws when no registered provider recognizes the URL.
   */
  track(session: Session, url: string): void {
    const ref = this.home.forge.changeRequestFromUrl(url)
    if (ref === undefined) throw new Error(`forge-session: no forge provider recognizes ${JSON.stringify(url)}`)
    const canonical = this.home.forge.changeRequestUrl(ref)
    const existing = this.state(session).bindings.find(binding => sameChangeRequestUrl(binding.url, canonical))
    if (existing === undefined || existing.dismissed) appendPluginRecord(session, BINDING_RECORD, { action: 'track', url: canonical })
  }

  /**
   * Look up open change requests whose head is a branch the Session works on,
   * and record the unbound ones as discovered, as after a push of that branch.
   * A remote that no provider recognizes changes nothing; a failed lookup is
   * logged and changes nothing.
   * @param session - Session that receives the bindings.
   * @param remote - URL of the remote that holds the branch.
   * @param branch - branch name on that remote.
   * @returns resolves once the lookup has recorded its bindings or failed.
   */
  discoverBranch(session: Session, remote: string, branch: string): Promise<void> {
    return this.discover(session, remote, branch)
  }

  /**
   * Hide a visible binding. Appends a `dismiss` record; a URL that is not
   * visibly bound leaves the log unchanged. Discovery never restores a
   * dismissed binding; `track` does.
   * @param session - Session that owns the binding.
   * @param url - web URL of the change request.
   */
  dismiss(session: Session, url: string): void {
    const existing = this.state(session).bindings.find(binding => !binding.dismissed && sameChangeRequestUrl(binding.url, url))
    if (existing !== undefined) appendPluginRecord(session, BINDING_RECORD, { action: 'dismiss', url: existing.url })
  }

  /**
   * Watch a Session's visible change requests as an effect on the calling
   * fiber. Every visible change request that a provider recognizes is polled
   * through `ctx.forge` while the Session has a watcher. Listeners receive the
   * complete list after each later binding or provider change, or polling result; read the
   * current list with {@link changeRequests}. Listeners must not throw; a
   * thrown error is logged and skipped.
   * @param session - Session to watch.
   * @param listener - receives the complete visible list.
   * @returns the disposer that stops this watch.
   */
  watch(session: Session, listener: SessionChangeRequestsListener): () => void {
    const dispose = this.ctx.effect(() => {
      let watch = this.watches.get(session)
      if (watch === undefined) {
        watch = { listeners: new Set(), bindings: this.state(session).bindings, forgeWatches: new Map() }
        this.watches.set(session, watch)
        this.sync(watch)
      }
      const owned = watch
      owned.listeners.add(listener)
      return () => {
        owned.listeners.delete(listener)
        if (owned.listeners.size > 0) return
        this.watches.delete(session)
        for (const unwatch of owned.forgeWatches.values()) unwatch()
        owned.forgeWatches.clear()
      }
    }, 'forgeSession.watch()')
    return () => void dispose()
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.home.sessionProjections.register(forgeChangeRequestsProjection)
    // Events react against the projection, so the listener starts once its reader is ready.
    this.home.on('session/event', (session: Session, event: SessionEvent) => {
      this.react(session, event)
    })
    observeReferences(this.home, this.discoveryTimeoutMs, (session, url) => {
      if (!this.state(session).bindings.some(binding => sameChangeRequestUrl(binding.url, url))) {
        appendPluginRecord(session, BINDING_RECORD, { action: 'reference', url })
      }
    })
    this.home.on('session/disposed', (session: Session) => {
      this.sessionLifetimes.get(session)?.abort(new Error('forge-session: Session was disposed'))
      this.sessionLifetimes.delete(session)
    })
    this.home.on('forge/providers-changed', () => {
      for (const [session, watch] of [...this.watches]) {
        if (this.watches.get(session) !== watch) continue
        this.sync(watch)
        this.notify(watch)
      }
    })
  }

  private state(session: Session): ForgeChangeRequestsState {
    return this.projection.stateOf(session)
  }

  private entries(bindings: readonly BindingState[]): SessionChangeRequest[] {
    const entries: SessionChangeRequest[] = []
    for (const binding of bindings) {
      if (binding.dismissed) continue
      const ref = this.home.forge.changeRequestFromUrl(binding.url) ?? null
      const update = ref === null ? null : this.home.forge.latest(ref) ?? null
      entries.push({ url: binding.url, origin: binding.origin, ref, update })
    }
    return entries
  }

  /** Discover change requests for this result's pushes and refresh watchers after binding changes. */
  private react(session: Session, event: SessionEvent): void {
    if (event.type !== 'tool/result' && pluginRecordOf(event)?.type !== BINDING_RECORD) return
    const state = this.state(session)
    for (const push of state.pushes) {
      if (push.seq === event.seq) void this.discover(session, push.remote, push.branch)
    }
    const watch = this.watches.get(session)
    if (watch === undefined || watch.bindings === state.bindings) return
    watch.bindings = state.bindings
    this.sync(watch)
    this.notify(watch)
  }

  /** Poll exactly the visible change requests that a provider recognizes. */
  private sync(watch: SessionWatch): void {
    const wanted = new Map<ChangeRequestKey, ChangeRequestRef>()
    for (const entry of this.entries(watch.bindings)) {
      if (entry.ref !== null) wanted.set(changeRequestKey(entry.ref), entry.ref)
    }
    for (const [key, unwatch] of watch.forgeWatches) {
      if (wanted.has(key)) continue
      unwatch()
      watch.forgeWatches.delete(key)
    }
    for (const [key, ref] of wanted) {
      if (!watch.forgeWatches.has(key)) watch.forgeWatches.set(key, this.home.forge.watch(ref, () => { this.notify(watch) }))
    }
  }

  private notify(watch: SessionWatch): void {
    const changeRequests = this.entries(watch.bindings)
    for (const listener of [...watch.listeners]) {
      try {
        listener(changeRequests)
      } catch (error) {
        this.home.logger.warn(`forge-session: change request listener failed: ${String(error)}`)
      }
    }
  }

  private discover(session: Session, remote: string, branch: string): Promise<void> {
    const repository = this.home.forge.repositoryFromRemote(remote)
    if (repository === undefined) return Promise.resolve()
    let lifetime = this.sessionLifetimes.get(session)
    if (lifetime === undefined) {
      lifetime = new AbortController()
      this.sessionLifetimes.set(session, lifetime)
    }
    const signal = AbortSignal.any([this.lifetime.signal, lifetime.signal])
    const task = this.lookup(session, repository, branch, signal).catch((error: unknown) => {
      if (signal.aborted) return
      this.home.logger.warn(`forge-session: change request lookup for ${branch} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.discoveries.add(task)
    void task.then(() => this.discoveries.delete(task))
    return task
  }

  private async lookup(session: Session, repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<void> {
    using timeout = deadline(signal, this.discoveryTimeoutMs, 'FORGE_DISCOVERY_TIMEOUT')
    const refs = await this.home.forge.findByHead(repository, branch, timeout.signal)
    for (const ref of refs) {
      if (signal.aborted || this.home.sessions.get(session.id) !== session) return
      const url = this.home.forge.changeRequestUrl(ref)
      if (this.state(session).bindings.some(binding => sameChangeRequestUrl(binding.url, url))) continue
      appendPluginRecord(session, BINDING_RECORD, { action: 'discover', url })
    }
  }
}

export default ForgeSessionService
