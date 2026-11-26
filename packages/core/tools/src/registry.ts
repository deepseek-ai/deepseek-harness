/** Composable tool registries and the batches `ctx.tools.execute()` runs. @module */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolCallBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolExecutionResult } from './contracts.ts'
import type { ToolStep } from './step.ts'

/**
 * A set of directly callable entries. Native registries expose their tools as
 * entries; a PTC registry exposes one program entry and calls its other tools
 * from programs. Registrations and inclusions return their exact disposers.
 * `ctx.tools.execute()` runs the entries of the selected root, so a registry
 * owns no batch execution of its entries.
 */
export interface ToolRegistry {
  /**
   * Add one tool. A registry without scopes ignores the caller's scope.
   * @param tool - validated definition; duplicate names in the same place fail.
   * @returns the disposer that removes exactly this registration.
   */
  register(tool: ToolDefinition): () => void
  /**
   * Read another registry's entries at every query. The source keeps ownership
   * of its definitions; its later additions and removals appear in the next query.
   * @param registry - source whose `get()` and `getAll()` entries this registry includes.
   * @returns the disposer that removes exactly this inclusion.
   */
  include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void
  /**
   * Resolve one entry as a scope sees it.
   * @param name - entry name.
   * @param scope - viewing Agent or preset; omission selects the unscoped view.
   * @returns the entry, or undefined when the scope has none with that name.
   * @throws ToolCompositionError when the deciding scope has several candidates for the name or an inclusion cycles.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined
  /**
   * List the entries a scope sees. A registry lists every definition of a name
   * that has several, so a registry that includes it decides that name in its
   * own place. `get()` throws for such a name; `ctx.tools.getAll()` resolves
   * its root's listing and throws when a name still has several.
   * @param scope - viewing Agent or preset; omission selects the unscoped view.
   * @returns entries in registration order.
   * @throws ToolCompositionError when an inclusion cycles, or, for `ctx.tools`, when a name has several definitions.
   */
  getAll(scope?: ScopeKey): readonly ToolDefinition[]
}

/** Raw model calls, with optional Agent ownership and model-step logging. */
export interface ToolBatchInput {
  readonly calls: readonly ToolCallBlock[]
  readonly signal: AbortSignal
  /**
   * Positive integer limiting how many concurrency-safe calls of this batch run
   * at once; program call limits remain separate. Undefined allows
   * `DEFAULT_MAX_PARALLEL_TOOL_CALLS` from `@deepseek-ai/dsh-tools/pipeline`.
   */
  readonly maxParallelToolCalls?: number
  /**
   * Owning Agent supplies scoped tools and execution context, including outside a turn.
   * Undefined for standalone calls outside an Agent, such as a service invocation.
   */
  readonly agent?: Agent
  /**
   * Model step whose declarations admit the calls, including program calls.
   * A call whose current entry differs from the declared one fails as `UNKNOWN_TOOL`.
   * Undefined resolves the root's current entries.
   */
  readonly toolStep?: ToolStep
  /**
   * Committed model step receiving root call/result events; requires `agent`.
   * Undefined when `agent` is absent or for calls outside a model response, such
   * as session initialization hooks. Without `log`, root call/result events are
   * omitted while `agent`, when provided, still supplies scope and execution context.
   */
  readonly log?: {
    readonly turn: number
    readonly step: number
  }
}

/** One settled result correlated with its original model call. */
export interface ToolCallResult {
  readonly callId: ToolCallId
  readonly result: ToolExecutionResult
}

/** Model-ordered outcomes and context accepted for the next step. */
export interface ToolBatchResult {
  readonly results: readonly ToolCallResult[]
  readonly additionalContexts: readonly UserMessage[]
  readonly concluded: boolean
}

/** A drained batch failed internally; only the included results are committed. */
export class ToolBatchExecutionError extends Error {
  constructor(cause: unknown, readonly partial: ToolBatchResult) {
    super('Tool batch execution failed', { cause })
    this.name = 'ToolBatchExecutionError'
  }
}

/** The selected root registry is missing or unloaded; another registry must not take its calls. */
export class ToolRegistryUnavailableError extends HarnessError {
  constructor() {
    super('The selected tool registry is unavailable. Load a native or PTC tool registry in this composition before running the agent.', 'TOOL_REGISTRY_UNAVAILABLE')
    this.name = 'ToolRegistryUnavailableError'
  }
}
