/** Tools that a provider adds to individual Agents as their state changes. @module */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from './contracts.ts'
import { NativeToolRegistry } from './native-registry.ts'

/**
 * Registry whose tools each Agent sees only after the provider adds them for
 * that Agent. Include it once in the provider's scope with
 * `ctx.tools.include()`: Agents then inherit their added tools, so their
 * restrictions still apply. The unscoped view lists every registered tool, so
 * restrictions and tool order can name a tool before an Agent sees it, and
 * catalogs list it. A call without an Agent resolves that view and reaches
 * the tool, so a tool that needs an Agent checks `exec.agent`.
 */
export class AgentToolRegistry extends NativeToolRegistry {
  private readonly added = new WeakMap<ScopeKey, ReadonlySet<string>>()

  constructor() {
    super('an Agent tool registry')
  }

  override get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    if (scope !== undefined && this.added.get(scope)?.has(name) !== true) return undefined
    return super.get(name, scope)
  }

  override getAll(scope?: ScopeKey): readonly ToolDefinition[] {
    const all = super.getAll(scope)
    if (scope === undefined) return all
    const names = this.added.get(scope)
    return names === undefined ? [] : all.filter(tool => names.has(tool.name))
  }

  /**
   * Replace the registered tools one Agent sees. Other Agents, including the
   * Agent's descendants, keep their own sets; disposing the Agent drops its set.
   * @param agent - exact Agent whose set changes.
   * @param names - registered tool names to show; an empty list hides every tool.
   * @throws Error when a name is not registered here.
   */
  set(agent: Agent, names: readonly string[]): void {
    const registered = new Set(super.getAll(agent).map(tool => tool.name))
    const unknown = names.filter(name => !registered.has(name))
    if (unknown.length > 0) {
      throw new Error(`cannot add unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')} to an Agent`)
    }
    this.added.set(agent, new Set(names))
  }
}
