/**
 * Tencent Docs plugin: registers Tencent Docs' hosted MCP server with the
 * shared MCP manager for this plugin's lifetime and tells the model to call it
 * the Tencent Docs plugin. The manager owns connection, OAuth authorization,
 * saved grants, and sign-out; once a grant exists, the server's
 * `mcp__tencent-docs__*` tools are listed in the system prompt and each agent
 * loads the ones it needs.
 * @module @deepseek-ai/dsh-tencent-docs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-mcp-manager'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tencent-docs'
export const inject = ['mcpServers', 'systemPrompt']

// One shared account per Host: a fixed server name keeps tool names stable and
// a fixed credential key lets a reinstalled plugin reuse its saved grant.
const SERVER_NAME = 'tencent-docs'
const CREDENTIAL_KEY = 'mcp-client/tencent-docs'
const GUIDANCE = 'Tools named `mcp__tencent-docs__*` come from the Tencent Docs plugin. In user-facing replies, call it the Tencent Docs plugin (腾讯文档插件 in Chinese), not MCP.'
  + ' If no `mcp__tencent-docs__*` tool appears in your tool list, Tencent Docs is not connected yet; ask the user to connect it on the Tencent Docs plugin page in Plugins.'

/** Tencent Docs MCP endpoint and tool loading for the managed server entry. */
export interface Config {
  /** Streamable HTTP MCP endpoint; defaults to Tencent Docs' hosted server. */
  url: string
  /** `on-demand` (default) keeps Tencent Docs' tools hidden from each agent until it loads them; `eager` sends all of them. */
  toolLoading: 'eager' | 'on-demand'
}

/* jscpd:ignore-start -- sibling connector plugins declare their MCP server and naming guidance through the same calls. */
/** Runtime configuration schema for the Tencent Docs plugin. */
export const Config: z<Partial<Config>, Config> = z.object({
  url: z.string().default('https://docs.qq.com/openapi/mcp'),
  toolLoading: z.union(['eager', 'on-demand']).default('on-demand'),
})

/**
 * Register the Tencent Docs server and its naming guidance; both are withdrawn when the plugin unloads.
 * @param ctx - Context carrying the MCP manager and system prompt.
 * @param config - Tencent Docs endpoint and tool loading.
 * @throws when another configured or registered server already uses the `tencent-docs` name or credential key.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.mcpServers.register(SERVER_NAME, {
    transport: 'streamable-http',
    url: config.url,
    oauth: { credentialKey: CREDENTIAL_KEY },
    toolLoading: config.toolLoading,
  })
  // Sections at one order sort by name, so `tencent-docs` follows every `mcp…` server section.
  ctx.systemPrompt.section({
    name: SERVER_NAME,
    order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
    text: GUIDANCE,
  })
}
/* jscpd:ignore-end */
