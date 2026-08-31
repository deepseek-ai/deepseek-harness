/**
 * MCP server manager (`ctx.mcpServers`): one settings-driven fleet of
 * `dsh-mcp-client` instances. The `mcp` settings namespace (`mcp.servers.*`)
 * is the single source of truth — the manager's own composition entry supplies
 * the base layer, the user document layers over it, and every committed change
 * reconciles the live instance set: new entries mount, removed or disabled
 * entries unmount, and a changed entry is rebuilt. Connection handling stays
 * entirely in mcp-client; the manager owns entry resolution, instance
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
import type { Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { ReconnectSchema, SERVER_NAME_PATTERN, connectionStatusOf, probeServer } from '@deepseek-ai/dsh-mcp-client'
import type { McpProbeOptions, McpProbeResult, ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { assertTemplateSyntax, credentialRefsIn, resolveTemplateString } from './templates.ts'
import type { TemplateSources } from './templates.ts'
import type { McpManagedServerStatus, McpManagedServerView } from './types.ts'
// Side-effect type imports: declaration-merge `ctx.settings`, `ctx.tools`,
// `ctx.credentials`, and the credential events onto Context.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'

export type { McpManagedServerStatus, McpManagedServerView } from './types.ts'

/** Settings namespace owned by this manager. */
export const MCP_SETTINGS_NAMESPACE = 'mcp'

/**
 * One managed server entry. Deliberately flat rather than a per-transport
 * union: settings-wire secret redaction follows `object`/`dict`/`array`
 * containers only, so the `role('secret')` env and header values must not sit
 * inside a union branch. {@link validateServers} enforces the per-transport
 * field rules a union schema would have expressed.
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
  /** Per-attempt startup budget override in milliseconds; omission uses the mcp-client default. */
  startupTimeoutMs?: number
  /** Reconnect policy; the schema fills the mcp-client defaults. */
  reconnect: ReconnectConfig
}

/** Manager configuration: the composition-base server set. */
export interface Config {
  /** Managed servers keyed by `serverName`. */
  servers: Record<string, McpManagedServerEntry>
}

type EntryInput = Omit<McpManagedServerEntry, 'command' | 'url' | 'args' | 'env' | 'cwd' | 'headers' | 'enabled' | 'reconnect'>
  & Partial<Pick<McpManagedServerEntry, 'command' | 'url' | 'args' | 'env' | 'cwd' | 'headers' | 'enabled' | 'reconnect'>>
interface ConfigInput {
  servers?: Record<string, EntryInput>
}

const ServerEntrySchema = z.object({
  transport: z.union(['stdio', 'streamable-http']).required(),
  command: z.string().default(''),
  args: z.array(String).default([]),
  env: z.dict(z.string().role('secret')).default({}),
  cwd: z.string().default(''),
  url: z.string().default(''),
  headers: z.dict(z.string().role('secret')).default({}),
  enabled: z.boolean().default(true),
  toolCallTimeoutMs: z.number(),
  startupTimeoutMs: z.number(),
  reconnect: ReconnectSchema,
})


