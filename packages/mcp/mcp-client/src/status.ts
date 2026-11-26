import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { McpCloseResult, McpConnectionStatus } from './types.ts'

/**
 * Connection status and cleanup results keyed by the owning Cordis Fiber.
 * The cell survives reloads of that Fiber and remains readable after final
 * disposal, which detaches existing observers.
 *
 * @module
 */

/** Read-and-observe handle over one instance's {@link McpConnectionStatus} and the tools it registered. */
export interface McpConnectionStatusHandle {
  /**
   * The current status.
   * @returns the latest status the supervisor published.
   */
  current(): McpConnectionStatus
  /**
   * The latest generation's cleanup result, independent of connection status.
   * @returns unconfirmed while a generation is open, or its recorded cleanup result.
   */
  closure(): McpCloseResult
  /**
   * Observe status transitions. Callbacks run synchronously in publish order;
   * a throwing callback is contained and logged without affecting the
   * supervisor or other callbacks.
   * @param callback - invoked with each published status.
   * @returns the disposer removing this observer.
   */
  onChange(callback: (status: McpConnectionStatus) => void | Promise<void>): () => void
  /**
   * Whether this instance currently has one tool definition registered: a tool
   * of its current generation or, with on-demand loading, its loader tool or a
   * tool an Agent loaded. A generation swap, reconnection, or unload withdraws
   * the earlier definitions.
   * @param definition - tool definition to look up by identity.
   * @returns whether the definition is one of this instance's live registrations.
   */
  registers(definition: ToolDefinition): boolean
}

/** Registers tool definitions on behalf of one instance and records them while they stay registered. */
export interface McpToolRegistrar {
  /**
   * Register one definition through a context's tool registry.
   * @param ctx - context whose `ctx.tools` receives the registration.
   * @param definition - tool definition to register.
   * @returns the disposer that unregisters the definition and stops recording it.
   */
  register(ctx: Context, definition: ToolDefinition): () => void
}

/** Writable status cell retained across supervisors on the same Fiber. */
export class McpStatusCell implements McpConnectionStatusHandle, McpToolRegistrar {
  private value: McpConnectionStatus = { state: 'connecting', attempt: 0 }
  private closeResult: McpCloseResult = { closeConfirmed: true }
  /** Live registrations by definition; on-demand loading registers one definition once per loading Agent. */
  private readonly registrations = new Map<ToolDefinition, Set<object>>()

  registers(definition: ToolDefinition): boolean {
    return this.registrations.has(definition)
  }

  register(ctx: Context, definition: ToolDefinition): () => void {
    const registrations = this.registrations
    // The record shares the registration's effect, so disposing the context's Fiber also ends it.
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
    return ctx.effect(function* () {
      yield ctx.tools.register(definition)
      const registration = {}
      let live = registrations.get(definition)
      if (live === undefined) {
        live = new Set()
        registrations.set(definition, live)
      }
      live.add(registration)
      const own = live
      yield () => {
        own.delete(registration)
        if (own.size === 0) registrations.delete(definition)
      }
    }, 'mcp-client: tool registration')
  }

  closure(): McpCloseResult { return this.closeResult }

  /** Mark the next generation's closure as unconfirmed. */
  opened(): void { this.closeResult = { closeConfirmed: false } }

  /**
   * Record cleanup without publishing a connection-status transition.
   * @param result - independently observed transport and local cleanup outcome.
   */
  recordClosure(result: McpCloseResult): void { this.closeResult = result }

  /** Remove existing observers without discarding the readable status or cleanup result. */
  detach(): void { this.listeners.clear() }
  // Stored with an unknown return: dispatch inspects the returned value for
  // a promise to contain, which a void-typed call expression cannot express.
  private readonly listeners = new Set<(status: McpConnectionStatus) => unknown>()

  /**
   * @param warn - contained-listener diagnostic sink (the owning plugin's logger).
   */
  constructor(private warn: (message: string, error: unknown) => void) {}

  /**
   * Associate observer diagnostics with the Fiber's current supervisor.
   * @param warn - contained-listener diagnostic sink.
   */
  setWarningSink(warn: (message: string, error: unknown) => void): void { this.warn = warn }

  /**
   * The current status.
   * @returns the latest published status.
   */
  current(): McpConnectionStatus {
    return this.value
  }

  /**
   * Observe status transitions; see {@link McpConnectionStatusHandle.onChange}.
   * @param callback - invoked with each published status.
   * @returns the disposer removing this observer.
   */
  onChange(callback: (status: McpConnectionStatus) => void | Promise<void>): () => void {
    this.listeners.add(callback)
    return () => void this.listeners.delete(callback)
  }

  /**
   * Publish the next status and notify observers. A throwing observer is
   * contained so a broken consumer cannot wedge the supervisor's transition.
   * @param next - the status to publish.
   */
  update(next: McpConnectionStatus): void {
    this.value = next
    for (const listener of [...this.listeners]) {
      try {
        // An async observer's rejection must land in the same containment as
        // a sync throw; the callback type admits it explicitly.
        const returned = listener(next)
        if (typeof (returned as PromiseLike<unknown> | undefined)?.then === 'function') {
          void Promise.resolve(returned).catch((error: unknown) => {
            this.warn('an onChange status observer failed', error)
          })
        }
      } catch (error) {
        this.warn('an onChange status observer failed', error)
      }
    }
  }
}

const cellsByFiber = new WeakMap<Fiber, McpStatusCell>()

/**
 * Create or reuse a Fiber's status cell without discarding prior cleanup results.
 * @param fiber - the actual plugin Fiber owning the supervisor.
 * @param warn - diagnostic sink for observer failures.
 * @returns the stable writable cell for this Fiber.
 */
export function registerStatusCell(fiber: Fiber, warn: (message: string, error: unknown) => void): McpStatusCell {
  let cell = cellsByFiber.get(fiber)
  if (cell === undefined) {
    cell = new McpStatusCell(warn)
    cellsByFiber.set(fiber, cell)
  } else cell.setWarningSink(warn)
  return cell
}

/**
 * Look up status through an actual Fiber or the handle returned by `ctx.plugin()`.
 * @param fiber - plugin Fiber or its thenable handle.
 * @returns the retained cell, or `undefined` before the MCP instance registers one.
 */
export function connectionStatusIn(fiber: Fiber): McpConnectionStatusHandle | undefined {
  return cellsByFiber.get(fiber.ctx.fiber)
}
