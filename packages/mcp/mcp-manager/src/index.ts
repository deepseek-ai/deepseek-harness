/**
 * MCP server manager (`ctx.mcpServers`): one Config-driven fleet of
 * `dsh-mcp-client` instances. Volatile `Config.servers` supplies the resolved
 * server set. Settings exposes it under the owning Loader entry id, with
 * profile inheritance and revision checks. Every committed configuration change
 * reconciles the live instance set: new entries mount, removed or disabled
 * entries unmount, and a changed entry is rebuilt. Connection handling stays
 * entirely in mcp-client; the manager owns configuration validation, instance
 * lifecycle, the aggregated status registry, and the manual `restart` and
 * `probe` operations a management surface needs.
 *
 * Service package (default-exports the service class). All child instances
 * mount under the manager's fiber, so disposing the manager unwinds every
 * instance and its registered tools.
 *
 * @module @deepseek-ai/dsh-mcp-manager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber, Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { ReconnectSchema, SERVER_NAME_PATTERN, connectionStatusOf, probeServer, resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { McpCloseResult, McpProbeOptions, McpProbeResult, ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { assertTemplateSyntax } from '@deepseek-ai/dsh-mcp-client'
import type { McpManagedServerStatus, McpManagedServerView } from './types.ts'
// Side-effect type imports: declare the tool service and Loader's volatile events.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/cordis-plugin-loader'

export type { McpManagedServerStatus, McpManagedServerView } from './types.ts'

/**
 * One managed server entry. Deliberately flat rather than a per-transport
 * union: {@link validateServers} owns the per-transport field rules, and its
 * write-time refusals name the offending field where a union's shape error
 * would not.
 */
export interface McpManagedServerEntry {
  /** Which transport the instance uses. */
  transport: 'stdio' | 'streamable-http'
  /** stdio: executable used to start the server; `''` while unset. */
  command: string
  /** stdio: arguments passed without shell interpolation. */
  args: string[]
  /** stdio: extra child environment; values may use `${env:…}` / `${credential:…}` templates. */
  env: Record<string, string>
  /** stdio: working directory for the child process. */
  cwd: string
  /** streamable-http: MCP endpoint URL; `''` while unset. */
  url: string
  /** streamable-http: extra request headers; values may use templates. */
  headers: Record<string, string>
  /** Durable intent: whether the entry asks for a running instance. */
  enabled: boolean
  /** Per-tool-call timeout override in milliseconds; omission uses the mcp-client default. */
  toolCallTimeoutMs?: number
  /** Per-attempt startup budget in milliseconds; the manager schema defaults to 30000. */
  startupTimeoutMs: number
  /** Health-check spacing override in milliseconds; omission uses the mcp-client default. */
  healthCheckIntervalMs?: number
  /** Per-health-check timeout override in milliseconds; omission uses the mcp-client default. */
  healthCheckTimeoutMs?: number
  /** Cleanup budget override in milliseconds; omission uses the mcp-client default. */
  closeTimeoutMs?: number
  /** Reconnect policy; the schema fills the mcp-client defaults. */
  reconnect: ReconnectConfig
}

/** Manager configuration with live server entries. */
export interface Config {
  /** Managed servers keyed by `serverName`. */
  servers: Volatile<Record<string, McpManagedServerEntry>>
}

type EntryInput = Omit<McpManagedServerEntry, 'command' | 'url' | 'args' | 'env' | 'cwd' | 'headers' | 'enabled' | 'reconnect' | 'startupTimeoutMs'>
  & Partial<Pick<McpManagedServerEntry, 'command' | 'url' | 'args' | 'env' | 'cwd' | 'headers' | 'enabled' | 'reconnect' | 'startupTimeoutMs'>>
interface ConfigInput {
  servers?: Record<string, EntryInput>
}

const ServerEntrySchema = z.object({
  transport: z.union(['stdio', 'streamable-http']).required(),
  command: z.string().default(''),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  url: z.string().default(''),
  headers: z.dict(String).default({}),
  enabled: z.boolean().default(true),
  toolCallTimeoutMs: z.number(),
  startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  healthCheckIntervalMs: z.union([z.const(0), z.number().min(1_000).max(MAX_TIMER_DELAY_MS)]),
  healthCheckTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  reconnect: ReconnectSchema,
})


