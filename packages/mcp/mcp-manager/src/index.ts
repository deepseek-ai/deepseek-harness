/**
 * MCP server manager (`ctx.mcpManager`): one fleet of `dsh-mcp-client`
 * instances built from two sources. Volatile `Config.servers` holds configured
 * entries, which Settings exposes under the owning Loader entry id with profile
 * inheritance and revision checks; plugins contribute registered entries for
 * their own lifetime through `register()`, among them a
 * `@deepseek-ai/dsh-mcp-manager/server` row, which registers the server its
 * config declares. Every change to either source
 * reconciles the live instance set: new entries mount, removed or disabled
 * entries unmount, and a changed entry is rebuilt. Connection handling stays
 * entirely in mcp-client, which the manager reaches only through the
 * `McpClientHost` it creates: the host validates entries' client fields and
 * mounts, probes, and authorizes servers. The manager owns entry validation of
 * its own fields, instance lifecycle, the aggregated status registry, and the
 * `restart`, `probe`, and `watch` operations a management surface calls through Remote.
 *
 * Service package (default-exports the service class). All child instances
 * mount under the manager's fiber, so disposing the manager unwinds every
 * instance and its registered tools.
 *
 * @module @deepseek-ai/dsh-mcp-manager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { McpClientHost } from '@deepseek-ai/dsh-mcp-client'
import type { McpCloseResult, McpOAuthAuthorization, McpProbeOptions, McpProbeResult, McpServerInstance } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig, McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { ServerEntrySchema } from './entry.ts'
import type { McpManagedServerEntry, McpServerRegistration } from './entry.ts'
import type { McpManagedServerStatus, McpManagedServerView } from './types.ts'
// Side-effect type imports: declare the tool service and Loader's volatile events.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/cordis-plugin-loader'

export type { McpManagedServerEntry, McpServerRegistration } from './entry.ts'
export type { McpManagedServerStatus, McpManagedServerView } from './types.ts'

/** Manager configuration with live server entries. */
export interface Config {
  /** Managed servers keyed by `serverName`. */
  servers: Volatile<Record<string, McpManagedServerEntry>>
}

interface ConfigInput {
  servers?: Record<string, McpServerRegistration & Partial<Pick<McpManagedServerEntry, 'enabled'>>>
}

type ResolvedEntry = VolatileSnapshot<McpManagedServerEntry>

/** One server's child instance, probes, and any cleanup failure retained by the manager. */
interface ManagedRecord {
  oauth?: McpOAuthAuthorization
  /** Pending local grant deletion owns replacement of this record. */
  signingOut?: boolean
  /** Entry before template expansion, retained for change detection. */
  entrySnapshot: ResolvedEntry
  /** The server instance the host mounted for this entry. */
  instance?: McpServerInstance
  probes: Map<AbortController, Promise<McpProbeResult>>
  failure?: McpCloseResult
  /** Set when unmount begins: late activation callbacks must publish nothing. */
  retired?: boolean
  /** Disposer of the status-cell subscription, once attached. */
  detachStatus?: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The MCP server manager. */
    mcpManager: McpServerManager
  }
}

/**
 * The manager service. Reconciliation and `restart` serialize instance
 * replacement. Probes run independently and are cancelled before replacement
 * or disposal waits for their cleanup.
 */
export default class McpServerManager extends TypertRemoteService {
  /** Schema for {@link Config}; Settings exposes its volatile fields. */
  static Config = z.object({
    servers: z.dict(ServerEntrySchema).default({}).volatile(),
  }) as z<ConfigInput, Config>

  static inject = ['tools']

  private readonly ownerContext: Context
  /** Validates, mounts, probes, and authorizes the servers below the manager's fiber. */
  private readonly host: McpClientHost
  private readonly instances = new Map<string, ManagedRecord>()
  private readonly statuses = new Map<string, McpManagedServerStatus>()
  /** Plugin-contributed entries, each owned by its registering plugin's effect. */
  private readonly registrations = new Map<string, ResolvedEntry>()
  /** Wake callbacks of active `watch` streams. */
  private readonly watchers = new Set<() => void>()
  /** Aborted at service dispose so `watch` streams end. */
  private readonly lifetime = new AbortController()
  /** Settled operation tail serializing every lifecycle operation. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Set at service dispose: refuse new operations while queued ones drain. */
  private stopped = false

