/**
 * SDK-facing JSON-RPC plugin over stdio. The selected dsh profile decides
 * whether to load it; see the single-launch Agent Note and package README.
 * Stdout is reserved for protocol frames, so the tree must not load a stdout logger.
 * This plugin answers `shutdown`, disposes the complete root runtime, and exits 0; the app bin
 * owns EOF and signal exits. Keep named plugin exports with no default export so
 * Loader `unwrapExports` preserves `name`, `inject`, `Config`, and `apply`.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server
 */

import { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { observeRuntime, type RuntimeProcessEvents } from './process-events.ts'
import { HarnessSdkJsonRpcServer } from './server.ts'
import type {} from '@deepseek-ai/dsh-mcp-manager'

export * from './server.ts'

export const name = 'sdk-jsonrpc-server'
export const inject = ['agents', 'workingDirectory']

/** JSON-RPC deployment config plus runtime-only test hooks. */
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /** Longest `initialize` wait, in milliseconds, for MCP manager servers in their first connection attempt; `0` skips it. */
  mcpStartupTimeoutMs?: number
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
  /** Process-event override; production uses `process`. */
  processEvents?: RuntimeProcessEvents
}

export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
  mcpStartupTimeoutMs: Schema.natural().max(MAX_TIMER_DELAY_MS).default(30_000),
})

/**
 * Serve SDK requests over the configured streams. Effect disposal shuts down
 * SDK-created agents and closes the transport. A `shutdown` response is flushed
 * before the root runtime is disposed and the process exits 0; the app bin
 * owns root-context disposal for EOF and signals.
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // Cordis applies the schema default before invoking the plugin.
  const resolvedConfig = config as JsonRpcConfig & { maxTokensAsSuccess: boolean; mcpStartupTimeoutMs: number }
  // Protocol shutdown owns the complete runtime process, so it must await the
  // root lifecycle (including persistence) before exiting.
  const rootFiber = ctx[Context.root].fiber
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- production exit wiring; tests always inject the runtime hooks */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })
  /* v8 ignore next -- production process wiring; tests always inject the runtime hooks */
  const processEvents = config.processEvents ?? process

  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
    runtime: observeRuntime(ctx, rootFiber, processEvents, input),
  })
  // Compositions can order Schedule after its activation handler is installed.
  // Like the app startup marker, this carries readiness, not another control API.
  ctx.provide('sdkSessionActivation', { ready: true })

  // Share one exit task so racing shutdown requests cannot dispose the root or
  // exit the process more than once.
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    // `initialize` is the SDK's readiness boundary. This plugin can activate
    // before async sibling Loader entries (for example an MCP client's initial
    // tool discovery), so do not advertise a ready runtime until the complete
    // current tree has settled. Loader settlement joins entry imports, fiber
    // lifecycle work, and synchronous effect registration; no scheduler delay
    // is part of readiness. A hand-built context without Loader remains
    // immediately usable. MCP manager servers mount after the manager
    // activates, outside Loader settlement, so they get their own bounded wait.
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
      await awaitMcpStartup(ctx, resolvedConfig.mcpStartupTimeoutMs)
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // Run after the handler result is written; the task then flushes, disposes, and exits.
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'jsonrpc.serve')
}

/**
 * Hold `initialize` until no MCP manager server is in its first connection attempt, so the tools of servers that
 * connect reach the first prompt. Without the manager, or with a zero budget, it returns at once. An exhausted budget
 * logs the servers still connecting and returns; their tools join the tool list when they connect.
 * @param ctx - the plugin context; reads the optional `mcpManager` service.
 * @param timeoutMs - the longest wait in milliseconds.
 */
async function awaitMcpStartup(ctx: Context, timeoutMs: number): Promise<void> {
  const manager = ctx.get('mcpManager')
  if (manager === undefined || timeoutMs === 0) return
  const pending = await manager.whenSettled(AbortSignal.timeout(timeoutMs))
  if (pending.length > 0) {
    ctx.logger.warn(`sdk-jsonrpc-server: initialize continues after ${String(timeoutMs)} ms while MCP servers are still connecting: ${pending.join(', ')}`)
  }
}
