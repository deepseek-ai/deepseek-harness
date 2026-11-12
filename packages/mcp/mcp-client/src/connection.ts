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
 * a changed credential binding or a fresh instance resets that budget.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { assertNever, deepEqualJson, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ServerContext } from './server-context.ts'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { withDeadline } from './deadline.ts'
import { McpLocalError, mcpRequestError, McpToolError } from './diagnostic.ts'
import type { McpStatusCell } from './status.ts'
import type { McpCloseResult } from './types.ts'
import { McpGeneration } from './generation.ts'
import { McpTemplateBinding } from './credentials.ts'
import { MissingTemplateValue } from './templates.ts'
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
   * The supervisor applies its retry or credential-wait policy; the caller
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
  const binding = new McpTemplateBinding(ctx, config)
  const diagnostic = (error: unknown, operation: string): string => binding.diagnostic(error, operation)
  const lifetime = new AbortController()
  const readiness = Promise.withResolvers<ConnectionOutcome>()
  type Generation = { wire: McpGeneration; connectedAt?: number }
  let current: Generation | undefined
  let bindingValue: { config?: Config } | undefined
  let disposed = false
  let serverInstructions = ''
  let disposers: ToolDisposers = new Map()
  let syncChain: Promise<void> = Promise.resolve()
  let settling: Promise<void> = Promise.resolve()
  let reconnectTimer: NodeJS.Timeout | undefined
  let failedAttempts = 0
  let closureFailure: McpCloseResult | undefined
  let checkingCredentials: Promise<void> | undefined
  let credentialsDirty = false
  const isCurrent = (record: Generation): boolean => !disposed && current === record && !record.wire.lifetime.signal.aborted

  function stopTimers(): void {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  function clearTools(): void {
    for (const dispose of disposers.values()) {
      try { dispose() }
      catch (error) {
        closureFailure = { ...status.closure(), cleanupError: diagnostic(error, 'tool cleanup') }
        status.recordClosure(closureFailure)
        ctx.logger.error(`${label}: tool cleanup failed: ${diagnostic(error, 'tool cleanup')}`)
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
          ...config.expandTemplates ? { redact: (text: string) => binding.redact(text) } : {},
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

  function requestCredentialRefresh(): void {
    if (isStopped()) return
    credentialsDirty = true
    checkingCredentials ??= (async () => {
      while (credentialsDirty && !isStopped()) {
        credentialsDirty = false
        let next: Config | undefined
        try { next = await binding.resolve(lifetime.signal) }
        catch (error) {
          if (!(error instanceof MissingTemplateValue)) throw error
        }
        if (disposed || bindingValue !== undefined && deepEqualJson(next, bindingValue.config)) continue
        stopTimers()
        const record = current
        const attempt = settling
        current = undefined
        if (record !== undefined) await close(record)
        await attempt
        await syncChain
        stopTimers()
        clearTools()
        if (isStopped()) {
          readiness.resolve({ error: new Error('MCP credential refresh cleanup is incomplete') })
          return
        }
        failedAttempts = 0
        bindingValue = next === undefined ? {} : { config: next }
        settling = connectGeneration()
      }
    })().catch((error: unknown) => {
      if (!disposed) ctx.logger.error(`${label}: credential refresh failed: ${diagnostic(error, 'credential refresh')}`)
    }).finally(() => {
      checkingCredentials = undefined
      if (credentialsDirty) requestCredentialRefresh()
    })
  }

  if (binding.refs.size > 0) {
    ctx.on('credentials/reference-updated', (ref) => {
      if (binding.refs.has(String(ref))) requestCredentialRefresh()
    })
  }

  async function connectGeneration(): Promise<void> {
    if (isStopped()) return
    const client = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, {
      capabilities: {}, versionNegotiation: { mode: 'auto' },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => { void refreshTools() } } },
    })
    const record: Generation = { wire: new McpGeneration(client, config.closeTimeoutMs, error => diagnostic(error, 'cleanup')) }
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
        if (error instanceof McpToolRegistrationError) lost(record, diagnostic(error, 'tool synchronization'))
        else if (isCurrent(record)) ctx.logger.error(`${label}: tool re-sync failed: ${diagnostic(error, 'tool synchronization')}`)
      }
    }
    try {
      const startedAt = Date.now()
      const remaining = (): number | undefined => config.startupTimeoutMs === undefined ? undefined
        : config.startupTimeoutMs - (Date.now() - startedAt)
      const resolved = await record.wire.run(signal => binding.resolve(signal), remaining())
      bindingValue = { config: resolved }
      await record.wire.connect(resolved, remaining())
      if (!isCurrent(record)) return
      const text = client.getInstructions()?.trimEnd() ?? ''
      const instructions = text ? `### MCP server: ${config.serverName}\n\n${text}` : ''
      const maxInstructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES
      if (Buffer.byteLength(instructions) > maxInstructionBytes) throw new McpLocalError(`${label}: server instructions exceed maxInstructionBytes (${maxInstructionBytes})`, 'MCP_INSTRUCTIONS_TOO_LARGE')
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
      readiness.resolve({ error: config.expandTemplates ? new Error(diagnostic(error, 'startup')) : error })
      if (disposed || !confirmed) return
      if (error instanceof MissingTemplateValue) {
        bindingValue = {}
        status.update({ state: 'waiting-credentials', lastError: diagnostic(error, 'credential resolution') })
        return
      }
      ctx.logger.warn(`${label}: connection attempt failed: ${diagnostic(error, 'startup')}`)
      scheduleReconnect(diagnostic(error, 'startup'))
    }
  }

  settling = Promise.resolve().then(connectGeneration)

  return {
    ready: readiness.promise,
    instructions: () => serverInstructions,
    resources: {
      async request(request, exec): Promise<JsonValue> {
        const record = current
        if (record?.connectedAt === undefined) throw new McpToolError(`${label}: server is disconnected`, 'MCP_SERVER_UNAVAILABLE')
        try {
          return await record.wire.run(async (signal) => {
            const options = { signal: AbortSignal.any([signal, exec.signal]), timeout: config.toolCallTimeoutMs }
            const generation = record.wire.client
            // The SDK answers an unadvertised capability with the same empty page, but
            // writes a console.debug line to stdout, which the ACP profile reserves for JSON-RPC.
            const listable = generation.getServerCapabilities()?.resources !== undefined
            switch (request.method) {
              case 'resources/list':
                return listable
                  ? await generation.listResources(
                    request.cursor === undefined ? undefined : { cursor: request.cursor }, options,
                  ) as JsonValue
                  : { resources: [] }
              case 'resources/templates/list':
                return listable
                  ? await generation.listResourceTemplates(
                    request.cursor === undefined ? undefined : { cursor: request.cursor }, options,
                  ) as JsonValue
                  : { resourceTemplates: [] }
              case 'resources/read': return await generation.readResource({ uri: request.uri }, options) as JsonValue
              /* v8 ignore next -- exhaustive over the closed resource request union */
              default: return assertNever(request)
            }
          })
        } catch (error) {
          exec.signal.throwIfAborted()
          throw mcpRequestError(error, request.method, config.expandTemplates ? text => binding.redact(text) : undefined)
        }
      },
    },
    async dispose(): Promise<void> {
      disposed = true
      readiness.resolve({ error: new Error('MCP client disposed') })
      lifetime.abort(new Error('MCP client disposed'))
      stopTimers()
      const record = current
      current = undefined
      if (record !== undefined) await close(record)
      try {
        await withDeadline(Promise.all([settling, syncChain, checkingCredentials]), config.closeTimeoutMs, 'MCP cleanup did not settle')
      } catch (error) {
        closureFailure ??= { ...status.closure(), cleanupError: diagnostic(error, 'cleanup') }
      }
      clearTools()
      const result = closureFailure ?? status.closure()
      status.recordClosure(result)
      status.update({ state: 'closed', result })
      if (!result.closeConfirmed || result.cleanupError !== undefined) ctx.logger.error(`${label}: cleanup incomplete`)
    },
  }
}