/** Fields of one entry that may carry template tokens, with their config paths. */
function templatedStrings(name: string, entry: VolatileSnapshot<McpManagedServerEntry>): Array<[value: string, where: string]> {
  const path = `servers.${name}`
  if (entry.transport === 'stdio') {
    return [
      [entry.command, `${path}.command`],
      ...entry.args.map((arg, index): [string, string] => [arg, `${path}.args[${String(index)}]`]),
      ...Object.entries(entry.env).map(([key, value]): [string, string] => [value, `${path}.env.${key}`]),
      [entry.cwd, `${path}.cwd`],
    ]
  }
  return [
    [entry.url, `${path}.url`],
    ...Object.entries(entry.headers).map(([key, value]): [string, string] => [value, `${path}.headers.${key}`]),
  ]
}

/**
 * Reject a server set the manager could not act on: an invalid entry key, a
 * missing or cross-transport field, or a malformed template token. Runs at
 * composition load for the entry config and at every settings write for the
 * user layer, so a broken entry is refused where it is written instead of
 * silently disabling its server.
 * @param config - the resolved manager configuration.
 */
function validateServers(config: Config): void {
  for (const [name, entry] of Object.entries(config.servers.get())) {
    const path = `servers.${name}`
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`${path}: server name must match ${String(SERVER_NAME_PATTERN)} — rename the entry key`)
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
    for (const [value, where] of templatedStrings(name, entry)) assertTemplateSyntax(value, where)
    // The same cross-field reconnect rules the instance would apply at mount
    // (initialDelayMs <= maxDelayMs, bounds), judged where the entry is written.
    resolveReconnectPolicy(entry.reconnect, `${path}.reconnect`)
  }
}

/** One server's child instance, probes, and any cleanup failure retained by the manager. */
interface ManagedRecord {
  /** Entry before template expansion, retained for change detection. */
  entrySnapshot: VolatileSnapshot<McpManagedServerEntry>
  /** The child mcp-client fiber. */
  handle?: Fiber
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
    mcpServers: McpServerManager
  }
}

/**
 * The manager service. Configuration reconciliation and `restart` serialize
 * instance replacement. Probes run independently and are cancelled before
 * replacement or disposal waits for their cleanup.
 */
export default class McpServerManager extends Service {
  /** Schema for {@link Config}; Settings exposes its volatile fields. */
  static Config = z.object({
    servers: z.dict(ServerEntrySchema).default({}).volatile(),
  }) as z<ConfigInput, Config>

  static inject = ['tools']

