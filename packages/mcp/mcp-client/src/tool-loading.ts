/**
 * On-demand tool loading for one MCP server: the server's tools stay out of the
 * tool registry, a system prompt section lists them, and the server's loader
 * tool registers the selected ones in the calling agent's own scope.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { truncateWithoutSplittingSurrogatePair } from '@deepseek-ai/dsh-output-retention'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { McpToolRegistrar } from './status.ts'
import { publicToolName } from './tools.ts'

/** Raw name of the loader tool inside the server's `mcp__<serverName>__` namespace. */
export const LOADER_RAW_NAME = 'load_tools'

/** One agent's loaded tools from this server. */
interface AgentLoads {
  readonly scope: Scope
  /** Raw names this agent loaded; a name stays loaded while the server offers it. */
  readonly names: Set<string>
  /** Live registrations by raw name; empty while no generation is published. */
  readonly registered: Map<string, () => void>
}

/**
 * Owns one on-demand server's loader tool, its prompt catalog, and each agent's
 * loaded tools. A published generation registers the loader and re-registers
 * every agent's loaded tools that the generation still offers.
 */
export class McpToolLoader {
  /** Model-facing name of this server's loader tool. */
  readonly name: string
  private readonly tool: ToolDefinition
  /** The published generation's tools by raw name; empty while none is published. */
  private offered: ReadonlyMap<string, ToolDefinition> = new Map()
  private readonly loads = new Map<Agent, AgentLoads>()

  /**
   * Define the loader and release each agent's loaded tools with the agent.
   * @param ctx - the server plugin's context; it owns the loader and the agents' scopes.
   * @param serverName - the server's tool namespace.
   * @param descriptionMaxLength - maximum characters of each tool's catalog summary.
   * @param registrar - registers the loader tool and loaded tools for the instance's status handle.
   */
  constructor(
    private readonly ctx: Context,
    private readonly serverName: string,
    private readonly descriptionMaxLength: number,
    private readonly registrar: McpToolRegistrar,
  ) {
    this.name = publicToolName(serverName, LOADER_RAW_NAME)
    this.tool = defineTool({
      name: this.name,
      description: `Add tools from MCP server ${serverName} to your tool list. The system prompt lists them under "On-demand tools from MCP server ${serverName}".`,
      guidance: { section: `mcp:${serverName}:tools`, order: 'MCP_SERVERS', text: () => this.catalog() },
      parameters: {
        tools: { type: 'array', required: true, items: { type: 'string' }, description: 'Tool names exactly as that list shows them.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      // The executor turns a synchronous validation failure into a rejected call.
      execute: (args, exec) => new Promise((resolve) => { resolve(this.load(args.tools, exec.agent)) }),
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const loads = this.loads.get(agent)
      this.loads.delete(agent)
      // Cordis contains disposal failures, and this plugin's unload awaits a disposal still in flight.
      void loads?.scope.dispose()
    })
  }

  /** Number of tools the published generation offers. */
  get size(): number {
    return this.offered.size
  }

  /**
   * Publish one generation: register the loader, then re-register each agent's loaded tools the generation still offers.
   * @param tools - the generation's tool definitions by raw name, without a tool named like the loader.
   * @returns the withdrawal, which unregisters the loader and the loaded tools while keeping the loaded names for the next generation.
   * @throws when the loader name is already registered; nothing is published then.
   */
  publish(tools: ReadonlyMap<string, ToolDefinition>): () => void {
    const unregister = this.registrar.register(this.ctx, this.tool)
    this.offered = tools
    for (const loads of this.loads.values()) {
      for (const name of loads.names) {
        const definition = tools.get(name)
        if (definition === undefined) loads.names.delete(name)
        else this.register(loads, name, definition)
      }
    }
    return () => {
      unregister()
      this.offered = new Map()
      for (const loads of this.loads.values()) {
        for (const dispose of loads.registered.values()) dispose()
        loads.registered.clear()
      }
    }
  }

  /**
   * Render the system prompt catalog of the published generation, which registers the loader.
   * @returns the catalog, or an empty string when no generation is published.
   */
  catalog(): string {
    if (this.offered.size === 0) return ''
    const tools = [...this.offered].sort(([a], [b]) => a < b ? -1 : 1).map(([name, definition]) => {
      const summary = this.summary(definition.description)
      return summary === '' ? `- ${name}` : `- ${name}: ${summary}`
    })
    return [
      `### On-demand tools from MCP server ${this.serverName}`,
      `These tools are not in your tool list. Before calling one, load it with ${this.name}.`,
      tools.join('\n'),
    ].join('\n\n')
  }

  /** First description line with whitespace collapsed, capped at the configured length. */
  private summary(description: string): string {
    const [first = ''] = description.trim().split('\n', 1)
    const line = first.replaceAll(/\s+/g, ' ').trim()
    if (line.length <= this.descriptionMaxLength) return line
    return truncateWithoutSplittingSurrogatePair(line, this.descriptionMaxLength - 3) + '...'
  }

  /** Validate every requested name before registering any in the agent's own scope. */
  private load(requested: readonly string[], agent: Agent | undefined): string {
    if (agent === undefined) throw new Error(`${this.name} requires an agent`)
    if (requested.length === 0) throw new Error(`${this.name} requires at least one tool name`)
    const unknown = requested.filter(name => !this.offered.has(name))
    if (unknown.length > 0) {
      throw new Error(`MCP server ${this.serverName} does not offer ${unknown.map(name => `"${name}"`).join(', ')}; use names from its on-demand tool list`)
    }
    let loads = this.loads.get(agent)
    if (loads === undefined) {
      loads = { scope: createScope(this.ctx, agent), names: new Set(), registered: new Map() }
      this.loads.set(agent, loads)
    }
    const loaded: string[] = []
    const present: string[] = []
    for (const name of new Set(requested)) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- every requested name is offered
      const definition = this.offered.get(name)!
      if (loads.registered.has(name)) {
        present.push(definition.name)
        continue
      }
      loads.registered.set(name, this.registrar.register(loads.scope.ctx, definition))
      loads.names.add(name)
      loaded.push(definition.name)
    }
    return [
      ...loaded.length > 0 ? [`Loaded: ${loaded.join(', ')}.`] : [],
      ...present.length > 0 ? [`Already loaded: ${present.join(', ')}.`] : [],
    ].join('\n')
  }

  /** Register one loaded tool for one agent; a failure drops only that tool for that agent. */
  private register(loads: AgentLoads, name: string, definition: ToolDefinition): void {
    try {
      loads.registered.set(name, this.registrar.register(loads.scope.ctx, definition))
    } catch (error) {
      loads.names.delete(name)
      this.ctx.logger.error(`mcp-client(${this.serverName}): could not restore loaded tool "${name}" for an agent: ${String(error)}`)
    }
  }
}