  /**
   * Validate the resolved server configuration.
   * @param ctx - the manager's plugin context; children mount under its fiber.
   * @param config - resolved manager configuration with live references.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'mcpManager')
    this.ownerContext = ctx
    this.host = new McpClientHost(ctx)
    this.validateEntries(config.servers.get())
  }

  /**
   * Validate Config updates and reconcile the initial server set. Teardown
   * cancels probes and unmounts every instance, retaining cleanup failures in
   * the readable status registry.
   */
  * [Service.init](): Generator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.stop()
      // The tail never rejects: every enqueue swallows its own settlement.
      await this.tail
      for (const [name, record] of [...this.instances]) await this.unmount(name, record)
    }
    const owner = this.ctx.fiber
    const registrations = this.registrations
    this.ctx.on('internal/config', (fiber, next) => {
      const raw: unknown = next()
      if (fiber !== owner) return raw
      const servers = McpServerManager.Config(raw as ConfigInput).servers.get()
      const taken = Object.keys(servers).find(name => registrations.has(name))
      if (taken !== undefined) throw new Error(`servers.${taken}: a plugin already registers this server name — rename the entry key`)
      this.validateEntries({ ...servers, ...Object.fromEntries(registrations) })
      return raw
    })
    this.ctx.on('internal/plugin', (fiber) => {
      if (fiber === owner && fiber.uid === null) this.stop()
    }, { global: true })
    this.ctx.on('loader/volatile-update', () => { void this.entriesChanged('config reconcile') })
    // The service is visible to dependents only once this fiber is ACTIVE, so
    // the first reconcile waits for activation instead of racing it.
    void this.ctx.fiber.await().then(
      () => {
        void this.schedule(() => this.reconcileOnce(), 'initial reconcile')
      },
      /* v8 ignore next 2 -- init is this fiber's whole startup and this registration is its
         last statement, so a rejected activation cannot reach a registered continuation */
      () => undefined,
    )
  }

  /**
   * Read configured and registered servers and retained runtime records without mounting or probing.
   * @returns configured entries in document order, then registered entries, then retained records for removed entries.
   */
  list(): McpManagedServerView[] {
    const entries = this.entries()
    return [...new Set([...Object.keys(entries), ...this.instances.keys()])].map((name) => {
      const authorization = this.instances.get(name)?.oauth?.current()
      return {
        name,
        configured: Object.hasOwn(entries, name),
        status: this.currentStatus(name, entries),
        ...authorization === undefined ? {} : { authorization },
      }
    })
  }

  /**
   * Contribute one server for the calling plugin's lifetime. A registered
   * entry is enabled while registered; its removal awaits the instance's
   * unmount, so plugin disposal withdraws the server's tools before settling.
   * @param name - server key and tool namespace, unique across configured and registered servers.
   * @param entry - transport, endpoint, and budgets, validated like a configured entry.
   * @returns an idempotent disposer that removes the registration.
   * @throws when the name is taken, the entry is invalid, or the manager is disposed.
   */
  register(name: string, entry: McpServerRegistration): () => void {
    const resolved = ServerEntrySchema({ ...entry, enabled: true })
    const dispose = this.ctx.effect(() => {
      if (this.stopped) throw new Error('mcp-manager: the manager is disposed')
      if (Object.hasOwn(this.config.servers.get(), name) || this.registrations.has(name)) {
        throw new Error(`mcp-manager: server "${name}" is already configured or registered`)
      }
      this.validateEntries({ ...this.entries(), [name]: resolved })
      this.registrations.set(name, resolved)
      void this.entriesChanged(`registration of "${name}"`)
      return () => {
        this.registrations.delete(name)
        // A stopping manager unmounts every instance itself.
        if (!this.stopped) return this.entriesChanged(`removal of "${name}"`)
      }
    }, 'mcpManager.register()')
    return () => void dispose()
  }

  /**
   * Stream server views for a management surface: the current list on
   * subscription, then the complete list again after each status or entry change.
   * @param signal - subscription lifetime; aborting ends only this stream.
   * @returns coalesced server lists until the subscriber or the manager stops.
   */
  @Remote({ mode: 'stream' })
  async* watch(signal: AbortSignal): AsyncIterable<McpManagedServerView[]> {
    const ended = AbortSignal.any([signal, this.lifetime.signal])
    // Read through a call: the flag changes while the stream awaits.
    const aborted = (): boolean => ended.aborted
    let wake = Promise.withResolvers<void>()
    let dirty = true
    const notify = (): void => {
      dirty = true
      wake.resolve()
    }
    this.watchers.add(notify)
    ended.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!dirty) await wake.promise
        if (aborted()) break
        dirty = false
        wake = Promise.withResolvers<void>()
        yield this.list()
      }
    } finally {
      this.watchers.delete(notify)
      ended.removeEventListener('abort', notify)
    }
  }

  /**
   * Wait until no listed server is in the first attempt of a connection: `list()` reports none as `connecting` with
   * `attempt: 0`. Every later state counts, including failures, reconnect attempts, and waiting for credentials or
   * authorization. Servers that join while the wait runs are included. Host callers only; this is not a Remote method.
   * @param signal - ends the wait before every server leaves its first attempt.
   * @returns the names still in their first attempt when the signal or manager disposal ended the wait; empty once settled.
   */
  async whenSettled(signal: AbortSignal): Promise<string[]> {
    const firstAttempts = (servers: readonly McpManagedServerView[]): string[] => servers
      .filter(({ status }) => status.state === 'connecting' && status.attempt === 0)
      .map(({ name }) => name)
    let pending = firstAttempts(this.list())
    for await (const servers of this.watch(signal)) {
      pending = firstAttempts(servers)
      if (pending.length === 0) break
    }
    return pending
  }

  /**
   * Rebuild one server from its current entry: dispose the live instance (if
   * any) and mount a fresh one with a fresh reconnect budget. Incomplete
   * cleanup blocks replacement until the Host restarts.
   * @param name - the configured or registered server key.
   * @throws when the manager is disposed, no such entry exists, or cleanup is incomplete.
   */
  @Remote
  async restart(name: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.entries()[name] === undefined) {
        throw new Error(`mcp-manager: unknown server "${name}" — it is neither configured nor registered`)
      }
      await this.remount(name)
    })
  }

  /**
   * Probe one server for a management surface; see {@link McpServerManager.probe}.
   * @param name - the configured or registered server key.
   * @param signal - caller cancellation.
   * @returns the stage-classified probe outcome and independent cleanup result.
   */
  @Remote('probe')
  probeFromClient(name: string, signal: AbortSignal): Promise<McpProbeResult> {
    return this.probe(name, { signal })
  }

  /**
   * Probe one configured server without touching its live instance: resolve
   * the entry's templates, connect, list tools, close. A disabled entry can be
   * probed — that is how a management surface tests it before enabling.
   * Configuration changes and manager disposal cancel the probe.
   * @param name - the configured or registered server key.
   * @param options - probe budget, listing caps, and abort signal.
   * @returns the stage-classified probe outcome and independent cleanup result.
   * @throws when the manager is disposed, the entry is absent or changing, cleanup is
   * incomplete, options are invalid, or a required credentials provider is missing.
   */
  async probe(name: string, options?: McpProbeOptions): Promise<McpProbeResult> {
    const record = this.recordFor(name)
    const entry = record.entrySnapshot
    const lifetime = new AbortController()
    const owner = record
    const signal = options?.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, options.signal])
    const done = this.host.probe(this.clientConfig(name, entry), { ...options, signal }).then((result) => {
      const closure = { closeConfirmed: result.closeConfirmed,
        ...result.cleanupError === undefined ? {} : { cleanupError: result.cleanupError } }
      if (!closure.closeConfirmed || closure.cleanupError !== undefined) {
        this.setStatus(name, { state: 'failed', reason: 'cleanup', result: this.retainCleanupFailure(owner, closure) })
      }
      return result
    }).finally(() => { owner.probes.delete(lifetime) })
    owner.probes.set(lifetime, done)
    return done
  }

  /**
   * Start explicit OAuth authorization, retaining the active grant until a successful commit.
   * @param name - configured or registered OAuth entry, including disabled entries.
   * @returns current attempt progress; absent services, changing entries, or failed cleanup reject.
   */
  async startAuthorization(name: string): Promise<McpOAuthAttemptView> {
    return this.authorizationFor(name).start()
  }

  /**
   * Cancel the selected attempt and drain its work; an admitted credential commit completes.
   * @param name - managed entry.
   * @param id - selected attempt; stale or absent attempts are ignored.
   */
  async cancelAuthorization(name: string, id: McpOAuthAttemptId): Promise<void> {
    await this.instances.get(name)?.oauth?.cancel(id)
  }

  /**
   * Drain authorization, probes, and connections before deleting the local grant; retain client registration.
   * A configuration change before deletion preserves the grant and rejects.
   * @param name - configured or registered OAuth entry; cleanup failure preserves the grant and blocks replacement.
   */
  async signOut(name: string): Promise<void> {
    const record = this.recordFor(name)
    const oauth = record.entrySnapshot.oauth
    if (oauth === undefined) throw new Error('mcp-manager: OAuth is not configured for this server')
    const credentials = this.ownerContext.get('credentials')
    if (credentials === undefined) throw new Error('mcp-manager: OAuth requires a credentials provider')
    const key = parseCredentialKey(oauth.credentialKey)
    // Validation keeps credential keys unique, so only the unchanged entry owns the key. A rename while
    // cleanup is awaited can hand the key to another entry, so deletion checks again after cleanup.
    const assertUnchanged = (): void => {
      if (this.instances.get(name) !== record || !deepEqualJson(this.entries()[name], record.entrySnapshot)) {
        throw new Error('mcp-manager: server configuration changed before sign-out')
      }
    }
    record.signingOut = true
    this.retire(record)
    await this.enqueue(async () => {
      assertUnchanged()
      const closed = await this.closeRecord(name, record)
      if (!closed) throw new Error('mcp-manager: sign-out requires completed connection and authorization cleanup')
      assertUnchanged()
      try { await credentials.deleteRecord(key) }
      finally {
        this.instances.delete(name)
        await this.remount(name)
      }
    }).finally(() => { record.signingOut = false })
  }

  private authorizationFor(name: string): McpOAuthAuthorization {
    const record = this.recordFor(name)
    const config = this.clientConfig(name, record.entrySnapshot)
    if (config.transport !== 'streamable-http' || config.oauth === undefined) throw new Error('mcp-manager: OAuth is not configured for this server')
    return record.oauth ??= this.host.authorization({ ...config, oauth: config.oauth }, () => {
      this.notifyStatus(name, this.currentStatus(name))
    })
  }

  private recordFor(name: string): ManagedRecord {
    if (this.stopped) throw new Error('mcp-manager: the manager is disposed')
    const entry = this.entries()[name]
    if (entry === undefined) throw new Error(`mcp-manager: unknown server "${name}"`)
    let record = this.instances.get(name)
    if (record === undefined) {
      record = { entrySnapshot: entry, probes: new Map() }
      this.instances.set(name, record)
    }
    if (record.retired || !deepEqualJson(entry, record.entrySnapshot)) throw new Error(`mcp-manager: configuration for "${name}" is changing`)
    if (record.failure !== undefined) throw new Error(`mcp-manager: cleanup for "${name}" is incomplete; restart the Host`)
    return record
  }

  private retire(record: ManagedRecord): void {
    record.retired = true
    record.detachStatus?.()
    record.oauth?.retire()
    for (const lifetime of record.probes.keys()) lifetime.abort()
  }

  private stop(): void {
    this.stopped = true
    this.lifetime.abort()
    for (const record of this.instances.values()) this.retire(record)
  }

  /** Configured entries in document order, followed by registered entries. */
  private entries(): Readonly<Record<string, ResolvedEntry>> {
    return { ...this.config.servers.get(), ...Object.fromEntries(this.registrations) }
  }

  /** Retire records whose entry changed or disappeared, then queue reconciliation. */
  private entriesChanged(what: string): Promise<void> {
    const entries = this.entries()
    for (const [name, record] of this.instances) {
      if (!deepEqualJson(record.entrySnapshot, entries[name])) this.retire(record)
    }
    this.changed()
    return this.schedule(() => this.reconcileOnce(), what)
  }

  /** Wake every `watch` stream. */
  private changed(): void {
    for (const notify of this.watchers) notify()
  }

  /** Queue one lifecycle operation on the serialized tail and contain its failure. */
  private schedule(op: () => Promise<void>, what: string): Promise<void> {
    return this.enqueue(op).catch((error: unknown) => {
      this.ctx.logger.error(`mcp-manager: ${what} failed`)
      this.ctx.logger.error(error)
    })
  }

  /** Serialize one operation behind every queued predecessor. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.stopped) {
        throw new Error('mcp-manager: the manager is disposed')
      }
      return op()
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Reconcile the live instance set against the current entries. */
  private async reconcileOnce(): Promise<void> {
    const servers = this.entries()
    for (const [name, record] of this.instances) {
      const entry = servers[name]
      if ((!record.retired || record.signingOut) && entry !== undefined && deepEqualJson(entry, record.entrySnapshot)) continue
      await this.unmount(name, record)
    }
    for (const name of this.statuses.keys()) {
      if (servers[name] === undefined && !this.instances.has(name)) this.statuses.delete(name)
    }
    this.changed()
    for (const [name, entry] of Object.entries(servers)) {
      const record = this.instances.get(name)
      if (record?.retired || record?.failure !== undefined) continue
      if (!entry.enabled) {
        this.setStatus(name, { state: 'disabled' })
        continue
      }
      if (record?.instance !== undefined) continue
      this.mount(name, entry, record)
    }
  }

  private async remount(name: string): Promise<void> {
    const record = this.instances.get(name)
    if (record?.signingOut) {
      if (!await this.closeRecord(name, record)) throw new Error(`mcp-manager: cleanup for "${name}" is incomplete; restart the Host`)
      return
    }
    if (record !== undefined && !await this.unmount(name, record)) {
      throw new Error(`mcp-manager: cleanup for "${name}" is incomplete; restart the Host`)
    }
    const entry = this.entries()[name]
    if (entry === undefined || this.stopped) return
    if (!entry.enabled) {
      this.setStatus(name, { state: 'disabled' })
      return
    }
    this.mount(name, entry)
  }

  private mount(name: string, entry: ResolvedEntry, existing?: ManagedRecord): void {
    if (this.stopped || !deepEqualJson(this.entries()[name], entry)) return
    const record: ManagedRecord = existing ?? { entrySnapshot: entry, probes: new Map() }
    this.instances.set(name, record)
    this.setStatus(name, { state: 'connecting', attempt: 0 })
    const instance = record.instance = this.host.mount(this.clientConfig(name, entry))
    void instance.ready.then((cell) => {
      if (record.retired) return
      const publish = (): void => {
        if (record.retired) return
        const status = cell.current()
        if (status.state === 'failed' && status.reason === 'unclosed-generation') {
          const hadFailure = record.failure !== undefined
          const result = this.retainCleanupFailure(record, cell.closure())
          this.setStatus(name, hadFailure ? { state: 'failed', reason: 'cleanup', result } : status)
        } else if (record.failure === undefined) this.setStatus(name, status)
      }
      record.detachStatus = cell.onChange(publish)
      publish()
    }).catch((error: unknown) => {
      if (record.retired || this.stopped) return
      void this.schedule(async () => {
        if (record.retired) return
        if (await this.unmount(name, record)) this.setStatus(name, { state: 'failed', reason: 'load', lastError: String(error) })
      }, `failed startup of "${name}"`)
    })
  }

  private async unmount(name: string, record: ManagedRecord): Promise<boolean> {
    if (!await this.closeRecord(name, record)) return false
    this.instances.delete(name)
    return true
  }

  private async closeRecord(name: string, record: ManagedRecord): Promise<boolean> {
    this.retire(record)
    const [closure] = await Promise.all([
      record.instance?.dispose(),
      record.oauth?.dispose().then((result) => {
        if (result.cleanupError !== undefined) this.retainCleanupFailure(record, result)
      }),
      Promise.allSettled([...record.probes.values()]),
    ])
    if (closure !== undefined && (!closure.closeConfirmed || closure.cleanupError !== undefined)) this.retainCleanupFailure(record, closure)
    if (record.failure !== undefined) {
      this.setStatus(name, { state: 'failed', reason: 'cleanup', result: record.failure })
      return false
    }
    if (record.oauth?.current() !== undefined) {
      delete record.oauth
      this.notifyStatus(name, this.currentStatus(name))
    }
    return true
  }

  /** Retain the first cleanup diagnostic and every unconfirmed transport closure. */
  private retainCleanupFailure(record: ManagedRecord, result: McpCloseResult): McpCloseResult {
    return record.failure = { ...result, ...record.failure,
      closeConfirmed: result.closeConfirmed && record.failure?.closeConfirmed !== false }
  }

  /**
   * Publish changed statuses for configured or registered entries and retained runtime records.
   * Removed entries with incomplete cleanup remain observable; disposed managers
   * retain the final status without emitting events.
   */
  private setStatus(name: string, status: McpManagedServerStatus): void {
    // A lifecycle operation that entered before disposal may still be
    // finishing while the service is torn down; nothing may emit for a
    // manager that is no longer live.
    if (this.entries()[name] === undefined && !this.instances.has(name)) return
    const previous = this.statuses.get(name)
    if (previous !== undefined && deepEqualJson(previous, status)) return
    this.statuses.set(name, status)
    this.notifyStatus(name, status)
  }

  private currentStatus(name: string, entries = this.entries()): McpManagedServerStatus {
    return this.statuses.get(name)
      ?? (entries[name]?.enabled ? { state: 'connecting', attempt: 0 } : { state: 'disabled' })
  }

  /** Wake `watch` streams and emit `mcp-manager/status` while the manager is live. */
  private notifyStatus(name: string, status: McpManagedServerStatus): void {
    if (this.stopped) return
    this.changed()
    void this.ctx.parallel('mcp-manager/status', name, status).catch((error: unknown) => {
      this.ctx.logger.error(`mcp-manager: a mcp-manager/status listener failed for "${name}"`)
      this.ctx.logger.error(error)
    })
  }

  /**
   * Reject entries the manager could not act on: an OAuth credential key that is
   * malformed or that another entry already owns, OAuth on stdio, a missing or
   * cross-transport field, and whatever the MCP client host refuses in the
   * entry's client configuration, such as an invalid entry key, a malformed
   * template token, or an invalid reconnect policy. Runs at composition load, at
   * every settings write, and at registration, so a broken entry is refused where
   * it is written instead of silently disabling its server.
   * @param entries - resolved entries keyed by server name.
   */
  private validateEntries(entries: Readonly<Record<string, ResolvedEntry>>): void {
    const oauthKeys = new Set<string>()
    for (const [name, entry] of Object.entries(entries)) {
      const path = `servers.${name}`
      this.clientConfig(name, entry)
      if (entry.oauth !== undefined) {
        if (entry.transport !== 'streamable-http') throw new Error(path + ': OAuth requires streamable-http')
        try { parseCredentialKey(entry.oauth.credentialKey) }
        catch (error) { throw new Error(`${path}.oauth.credentialKey: ${(error as TypeError).message}`, { cause: error }) }
        if (oauthKeys.has(entry.oauth.credentialKey)) throw new Error(path + ': OAuth credentialKey is already assigned to another server')
        oauthKeys.add(entry.oauth.credentialKey)
      }
      if (entry.transport === 'stdio') {
        if (entry.command === '') {
          throw new Error(`${path}: a stdio server requires "command"`)
        }
        if (entry.url !== '') {
          throw new Error(`${path}: "url" is not a stdio field — remove it or set transport: streamable-http`)
        }
        if (Object.keys(entry.headers).length > 0) {
          throw new Error(`${path}: "headers" is not a stdio field — remove it or set transport: streamable-http`)
        }
      } else {
        if (entry.url === '') {
          throw new Error(`${path}: a streamable-http server requires "url"`)
        }
        if (entry.command !== '') {
          throw new Error(`${path}: "command" is not a streamable-http field — remove it or set transport: stdio`)
        }
        if (entry.args.length > 0) {
          throw new Error(`${path}: "args" is not a streamable-http field — remove it or set transport: stdio`)
        }
        if (Object.keys(entry.env).length > 0) {
          throw new Error(`${path}: "env" is not a streamable-http field — remove it or set transport: stdio`)
        }
        if (entry.cwd !== '') {
          throw new Error(`${path}: "cwd" is not a streamable-http field — remove it or set transport: stdio`)
        }
      }
    }
  }

  /**
   * Resolve an entry's client configuration through the MCP client host while
   * retaining template strings for runtime expansion. Non-strict startup exposes
   * connection failures through status; the manager schema supplies its startup budget.
   */
  private clientConfig(name: string, entry: ResolvedEntry): McpClientConfig {
    const shared = {
      serverName: name,
      failOnStartupError: false as const,
      expandTemplates: true,
      ...entry.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: entry.closeTimeoutMs },
      ...entry.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: entry.toolCallTimeoutMs },
      startupTimeoutMs: entry.startupTimeoutMs,
      ...entry.reconnect === undefined ? {} : { reconnect: entry.reconnect },
      toolLoading: entry.toolLoading,
    }
    const path = ['servers', name]
    if (entry.transport === 'stdio') {
      return this.host.validate({
        transport: 'stdio',
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
        cwd: entry.cwd,
        ...shared,
      }, path)
    }
    return this.host.validate({
      transport: 'streamable-http',
      ...entry.oauth === undefined ? {} : { oauth: { ...entry.oauth } },
      url: entry.url,
      headers: { ...entry.headers },
      ...shared,
    }, path)
  }
}