  private readonly ownerContext: Context
  private readonly instances = new Map<string, ManagedRecord>()
  private readonly statuses = new Map<string, McpManagedServerStatus>()
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
    super(ctx, 'mcpServers')
    this.ownerContext = ctx
    validateServers(config)
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
    this.ctx.on('internal/config', function (this: Fiber, _raw, next) {
      const raw: unknown = next()
      if (this === owner) validateServers(McpServerManager.Config(raw as ConfigInput))
      return raw
    })
    this.ctx.on('internal/plugin', (fiber) => {
      if (fiber === owner && fiber.uid === null) this.stop()
    }, { global: true })
    this.ctx.on('loader/volatile-update', () => {
      for (const [name, record] of this.instances) {
        if (!deepEqualJson(record.entrySnapshot, this.config.servers.get()[name])) this.retire(record)
      }
      this.schedule(() => this.reconcileOnce(), 'config reconcile')
    })
    // The service is visible to dependents only once this fiber is ACTIVE, and
    // the status event asserts a reachable manager, so the first reconcile
    // waits for activation instead of racing it.
    void this.ctx.fiber.await().then(
      () => {
        this.schedule(() => this.reconcileOnce(), 'initial reconcile')
      },
      /* v8 ignore next 2 -- init is this fiber's whole startup and this registration is its
         last statement, so a rejected activation cannot reach a registered continuation */
      () => undefined,
    )
  }

  /**
   * Read configured servers and retained runtime records without mounting or probing.
   * @returns configured entries in document order, followed by retained records for removed entries.
   */
  list(): McpManagedServerView[] {
    const servers = this.config.servers.get()
    return [...new Set([...Object.keys(servers), ...this.instances.keys()])].map(name => ({
      name,
      configured: Object.hasOwn(servers, name),
      status: this.statuses.get(name)
        ?? (servers[name]?.enabled ? { state: 'connecting', attempt: 0 } : { state: 'disabled' }),
    }))
  }

  /**
   * Rebuild one server from its current configuration: dispose the live
   * instance (if any) and mount a fresh one with a fresh reconnect budget.
   * Incomplete cleanup blocks replacement until the Host restarts.
   * @param name - the configured entry key.
   * @throws when the manager is disposed, no entry is configured, or cleanup is incomplete.
   */
  async restart(name: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.config.servers.get()[name] === undefined) {
        throw new Error(`mcp-manager: unknown server "${name}" — it is not configured under servers`)
      }
      await this.remount(name)
    })
  }

  /**
   * Probe one configured server without touching its live instance: resolve
   * the entry's templates, connect, list tools, close. A disabled entry can be
   * probed — that is how a management surface tests it before enabling.
   * Configuration changes and manager disposal cancel the probe.
   * @param name - the configured entry key.
   * @param options - probe budget, listing caps, and abort signal.
   * @returns the stage-classified probe outcome and independent cleanup result.
   * @throws when the manager is disposed, the entry is absent or changing, cleanup is
   * incomplete, options are invalid, or a required credentials provider is missing.
   */
  async probe(name: string, options?: McpProbeOptions): Promise<McpProbeResult> {
    if (this.stopped) throw new Error('mcp-manager: the manager is disposed')
    const entry = this.config.servers.get()[name]
    if (entry === undefined) throw new Error(`mcp-manager: unknown server "${name}"`)
    let record = this.instances.get(name)
    if (record === undefined) {
      record = { entrySnapshot: structuredClone(entry), probes: new Map() }
      this.instances.set(name, record)
    }
    if (record.retired || !deepEqualJson(entry, record.entrySnapshot)) throw new Error(`mcp-manager: configuration for "${name}" is changing`)
    if (record.failure !== undefined) throw new Error(`mcp-manager: cleanup for "${name}" is incomplete; restart the Host`)
    const lifetime = new AbortController()
    const owner = record
    const signal = options?.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, options.signal])
    const done = probeServer(this.ownerContext, this.toClientConfig(name, entry), { ...options, signal }).then((result) => {
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

  private retire(record: ManagedRecord): void {
    record.retired = true
    record.detachStatus?.()
    for (const lifetime of record.probes.keys()) lifetime.abort()
  }

  private stop(): void {
    this.stopped = true
    for (const record of this.instances.values()) this.retire(record)
  }

  /** Queue one lifecycle operation on the serialized tail and contain its failure. */
  private schedule(op: () => Promise<void>, what: string): void {
    void this.enqueue(op).catch((error: unknown) => {
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

  /** Reconcile the live instance set against the current configuration. */
  private async reconcileOnce(): Promise<void> {
    const servers = this.config.servers.get()
    for (const [name, record] of this.instances) {
      const entry = servers[name]
      if (!record.retired && entry !== undefined && deepEqualJson(entry, record.entrySnapshot)) continue
      await this.unmount(name, record)
    }
    for (const name of this.statuses.keys()) {
      if (servers[name] === undefined && !this.instances.has(name)) this.statuses.delete(name)
    }
    for (const [name, entry] of Object.entries(servers)) {
      const record = this.instances.get(name)
      if (record?.retired || record?.failure !== undefined) continue
      if (!entry.enabled) {
        this.setStatus(name, { state: 'disabled' })
        continue
      }
      if (record?.handle !== undefined) continue
      this.mount(name, entry, record)
    }
  }

  private async remount(name: string): Promise<void> {
    const record = this.instances.get(name)
    if (record !== undefined && !await this.unmount(name, record)) {
      throw new Error(`mcp-manager: cleanup for "${name}" is incomplete; restart the Host`)
    }
    const entry = this.config.servers.get()[name]
    if (entry === undefined || this.stopped) return
    if (!entry.enabled) {
      this.setStatus(name, { state: 'disabled' })
      return
    }
    this.mount(name, entry)
  }

  private mount(name: string, entry: VolatileSnapshot<McpManagedServerEntry>, existing?: ManagedRecord): void {
    if (this.stopped || !deepEqualJson(this.config.servers.get()[name], entry)) return
    const record: ManagedRecord = existing ?? { entrySnapshot: structuredClone(entry), probes: new Map() }
    this.instances.set(name, record)
    this.setStatus(name, { state: 'connecting', attempt: 0 })
    const handle = record.handle = this.ownerContext.plugin(McpClient, this.toClientConfig(name, entry))
    void handle.await().then(() => {
      if (record.retired) return
      const cell = connectionStatusOf(handle)
      /* v8 ignore next -- successful MCP activation installs its status cell before becoming ready */
      if (cell === undefined) throw new Error(`mcp-manager: "${name}" activated without connection status`)
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
      this.schedule(async () => {
        if (record.retired) return
        if (await this.unmount(name, record)) this.setStatus(name, { state: 'failed', reason: 'load', lastError: String(error) })
      }, `failed startup of "${name}"`)
    })
  }

  private async unmount(name: string, record: ManagedRecord): Promise<boolean> {
    this.retire(record)
    await Promise.allSettled([...record.probes.values()])
    if (record.handle !== undefined) {
      await record.handle.dispose()
      const result = connectionStatusOf(record.handle)?.closure()
      if (result !== undefined && (!result.closeConfirmed || result.cleanupError !== undefined)) this.retainCleanupFailure(record, result)
    }
    if (record.failure !== undefined) {
      this.setStatus(name, { state: 'failed', reason: 'cleanup', result: record.failure })
      return false
    }
    this.instances.delete(name)
    return true
  }

  /** Retain the first cleanup diagnostic and every unconfirmed transport closure. */
  private retainCleanupFailure(record: ManagedRecord, result: McpCloseResult): McpCloseResult {
    return record.failure = { ...result, ...record.failure,
      closeConfirmed: result.closeConfirmed && record.failure?.closeConfirmed !== false }
  }

  /**
   * Publish changed statuses for configured entries or retained runtime records.
   * Removed entries with incomplete cleanup remain observable; disposed managers
   * retain the final status without emitting events.
   */
  private setStatus(name: string, status: McpManagedServerStatus): void {
    // A lifecycle operation that entered before disposal may still be
    // finishing while the service is torn down; nothing may emit for a
    // manager that is no longer live.
    if (this.config.servers.get()[name] === undefined && !this.instances.has(name)) return
    const previous = this.statuses.get(name)
    if (previous !== undefined && deepEqualJson(previous, status)) return
    this.statuses.set(name, status)
    if (this.stopped) return
    // A consumer's throwing listener must not break the lifecycle operation
    // publishing the status (docs/defensive-patterns.md: contain callback
    // exceptions). Invariant companions report through their own reporter,
    // not by throwing here, so containment costs them nothing.
    try {
      this.ctx.emit('mcp-manager/status', name, status)
    } catch (error) {
      this.ctx.logger.error(`mcp-manager: a mcp-manager/status listener failed for "${name}"`)
      this.ctx.logger.error(error)
    }
  }

  /**
   * Resolve client defaults while retaining template strings for runtime
   * expansion. Non-strict startup exposes connection failures through status;
   * the manager schema supplies its startup budget.
   */
  private toClientConfig(name: string, entry: VolatileSnapshot<McpManagedServerEntry>): McpClient.Config {
    const shared = {
      serverName: name,
      failOnStartupError: false as const,
      expandTemplates: true,
      ...entry.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: entry.closeTimeoutMs },
      ...entry.healthCheckTimeoutMs === undefined ? {} : { healthCheckTimeoutMs: entry.healthCheckTimeoutMs },
      ...entry.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: entry.toolCallTimeoutMs },
      startupTimeoutMs: entry.startupTimeoutMs,
      ...entry.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: entry.healthCheckIntervalMs },
      reconnect: entry.reconnect,
    }
    // Resolving through the client's own schema fills its defaults here (no
    // restatement) and returns a real Config with no type assertion; the
    // write-time validation above keeps this resolution from ever refusing.
    if (entry.transport === 'stdio') {
      return McpClient.Config({
        transport: 'stdio',
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
        cwd: entry.cwd,
        ...shared,
      })
    }
    return McpClient.Config({
      transport: 'streamable-http',
      url: entry.url,
      headers: { ...entry.headers },
      ...shared,
    })
  }
}
