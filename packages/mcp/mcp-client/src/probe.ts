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

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describeError } from './diagnostic.ts'
import { withDeadline } from './deadline.ts'
import { createTransport } from './transport.ts'
import type { Config } from './index.ts'

/** Options for one {@link probeServer} call. */
export interface McpProbeOptions {
  /** Budget for the whole probe (connect + listing) in milliseconds; default 10000. */
  timeoutMs?: number
  /** Abort the in-flight probe; settles as a failure at the current stage. */
  signal?: AbortSignal
}

/** Probe phase a failure is attributed to. */
export type McpProbeStage = 'connect' | 'list'

/** Successful probe: the server answered `initialize` and `tools/list`. */
export interface McpProbeSuccess {
  ok: true
  /** Server-reported identity from `initialize`, when the SDK captured one. */
  serverInfo?: { name: string; version: string }
  /** Advertised raw tool names, capped at {@link PROBE_MAX_TOOL_NAMES}. */
  toolNames: string[]
  /** Whether the advertised list was longer than the returned `toolNames`. */
  truncated: boolean
  /** Wall-clock duration of the probe in milliseconds. */
  durationMs: number
}

/** Failed probe, attributed to the stage that raised it. */
export interface McpProbeFailure {
  ok: false
  stage: McpProbeStage
  /** Diagnostic text of the failure. */
  message: string
  /** Wall-clock duration until the failure in milliseconds. */
  durationMs: number
}

/** Outcome of one {@link probeServer} call. */
export type McpProbeResult = McpProbeSuccess | McpProbeFailure

/** Default whole-probe budget (ms): interactive surfaces need a bounded answer. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/** Listing page cap: a cursor loop or firehose server ends as truncation, not a hang. */
const PROBE_MAX_PAGES = 16

/** Tool-name cap on the returned list. */
const PROBE_MAX_TOOL_NAMES = 512

/** Reject when the shared probe budget elapses before `promise` settles. */
function withProbeDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T> {
  return withDeadline(promise, remainingMs, `probe timed out after its ${String(remainingMs)}ms remaining budget`)
}

/**
 * Probe one MCP server configuration without registering anything.
 * @param config - resolved transport configuration (the `serverName` is not reserved).
 * @param options - probe budget and abort signal.
 * @returns the stage-classified probe outcome; expected failures resolve rather than reject.
 */
export async function probeServer(config: Config, options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('probeServer: timeoutMs must be a positive finite number')
  }
  const startedAt = Date.now()
  const remaining = (): number => timeoutMs - (Date.now() - startedAt)
  const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.1' }, { capabilities: {} })
  let stage: McpProbeStage = 'connect'
  try {
    await withProbeDeadline(client.connect(createTransport(config)), remaining())
    const identity = client.getServerVersion()
    const serverInfo = identity === undefined ? undefined : { name: identity.name, version: identity.version }
    stage = 'list'
    const toolNames: string[] = []
    let truncated = false
    let cursor: string | undefined
    for (let page = 0; page < PROBE_MAX_PAGES; page += 1) {
      const result = await withProbeDeadline(
        client.request(
          { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
          ListToolsResultSchema,
          options.signal === undefined ? {} : { signal: options.signal },
        ),
        remaining(),
      )
      for (const tool of result.tools) {
        if (toolNames.length >= PROBE_MAX_TOOL_NAMES) {
          truncated = true
          break
        }
        toolNames.push(tool.name)
      }
      cursor = result.nextCursor
      if (cursor === undefined || truncated) break
      if (page === PROBE_MAX_PAGES - 1) truncated = true
    }
    return {
      ok: true,
      ...serverInfo === undefined ? {} : { serverInfo },
      toolNames,
      truncated,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return { ok: false, stage, message: describeError(error), durationMs: Date.now() - startedAt }
  } finally {
    try {
      await client.close()
    } catch {
      // Transport already gone: a probe that failed to connect (or whose server
      // vanished mid-listing) has nothing left to close.
    }
  }
}