/** Fields of one entry that may carry template tokens, with their config paths. */
function templatedStrings(name: string, entry: McpManagedServerEntry): Array<[value: string, where: string]> {
  const path = `${MCP_SETTINGS_NAMESPACE}.servers.${name}`
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
export function validateServers(config: Config): void {
  for (const [name, entry] of Object.entries(config.servers)) {
    const path = `${MCP_SETTINGS_NAMESPACE}.servers.${name}`
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
  }
}

/** Template-resolved strings of one entry, ready for the mcp-client config. */
interface ResolvedEntryStrings {
  command?: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url?: string
  headers: Record<string, string>
}

/** One mounted (or mounting) instance owned by the manager. */
interface ManagedRecord {
  /** Resolved entry the instance was built from, for change detection. */
  entrySnapshot: McpManagedServerEntry
  /** The child mcp-client fiber. */
  handle: Fiber
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
 * The manager service. Reconciliation, `restart`, and rotation-driven rebuilds
 * are serialized on one operation tail, so two lifecycle operations can never
 * interleave one instance's unmount/mount.
 */
export default class McpServerManager extends Service {
  static Config = z.object({
    servers: z.dict(ServerEntrySchema).default({}),
  }) as unknown as z<ConfigInput, Config>

  static inject = ['tools']

  /** Entry keys composed by the deployment; these rows are not deletable. */
  private readonly baseServers: ReadonlySet<string>
  /** Authoritative configuration source: the settings scope once attached, the entry config otherwise. */
  private currentConfig: () => Config
  private readonly instances = new Map<string, ManagedRecord>()
  private readonly statuses = new Map<string, McpManagedServerStatus>()
  /** Settled operation tail serializing every lifecycle operation. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Set at service dispose: refuse new operations while queued ones drain. */
  private stopped = false

  /**
   * Validate the composed base servers and adopt them as the initial source.
   * @param ctx - the manager's plugin context; children mount under its fiber.
   * @param config - resolved manager configuration (the composition base layer).
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'mcpServers')
    validateServers(config)
    this.baseServers = new Set(Object.keys(config.servers))
    this.currentConfig = () => this.config
  }

  /**
   * Attach the optional settings section, arm credential-rotation restarts,
   * and reconcile the initial server set. Teardown unmounts every instance so
   * the registered tools are gone once the manager's disposal completes.
   */
  * [Service.init](): Generator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.stopped = true
      // The tail never rejects: every enqueue swallows its own settlement.
      await this.tail
      for (const [name, record] of [...this.instances]) await this.unmount(name, record)
    }
    this.ctx.on('credentials/reference-updated', (ref) => {
      const refText = String(ref)
      // Affectedness is read from the raw configuration, not from mounted
      // instances: a server whose earlier mount failed on this very credential
      // has no instance, and configuring the credential is what heals it.
      for (const [name, entry] of Object.entries(this.currentConfig().servers)) {
        if (!entry.enabled) continue
        const referenced = templatedStrings(name, entry)
          .some(([value]) => credentialRefsIn(value).includes(refText))
        if (!referenced) continue
        this.ctx.logger.info(`mcp-manager: credential "${refText}" changed — rebuilding MCP server "${name}"`)
        this.schedule(() => this.remount(name), `credential rebuild of "${name}"`)
      }
    })
    this.ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(this.ctx, MCP_SETTINGS_NAMESPACE, ConfigSchema, this.config, {
        setSource: (current) => {
          this.currentConfig = current
        },
        onChange: () => {
          this.schedule(() => this.reconcileOnce(), 'settings reconcile')
        },
        validate: validateServers,
      })
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
   * Every configured server with its durable intent, deletability, and
   * current runtime status. Read-only: listing never mounts, connects, or
   * probes anything.
   * @returns one view per configured entry, in document order.
   */
  list(): McpManagedServerView[] {
    return Object.entries(this.currentConfig().servers).map(([name, entry]) => ({
      name,
      transport: entry.transport,
      enabled: entry.enabled,
      deletable: !this.baseServers.has(name),
      status: this.statuses.get(name)
        ?? (entry.enabled ? { state: 'connecting', attempt: 0 } : { state: 'disabled' }),
    }))
  }

  /**
   * Rebuild one server from its current configuration: dispose the live
   * instance (if any) and mount a fresh one. This is the manual recovery for
   * every terminal `failed` state — a fresh instance starts a fresh reconnect
   * budget — and the plain reconnect affordance while connected.
   * @param name - the configured entry key.
   * @throws when no entry of that name is configured.
   */
  async restart(name: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.currentConfig().servers[name] === undefined) {
        throw new Error(`mcp-manager: unknown server "${name}" — it is not configured under ${MCP_SETTINGS_NAMESPACE}.servers`)
      }
      await this.remount(name)
    })
  }

  /**
   * Probe one configured server without touching its live instance: resolve
   * the entry's templates, connect, list tools, close. A disabled entry can be
   * probed — that is how a management surface tests it before enabling.
   * @param name - the configured entry key.
   * @param options - probe budget and abort signal.
   * @returns the stage-classified probe outcome.
   * @throws when no entry of that name is configured or its templates do not resolve.
   */
  async probe(name: string, options?: McpProbeOptions): Promise<McpProbeResult> {
    const entry = this.currentConfig().servers[name]
    if (entry === undefined) {
      throw new Error(`mcp-manager: unknown server "${name}" — it is not configured under ${MCP_SETTINGS_NAMESPACE}.servers`)
    }
    const resolved = await this.resolveEntry(name, entry)
    return probeServer(this.toClientConfig(name, entry, resolved), options)
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
    const servers = this.currentConfig().servers
    for (const [name, record] of [...this.instances]) {
      const entry = servers[name]
      if (entry !== undefined && entry.enabled && deepEqualJson(entry, record.entrySnapshot)) continue
      await this.unmount(name, record)
    }
    for (const name of [...this.statuses.keys()]) {
      if (servers[name] === undefined) this.statuses.delete(name)
    }
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry.enabled) {
        this.setStatus(name, { state: 'disabled' })
        continue
      }
      if (this.instances.has(name)) continue
      await this.mount(name, entry)
    }
  }

  /** Rebuild one server from the configuration as it stands now. */
  private async remount(name: string): Promise<void> {
    const record = this.instances.get(name)
    if (record !== undefined) await this.unmount(name, record)
    const entry = this.currentConfig().servers[name]
    if (entry === undefined) return
    if (!entry.enabled) {
      this.setStatus(name, { state: 'disabled' })
      return
    }
    await this.mount(name, entry)
  }

  /** Mount one enabled entry: resolve templates, plug a child instance, attach its status. */
  private async mount(name: string, entry: McpManagedServerEntry): Promise<void> {
    this.setStatus(name, { state: 'connecting', attempt: 0 })
    let resolved: ResolvedEntryStrings
    try {
      resolved = await this.resolveEntry(name, entry)
    } catch (error) {
      this.setStatus(name, { state: 'failed', reason: 'resolve', lastError: String(error) })
      return
    }
    // Template resolution yielded: the configuration may have moved while it
    // ran, and the reconcile for that change already executed if it committed
    // before this point — mounting anyway would leave an instance no reconcile
    // ever visits. Only the entry as currently configured may mount.
    if (!deepEqualJson(this.currentConfig().servers[name], entry)) return
    const record: ManagedRecord = {
      entrySnapshot: structuredClone(entry),
      handle: this.ctx.plugin(McpClient, this.toClientConfig(name, entry, resolved)),
    }
    this.instances.set(name, record)
    const settle = async (failure?: { error: unknown }): Promise<void> => {
      // An unmount that began while activation settled owns this record's end;
      // whichever way activation went, a retired record publishes nothing.
      if (record.retired === true) return
      if (failure === undefined) {
        const cell = connectionStatusOf(this.ctx, name)
        /* v8 ignore next -- an activated instance always registered its cell; the guard only narrows the lookup's optional return */
        if (cell === undefined) return
        // No record-currency guard on the subscription: unmount detaches it
        // before the record is replaced or removed, on the serialized tail.
        record.detachStatus = cell.onChange((status) => {
          this.setStatus(name, status)
        })
        this.setStatus(name, cell.current())
        return
      }
      this.instances.delete(name)
      try {
        await record.handle.dispose()
      } catch {
        // Swallows only the failed child fiber's teardown; the load failure
        // below is the actionable diagnostic and nothing references the fiber.
      }
      this.setStatus(name, { state: 'failed', reason: 'load', lastError: String(failure.error) })
    }
    record.handle.await().then(() => settle(), (error: unknown) => settle({ error }))
  }

  /** Dispose one instance and detach its status subscription. */
  private async unmount(name: string, record: ManagedRecord): Promise<void> {
    record.retired = true
    record.detachStatus?.()
    try {
      await record.handle.dispose()
    } catch (error) {
      /* v8 ignore next -- mcp-client contains its own teardown failures; only a hypothetical fiber-disposal error lands here */
      this.ctx.logger.warn(`mcp-manager: disposing MCP server "${name}" reported a failure: ${String(error)}`)
    }
    // Serialized lifecycle: no operation can have replaced the record while
    // this unmount held the tail, so the deletion is unconditional.
    this.instances.delete(name)
  }

  /**
   * Publish one server's status and emit the change event. Equal statuses are
   * absorbed, and a name the current configuration no longer carries publishes
   * nothing: between a removing settings commit and the reconcile that unmounts
   * the instance, its connection callbacks may still fire, and the event
   * contract promises emissions only while the entry exists.
   */
  private setStatus(name: string, status: McpManagedServerStatus): void {
    // A lifecycle operation that entered before disposal may still be
    // finishing while the service is torn down; nothing may emit for a
    // manager that is no longer live.
    if (this.stopped) return
    if (this.currentConfig().servers[name] === undefined) return
    const previous = this.statuses.get(name)
    if (previous !== undefined && deepEqualJson(previous, status)) return
    this.statuses.set(name, status)
    this.ctx.emit('mcp-manager/status', name, status)
  }

  /** Template lookups: the process environment and the optional credential seam. */
  private templateSources(): TemplateSources {
    return {
      env: name => process.env[name],
      credential: async (ref) => {
        const credentials = this.ctx.get('credentials')
        if (credentials === undefined) {
          throw new Error(`\${credential:${ref}} needs the credential seam — mount a credentials provider or use \${env:${ref}}`)
        }
        const resolvedValue = await credentials.resolve(credentialRef(ref))
        return resolvedValue?.value
      },
    }
  }

  /** Resolve every templated string of one entry. */
  private async resolveEntry(name: string, entry: McpManagedServerEntry): Promise<ResolvedEntryStrings> {
    const sources = this.templateSources()
    const resolveOne = async (value: string, where: string): Promise<string> => {
      return (await resolveTemplateString(value, where, sources)).value
    }
    const path = `${MCP_SETTINGS_NAMESPACE}.servers.${name}`
    if (entry.transport === 'stdio') {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(entry.env)) {
        env[key] = await resolveOne(value, `${path}.env.${key}`)
      }
      const args: string[] = []
      for (const [index, arg] of entry.args.entries()) {
        args.push(await resolveOne(arg, `${path}.args[${String(index)}]`))
      }
      return {
        command: await resolveOne(entry.command, `${path}.command`),
        args,
        env,
        cwd: await resolveOne(entry.cwd, `${path}.cwd`),
        headers: {},
      }
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry.headers)) {
      headers[key] = await resolveOne(value, `${path}.headers.${key}`)
    }
    return {
      args: [],
      env: {},
      cwd: '',
      url: await resolveOne(entry.url, `${path}.url`),
      headers,
    }
  }

  /**
   * The one explicit resolve step from a managed entry to the mcp-client
   * instance config. `failOnStartupError` stays false — the manager, not
   * plugin activation, owns failure surfacing — and omitted timeouts defer to
   * mcp-client's own defaults instead of restating them here.
   */
  private toClientConfig(name: string, entry: McpManagedServerEntry, resolved: ResolvedEntryStrings): McpClient.Config {
    const shared = {
      serverName: name,
      failOnStartupError: false,
      ...entry.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: entry.toolCallTimeoutMs },
      ...entry.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: entry.startupTimeoutMs },
      reconnect: entry.reconnect,
    }
    if (entry.transport === 'stdio') {
      return {
        transport: 'stdio',
        command: resolved.command,
        args: resolved.args,
        env: resolved.env,
        cwd: resolved.cwd,
        ...shared,
      } as McpClient.Config
    }
    return {
      transport: 'streamable-http',
      url: resolved.url,
      headers: resolved.headers,
      ...shared,
    } as McpClient.Config
  }
}

/** Schema for {@link Config}; doubles as the `mcp` settings-section schema. */
export const ConfigSchema: z<ConfigInput, Config> = McpServerManager.Config
