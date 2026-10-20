/**
 * Connection supervisor: owns the MCP client/transport generations for one
 * plugin instance, keeps the harness tool registry in sync with the live
 * generation, and — when the connection drops — restarts the configured
 * server with bounded exponential backoff.
 *
 * One outage shares one attempt budget (`maxAttempts` consecutive failed
 * attempts, delays doubling from `initialDelayMs` up to `maxDelayMs`). A
 * connection that stays up past the stability window closes the outage, so
 * the next disconnect starts a fresh budget while a crash-looping server —
 * even one whose connects briefly succeed — still exhausts the cap instead of
 * restarting forever. Exhaustion unregisters the server's tools and stops;
 * disposal (including HMR) is the only way back from that state.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ServerContext } from './server-context.ts'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { withDeadline } from './deadline.ts'
import { describeError, McpLocalError } from './diagnostic.ts'
import type { McpStatusCell } from './status.ts'
import type { McpCloseResult } from './types.ts'
import { McpGeneration } from './generation.ts'
import { McpToolRegistrationError, syncTools } from './tools.ts'
import type { ToolDisposers } from './tools.ts'
import type { Config } from './index.ts'

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}

/** Defaults shared by the Config schema and {@link resolveReconnectPolicy}. */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** Default UTF-8 byte limit for attributed server instructions. */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768

