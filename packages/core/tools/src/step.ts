/** Entries one model step declared, shared by its direct calls and program calls. @module */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from './contracts.ts'
import type { ToolRegistry } from './registry.ts'
import { resolveToolList } from './entries.ts'

/**
 * The root entries one model step declares to its model. Calls from that step
 * execute only the exact declared entries; a PTC registry also pins the
 * program bindings it declared for the step. Additions and replacements made
 * while the model responds take effect in the next step; a declared tool that
 * is removed or withdrawn for the Agent fails the step's unstarted calls as
 * `UNKNOWN_TOOL`.
 */
export class ToolStep {
  private readonly entries: ReadonlyMap<string, ToolDefinition>

  private constructor(readonly agent: Agent, declarations: readonly ToolDefinition[]) {
    this.entries = new Map(declarations.map(definition => [definition.name, definition]))
  }

  /**
   * Capture the entries a registry offers an Agent now; `ctx.tools` answers from the Agent's selected root.
   * @param tools - registry whose entries the step declares.
   * @param agent - Agent whose model step this is.
   * @returns the captured step.
   * @throws ToolRegistryUnavailableError when `ctx.tools` has no available root for the Agent.
   * @throws ToolCompositionError when the registry offers several definitions under one name.
   */
  static capture(tools: Pick<ToolRegistry, 'getAll'>, agent: Agent): ToolStep {
    return new ToolStep(agent, resolveToolList(tools.getAll(agent)))
  }

  /** Declared root entries in declaration order. */
  get declarations(): readonly ToolDefinition[] {
    return [...this.entries.values()]
  }

  /**
   * Test whether this step declared one exact entry.
   * @param definition - entry resolved by a registry.
   * @returns whether the step declared this definition under its name.
   */
  declares(definition: ToolDefinition): boolean {
    return this.entries.get(definition.name) === definition
  }
}
