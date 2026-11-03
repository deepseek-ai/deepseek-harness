/**
 * One-shot MCP server probe: connect, read the server identity, list tools,
 * close. Nothing registers on `ctx.tools`, no `serverName` is reserved, and
 * nothing persists — the probe answers a configuration surface's
 * "test this server" without touching the live instance set. Expected
 * failures return a stage-classified value rather than throwing, so a wire
 * caller renders the outcome without exception mapping.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type { McpProbeFailure, McpProbeResult, McpProbeStage, McpProbeSuccess } from './types.ts'
import { McpTemplateBinding } from './credentials.ts'
import { McpGeneration } from './generation.ts'
import type { Config } from './index.ts'

/** Options for one {@link probeServer} call. */
export interface McpProbeOptions {
  /** Budget for the whole probe (connect + listing) in milliseconds; default 10000. */
  timeoutMs?: number
  /** Maximum listing pages before returning a truncated result; default 16. */
  maxPages?: number
  /** Maximum raw tool names retained in the result; default 512. */
  maxToolNames?: number
  /**
   * Abort the in-flight probe; settles as a failure at the current stage after
   * bounded generation cleanup.
   */
  signal?: AbortSignal
}

/** Default whole-probe budget (ms): interactive surfaces need a bounded answer. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/** Listing page cap: a cursor loop or firehose server ends as truncation, not a hang. */
const PROBE_MAX_PAGES = 16

/** Tool-name cap on the returned list. */
const PROBE_MAX_TOOL_NAMES = 512

function resolveProbeOptions(options: McpProbeOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const maxPages = options.maxPages ?? PROBE_MAX_PAGES
  const maxToolNames = options.maxToolNames ?? PROBE_MAX_TOOL_NAMES
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('probeServer: timeoutMs must be a positive finite number')
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError('probeServer: maxPages must be a positive safe integer')
  if (!Number.isSafeInteger(maxToolNames) || maxToolNames < 1) throw new TypeError('probeServer: maxToolNames must be a positive safe integer')
  return { timeoutMs, maxPages, maxToolNames, signal: options.signal }
}

/**
 * Probe a server without registering tools or reserving its namespace.
 * @param ctx - context providing template sources when expansion is enabled.
 * @param config - transport configuration; its startup budget does not bound the probe.
 * @param options - whole-probe budget, listing caps, and cancellation signal.
 * @returns the connect/list outcome and independent cleanup result after bounded closure.
 * @throws for invalid options, malformed templates, or a missing required credentials provider.
 */
export async function probeServer(ctx: Context, config: Config, options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const spec = resolveProbeOptions(options)
  const startedAt = Date.now()
  const remaining = (): number => spec.timeoutMs - (Date.now() - startedAt)
  const binding = new McpTemplateBinding(ctx, config)
  const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  const generation = new McpGeneration(client, config.closeTimeoutMs, error => binding.diagnostic(error, 'cleanup'))
  const abort = (): void => { void generation.close() }
  spec.signal?.addEventListener('abort', abort, { once: true })
  if (spec.signal?.aborted) abort()
  let stage: McpProbeStage = 'connect'
  let result: McpProbeSuccess | McpProbeFailure
  try {
    const resolved = await generation.run(signal => binding.resolve(signal), remaining())
    await generation.connect(resolved, remaining())
    const identity = client.getServerVersion()
    const serverInfo = identity === undefined ? undefined : { name: identity.name, version: identity.version }
    stage = 'list'
    const toolNames: string[] = []
    let truncated = false
    let cursor: string | undefined
    if (client.getServerCapabilities()?.tools !== undefined) {
      for (let page = 0; page < spec.maxPages; page++) {
        const response = await generation.run(signal => client.request(
          { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } }, { signal },
        ), remaining())
        for (const tool of response.tools) {
          if (toolNames.length >= spec.maxToolNames) { truncated = true; break }
          toolNames.push(tool.name)
        }
        cursor = response.nextCursor
        if (cursor === undefined || truncated) break
        if (page === spec.maxPages - 1) truncated = true
      }
    }
    result = { ok: true, ...serverInfo === undefined ? {} : { serverInfo }, toolNames, truncated, durationMs: Date.now() - startedAt }
  } catch (error) {
    result = { ok: false, stage, message: spec.signal?.aborted ? 'probe aborted' : binding.diagnostic(error, stage), durationMs: Date.now() - startedAt }
  } finally {
    spec.signal?.removeEventListener('abort', abort)
  }
  return { ...result, ...await generation.close() }
}