/** Fully resolved reconnect policy captured at plugin load. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * The one explicit resolve step from raw reconnect config to the policy the
 * supervisor runs. Programmatic construction may bypass Schemastery
 * normalization, so every default and bound is re-judged here — misconfiguration
 * fails the plugin instance at load.
 *
 * @param config - Raw `reconnect` config; omission uses the defaults.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  /* jscpd:ignore-start — domain-specific delay validation parallels llm retry-policy; not extractable */
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  /* jscpd:ignore-end */
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** Result from the initial connection attempt, for startup-await semantics. */
export interface ConnectionOutcome {
  /** If the initial connection or tool sync failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's supervised connection. */
export interface ConnectionHandle extends ServerContext {
  /**
   * Settles when the first connection attempt completes or the instance is disposed.
   * The supervisor applies its retry policy; the caller
   * decides whether a failed startup is fatal via `failOnStartupError`.
   */
  ready: Promise<ConnectionOutcome>
  /**
   * Stop reconnection, cancel owned work, and unregister this server's tools.
   * Cleanup is bounded by `closeTimeoutMs`; incomplete cleanup is recorded in
   * the status cell and blocks replacement.
   */
  dispose(): Promise<void>
}

/**
 * Start the supervised connection for one MCP server and keep it alive per
 * the reconnect policy. The first attempt starts in a microtask; the caller
 * must register disposal before yielding.
 *
 * @param ctx - Cordis context providing the `tools` registry and logger.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
 * @param status - Instance status cell this supervisor publishes transitions to.
 * @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
 */
export function startConnection(ctx: Context, config: Config, policy: ResolvedReconnectPolicy, status: McpStatusCell): ConnectionHandle {
  const label = `mcp-client(${config.serverName})`
  const readiness = Promise.withResolvers<ConnectionOutcome>()
  type Generation = { wire: McpGeneration; connectedAt?: number }
  let current: Generation | undefined
  let disposed = false
  let serverInstructions = ''
  let disposers: ToolDisposers = new Map()
  let syncChain: Promise<void> = Promise.resolve()
  let settling: Promise<void> = Promise.resolve()
  let reconnectTimer: NodeJS.Timeout | undefined
  let failedAttempts = 0
  let closureFailure: McpCloseResult | undefined
  const isCurrent = (record: Generation): boolean => !disposed && current === record && !record.wire.lifetime.signal.aborted

  function stopTimers(): void {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  function clearTools(): void {
    for (const dispose of disposers.values()) {
      try { dispose() }
      catch (error) {
        closureFailure = { ...status.closure(), cleanupError: describeError(error) }
        status.recordClosure(closureFailure)
        ctx.logger.error(`${label}: tool cleanup failed: ${describeError(error)}`)
      }
    }
    disposers = new Map()
    serverInstructions = ''
  }

  async function close(record: Generation): Promise<boolean> {
    const result = await record.wire.close()
    if (!result.closeConfirmed || result.cleanupError !== undefined) closureFailure ??= result
    status.recordClosure(closureFailure ?? result)
    if (closureFailure !== undefined && !disposed) {
      const error = new Error(closureFailure.cleanupError)
      status.update({ state: 'failed', reason: 'unclosed-generation', lastError: error.message })
      readiness.resolve({ error })
    }
    return closureFailure === undefined
  }

  function enqueueSync(record: Generation): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(record)) return
      await record.wire.run(async (signal) => {
        // Closure waits for this task to take ownership, even if cancellation rejects its caller first.
        disposers = await syncTools(record.wire.client, ctx, {
          serverName: config.serverName,
          toolCallTimeoutMs: config.toolCallTimeoutMs,
          signal,
        }, disposers, () => isCurrent(record))
      })
    })
    syncChain = run.then(() => undefined, () => undefined)
    return run
  }

  function scheduleReconnect(error: string, connectedAt?: number): void {
    if (disposed || closureFailure !== undefined) return
    if (!policy.enabled) {
      const message = connectedAt !== undefined
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      status.update({ state: 'failed', reason: 'reconnect-disabled', lastError: error })
      ctx.logger.error(`${label}: ${message}`)
      return
    }
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    failedAttempts++
    if (failedAttempts > policy.maxAttempts) {
      syncChain = syncChain.then(clearTools)
      status.update({ state: 'failed', reason: 'gave-up', lastError: error })
      ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = connectedAt !== undefined ? 'connection lost; reconnecting' : 'connection failed; retrying'
    ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    status.update({ state: 'reconnecting', attempt: failedAttempts, maxAttempts: policy.maxAttempts,
      nextRetryAtMs: Date.now() + delayMs, lastError: error })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration()
    }, delayMs)
    reconnectTimer.unref()
  }

  function lost(record: Generation, error: string): void {
    if (!isCurrent(record)) return
    current = undefined
    settling = close(record).then((confirmed) => {
      readiness.resolve({ error: new Error(error) })
      if (confirmed) scheduleReconnect(error, record.connectedAt)
    })
  }

  function isStopped(): boolean { return disposed || closureFailure !== undefined }

  async function connectGeneration(): Promise<void> {
    if (isStopped()) return
    const client = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, {
      capabilities: {}, versionNegotiation: { mode: 'auto' },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => { void refreshTools() } } },
    })
    const record: Generation = { wire: new McpGeneration(client, config.closeTimeoutMs, describeError) }
    current = record
    status.opened()
    status.update({ state: 'connecting', attempt: failedAttempts })
    client.onclose = () => {
      if (record.connectedAt !== undefined) lost(record, 'connection closed')
    }
    async function refreshTools(): Promise<void> {
      if (!isCurrent(record)) return
      ctx.logger.info(`${label}: tool list changed, re-syncing`)
      try {
        await enqueueSync(record)
        if (isCurrent(record) && record.connectedAt !== undefined) {
          status.update({ state: 'connected', toolCount: disposers.size, connectedAt: record.connectedAt })
        }
      } catch (error) {
        if (error instanceof McpToolRegistrationError) lost(record, describeError(error))
        else if (isCurrent(record)) ctx.logger.error(`${label}: tool re-sync failed: ${describeError(error)}`)
      }
    }
    try {
      const startedAt = Date.now()
      const remaining = (): number | undefined => config.startupTimeoutMs === undefined ? undefined
        : config.startupTimeoutMs - (Date.now() - startedAt)
      await record.wire.connect(config, remaining())
      if (!isCurrent(record)) return
      const text = client.getInstructions()?.trimEnd() ?? ''
      const instructions = text ? `### MCP server: ${config.serverName}\n\n${text}` : ''
      const maxInstructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES
      if (Buffer.byteLength(instructions) > maxInstructionBytes) throw new McpLocalError(`${label}: server instructions exceed maxInstructionBytes (${maxInstructionBytes})`)
      const sync = enqueueSync(record)
      const budget = remaining()
      await (budget === undefined ? sync : withDeadline(sync, budget, `${label}: startup timed out`))
      if (!isCurrent(record)) return
      record.wire.assertOpen()
      serverInstructions = instructions
      record.connectedAt = Date.now()
      status.update({ state: 'connected', toolCount: disposers.size, connectedAt: record.connectedAt })
      readiness.resolve({})
      if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
    } catch (error) {
      if (current !== record) return
      current = undefined
      const confirmed = await close(record)
      readiness.resolve({ error })
      if (disposed || !confirmed) return
      ctx.logger.warn(`${label}: connection attempt failed: ${describeError(error)}`)
      scheduleReconnect(describeError(error))
    }
  }

  settling = Promise.resolve().then(connectGeneration)

  return {
    ready: readiness.promise,
    instructions: () => serverInstructions,
    resources: {
      async request(request, exec): Promise<JsonValue> {
        const record = current
        if (record?.connectedAt === undefined) throw new Error(`${label}: server is disconnected`)
        return await record.wire.run(async (signal) => {
          const options = { signal: AbortSignal.any([signal, exec.signal]), timeout: config.toolCallTimeoutMs }
          const generation = record.wire.client
          switch (request.method) {
            case 'resources/list': return await generation.listResources(request.cursor === undefined ? undefined : { cursor: request.cursor }, options) as JsonValue
            case 'resources/templates/list': return await generation.listResourceTemplates(request.cursor === undefined ? undefined : { cursor: request.cursor }, options) as JsonValue
            case 'resources/read': return await generation.readResource({ uri: request.uri }, options) as JsonValue
            /* v8 ignore next -- exhaustive over the closed resource request union */
            default: return assertNever(request)
          }
        })
      },
    },
    async dispose(): Promise<void> {
      disposed = true
      readiness.resolve({ error: new Error('MCP client disposed') })
      stopTimers()
      const record = current
      current = undefined
      if (record !== undefined) await close(record)
      // Quiesce, don't just request it: the in-flight attempt enqueues its
      // sync before settling, so awaiting both leaves `disposers` final.
      await settling
      await syncChain
      clearTools()
      const result = closureFailure ?? status.closure()
      status.recordClosure(result)
      status.update({ state: 'closed', result })
      if (!result.closeConfirmed || result.cleanupError !== undefined) ctx.logger.error(`${label}: cleanup incomplete`)
    },
  }
}
