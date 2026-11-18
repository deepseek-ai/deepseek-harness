/**
 * Linear plugin: registers Linear's hosted MCP server with the shared MCP
 * manager for this plugin's lifetime, tells the model to call it the Linear
 * plugin, and shows the account on the Plugins page while the account registry
 * runs. The manager owns connection, OAuth authorization, saved grants, and
 * sign-out; once a grant exists, the server's `mcp__linear__*` tools are
 * listed in the system prompt and each agent loads the ones it needs.
 * @module @deepseek-ai/dsh-linear
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-mcp-account'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { COPY } from './locales.ts'

export const name = 'linear'
export const inject = ['mcpManager', 'systemPrompt']

// One shared account per Host: a fixed server name keeps tool names stable and
// a fixed credential key lets a reinstalled plugin reuse its saved grant.
const SERVER_NAME = 'linear'
const CREDENTIAL_KEY = 'mcp-client/linear'
const GUIDANCE = 'Tools named `mcp__linear__*` come from the Linear plugin. In user-facing replies, call it the Linear plugin (Linear 插件 in Chinese), not MCP.'
  + ' If no `mcp__linear__*` tool appears in your tool list, Linear is not connected yet; ask the user to connect it on the Linear plugin page in Plugins.'

/** Linear MCP endpoint and tool loading for the managed server entry. */
export interface Config {
  /** Streamable HTTP MCP endpoint; defaults to Linear's hosted server. */
  url: string
  /** `on-demand` (default) keeps Linear's tools hidden from each agent until it loads them; `eager` sends all of them. */
  toolLoading: 'eager' | 'on-demand'
}

/* jscpd:ignore-start -- deliberate twin of dsh-notion and dsh-tencent-docs: the same MCP server and guidance registrations. */
/** Runtime configuration schema for the Linear plugin. */
export const Config: z<Partial<Config>, Config> = z.object({
  url: z.string().default('https://mcp.linear.app/mcp'),
  toolLoading: z.union(['eager', 'on-demand']).default('on-demand'),
})

/**
 * Register the Linear server, its naming guidance, and, while the account registry runs, its Plugins page account; all
 * are withdrawn when the plugin unloads.
 * @param ctx - Context carrying the MCP manager and system prompt.
 * @param config - Linear endpoint and tool loading.
 * @throws when another configured or registered server already uses the `linear` name or credential key.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.mcpManager.register(SERVER_NAME, {
    transport: 'streamable-http',
    url: config.url,
    oauth: { credentialKey: CREDENTIAL_KEY },
    toolLoading: config.toolLoading,
  })
  // Sections at one order sort by name, so `linear` precedes every `mcp…` server section.
  ctx.systemPrompt.section({
    name: SERVER_NAME,
    order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
    text: GUIDANCE,
  })
  ctx.inject(['mcpAccounts'], (scope) => {
    scope.effect(() => scope.mcpAccounts.register({ server: SERVER_NAME, packageName: '@deepseek-ai/dsh-linear', copy: COPY }), 'linear: Plugins page account')
  })
}
/* jscpd:ignore-end */
