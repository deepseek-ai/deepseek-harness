/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_MAX_INSTRUCTION_BYTES, RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'

export { resolveReconnectPolicy } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
import { registerServerContext } from './server-context.ts'
import { McpStatusCell, connectionStatusIn, registerStatusCell } from './status.ts'
import type { McpConnectionStatusHandle } from './status.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export { createMcpToolDefinition } from './tools.ts'
export type { McpResult, McpToolDefinitionOptions } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
export type { McpConnectionStatus, McpConnectionStatusHandle } from './status.ts'
export { probeServer } from './probe.ts'
export type { McpProbeOptions, McpProbeResult, McpProbeStage } from './probe.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls and resource requests (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Default budget for one connection attempt plus its initial tool sync (ms). */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/** Default spacing between liveness pings on an established connection. */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000

/** Valid `serverName`, kept below the public tool-name budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per registration scope. Agent-scoped MCP
 * servers may reuse a namespace in another Agent, while global instances and
 * duplicates inside one Agent remain mutually exclusive.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

/**
 * The connection-status handle of the live mcp-client instance named
 * `serverName` in `ctx`'s registration scope. Same-scope callers — a manager
 * that plugged the instance, or a sibling plugin — observe connection state
 * without owning the instance; the handle disappears when the instance is
 * disposed.
 * @param ctx - a context sharing the instance's registration scope.
 * @param serverName - the instance's configured namespace.
 * @returns the read-and-observe handle, or `undefined` when the name has no live instance in this scope.
 */
export function connectionStatusOf(ctx: Context, serverName: string): McpConnectionStatusHandle | undefined {
  return connectionStatusIn(scopeOf(ctx) ?? ctx.root, serverName)
}

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs: number
  /**
   * Spacing between liveness pings on an established connection, in
   * milliseconds; the same value bounds each ping's answer. A failed or
   * timed-out ping closes the generation into the reconnect path — the only
   * way a silently dead Streamable HTTP server (no close signal between
   * requests) is detected.
   */
  healthCheckIntervalMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs: number
  /**
   * Spacing between liveness pings on an established connection, in
   * milliseconds; the same value bounds each ping's answer. A failed or
   * timed-out ping closes the generation into the reconnect path — the only
   * way a silently dead Streamable HTTP server (no close signal between
   * requests) is detected.
   */
  healthCheckIntervalMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

type StdioConfigInput = Omit<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'healthCheckIntervalMs' | 'failOnStartupError'>
  & Partial<Pick<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'healthCheckIntervalMs' | 'failOnStartupError'>>
type StreamableHttpConfigInput = Omit<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'healthCheckIntervalMs' | 'failOnStartupError'>
  & Partial<Pick<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'healthCheckIntervalMs' | 'failOnStartupError'>>
type ConfigInput = StdioConfigInput | StreamableHttpConfigInput

/**
 * Reconnect-policy section schema, exported so a manager composing mcp-client
 * instances (`dsh-mcp-manager`) validates the same fields, defaults, and
 * bounds without restating them.
 */
export const ReconnectSchema: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

/* jscpd:ignore-start */
// The catalog generator statically walks this literal and rejects spreads and
// computed keys, so the branches restate their shared rows by construction.
export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STARTUP_TIMEOUT_MS),
    healthCheckIntervalMs: z.number().min(1_000).max(MAX_TIMER_DELAY_MS).default(DEFAULT_HEALTH_CHECK_INTERVAL_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: ReconnectSchema,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STARTUP_TIMEOUT_MS),
    healthCheckIntervalMs: z.number().min(1_000).max(MAX_TIMER_DELAY_MS).default(DEFAULT_HEALTH_CHECK_INTERVAL_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: ReconnectSchema,
  }),
]) as unknown as z<ConfigInput, Config>
/* jscpd:ignore-end */

// ---- Plugin apply ----

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  // The status cell registers and releases with the reservation, so the
  // per-scope status lookup answers exactly while this instance is live.
  const status = new McpStatusCell((message, error) => {
    ctx.logger.warn(`mcp-client(${config.serverName}): ${message}`)
    ctx.logger.warn(error)
  })
  ctx.effect(() => {
    const owner = scopeOf(ctx) ?? ctx.root
    let names = activeServerNames.get(owner)
    if (!names) {
      names = new Set()
      activeServerNames.set(owner, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    const releaseCell = registerStatusCell(owner, config.serverName, status)
    return () => {
      releaseCell()
      names.delete(config.serverName)
    }
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  const connection = startConnection(ctx, config, reconnect, status)
  registerServerContext(ctx, config.serverName, connection)
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= connection.dispose()
  // Cordis announces unload before awaiting an unfinished apply(). Closing
  // the transport here releases startup requests that are still awaiting a reply.
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis contains observer failures; the effect also awaits this promise.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    return dispose()
  }, { global: true })
  ctx.effect(() => dispose, 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
