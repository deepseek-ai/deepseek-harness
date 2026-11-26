/** Session-owned MCP browser processes and provider catalog activation. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/types'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { McpConnectionStatusHandle } from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { BrowserSessionError, SessionResources } from './index.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import { ToolContextUnavailableError, ToolRegistryUnavailableError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Browser launch settings shared by the MCP integrations. */
export interface BrowserMcpLaunchConfig {
  /** Launch a new isolated Chromium browser for each live Session. */
  mode: 'launch'
  /** Whether Chromium runs without a visible window; defaults to true. */
  headless: boolean
  /** Chromium executable; omission uses the upstream server's installation discovery. */
  executablePath?: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Attachment to an externally owned Chromium browser. */
export interface BrowserMcpAttachConfig {
  /** Exclusively attach one live Session to the configured browser. */
  mode: 'attach'
  /** HTTP(S) debugging URL or WS(S) browser debugging endpoint. */
  endpoint: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed launch or attachment choice for one MCP browser provider. */
export type BrowserMcpConfig = BrowserMcpLaunchConfig | BrowserMcpAttachConfig

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object({
    mode: Schema.const('launch').required(),
    headless: Schema.boolean().default(true),
    executablePath: Schema.string().pattern(/\S/u),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
  Schema.object({
    mode: Schema.const('attach').required(),
    endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/**
 * Reject an invalid debugging endpoint before acquiring provider or browser resources.
 * @param config - schema-validated browser selection.
 */
export function validateBrowserMcpConfig(config: BrowserMcpConfig): void {
  if (config.mode !== 'attach') return
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch (error) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL', { cause: error })
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL without whitespace')
  }
}

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity and MCP tool namespace. */
  name: string
  /** Whether another live Session must wait for the attached browser to be released. */
  exclusive: boolean
  /** Executable used to start the installed MCP server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  toolCallTimeoutMs?: number
}

interface ClientState {
  status: 'ready' | 'blocked'
  mask?: Scope
  /** The Agent's own MCP client, which records the browser tools it registered; absent while blocked. */
  client?: McpConnectionStatusHandle
}

/** One Agent's browser scope and the MCP client mounted in it. */
interface SessionClient {
  readonly scope: Scope
  readonly client: McpConnectionStatusHandle
}

/**
 * List the entries an Agent's root offers; without a selected root it offers none.
 * Under a PTC root these exclude the browser tools, which programs bind instead.
 * @param ctx - context reading the tool registry.
 * @param agent - viewing Agent.
 * @returns the root's entries for the Agent.
 */
function rootEntries(ctx: Context, agent: Agent): readonly ToolDefinition[] {
  try {
    return ctx.tools.getAll(agent)
  } catch (error: unknown) {
    if (error instanceof ToolRegistryUnavailableError) return []
    throw error
  }
}

/**
 * Await one MCP client during each future Agent's creation.
 * A busy attachment leaves that activation without browser tools; its other turns continue.
 * Calls are serialized per Session; unload closes every server before releasing registration.
 * @param ctx - provider context supplying browser use, Agents, tools, prompt assembly, and working directories.
 * @param options - provider identity, attachment exclusivity, and executable configuration.
 * @throws when the working-directory provider is absent, before browser resources are registered.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined) throw new Error(`${options.name}: browser MCP requires a working-directory provider`)
  let resources!: SessionResources<SessionClient>
  const clients = new Map<Agent, ClientState>()
  const toolPrefix = `mcp__${options.name}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  let stopping = false
  let refreshingMasks = false

  const refreshBlockedMasks = (): void => {
    if (stopping || refreshingMasks) return
    refreshingMasks = true
    try {
      for (const [agent, state] of clients) {
        if (state.status !== 'blocked') continue
        const inherited = rootEntries(ctx, agent).filter(tool => tool.name.startsWith(toolPrefix))
        if (inherited.length === 0) continue
        state.mask ??= createScope(ctx, agent)
        state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
      }
    } finally {
      refreshingMasks = false
    }
  }

  ctx.effect(function* () {
    yield ctx.browserUse.register(brandString<BrowserUseProviderName>(options.name))
    resources = new SessionResources(ctx, {
      label: options.name,
      exclusive: options.exclusive,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let cancellation: Promise<void> | undefined
        const cancel = (): void => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          // A descendant Agent runs only the browser tools its own client registered, never this Session's browser.
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix) || exec.agent === agent) return next()
            // A call that resolved no definition runs no browser tool; dispatch fails it as an unknown tool.
            if (exec.definition === undefined) return next()
            const caller = exec.agent
            /* v8 ignore next -- a scope-tagged listener receives only calls that name an Agent */
            const own = caller === undefined ? undefined : clients.get(caller)?.client
            if (own?.registers(exec.definition) === true) return next()
            throw new BrowserSessionError(`${options.name}: browser tool belongs to another Session`, 'BROWSER_FOREIGN_SESSION')
          })
          // A host per Agent mounts the client in the Agent's scope and reports the tools that client registered.
          const host = new McpClient.McpClientHost(scope.ctx.isolate('mcpClientHost'))
          const client = await host.mount(McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            cwd: await workingDirectory.ensure(agent, signal),
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          })).ready
          signal.throwIfAborted()
          return {
            value: { scope, client },
            close() {
              clients.delete(agent)
              return scope.dispose()
            },
          }
        } catch (error) {
          await (cancellation ?? scope.dispose())
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      stopping = true
      await resources.dispose()
      clients.clear()
    }
  }, `${options.name}.sessions`)
  ctx.on('agent/created', async ({ agent, signal }) => {
    const state: ClientState = { status: resources.available(agent) ? 'ready' : 'blocked' }
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    if (state.status === 'blocked') {
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    state.client = (await resources.get(agent, signal)).client
    clients.set(agent, state)
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined) throw new ToolContextUnavailableError(`${options.name}: browser tools require a calling Agent`)
    if (clients.get(agent)?.status !== 'ready') {
      throw new BrowserSessionError(`${options.name}: browser tool belongs to another Session`, 'BROWSER_FOREIGN_SESSION')
    }
    return resources.run(agent, exec.signal, async (_scope, combined) => {
      const original = exec.signal
      exec.signal = combined
      try {
        return await next()
      } finally {
        exec.signal = original
      }
    })
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || clients.get(agent)?.status === 'ready') return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${options.name}`) }
  })
}
