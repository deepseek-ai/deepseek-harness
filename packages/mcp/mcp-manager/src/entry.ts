/**
 * The fields of one managed server and the schema that resolves their defaults. The manager resolves every
 * `servers` entry and every registration through the schema, and the server row builds its `Config` from the
 * schema's fields.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { McpOAuthConfigInput, ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'

/**
 * One managed server entry. Deliberately flat rather than a per-transport
 * union: the manager's write-time validation owns the per-transport field
 * rules, and its refusals name the offending field where a union's shape error
 * would not.
 */
export interface McpManagedServerEntry {
  /** Optional OAuth configuration; each entry owns a distinct stable credential key, and the MCP client host resolves the rest. */
  oauth?: McpOAuthConfigInput
  /** Which transport the instance uses. */
  transport: 'stdio' | 'streamable-http'
  /** stdio: executable used to start the server; `''` while unset. */
  command: string
  /** stdio: arguments passed without shell interpolation. */
  args: string[]
  /** stdio: extra child environment; values may use `${credential:…}` templates. */
  env: Record<string, string>
  /** stdio: working directory for the child process. */
  cwd: string
  /** streamable-http: MCP endpoint URL; `''` while unset. */
  url: string
  /** streamable-http: extra request headers; values may use templates. */
  headers: Record<string, string>
  /** Durable intent: whether the entry asks for a running instance. */
  enabled: boolean
  /** Per-tool-call timeout override in milliseconds; omission uses the mcp-client default. */
  toolCallTimeoutMs?: number
  /** Per-attempt startup budget in milliseconds; the manager schema defaults to 30000. */
  startupTimeoutMs: number
  /** Cleanup budget override in milliseconds; omission uses the mcp-client default. */
  closeTimeoutMs?: number
  /** Reconnect policy; the MCP client host validates it, and omission uses the mcp-client defaults. */
  reconnect?: ReconnectConfig
  /** `on-demand` keeps the server's tools out of every tool list until an agent loads them; default `eager`. */
  toolLoading: 'eager' | 'on-demand'
}

/** Entry fields the schema defaults. */
type DefaultedField = 'command' | 'url' | 'args' | 'env' | 'cwd' | 'headers' | 'enabled' | 'startupTimeoutMs' | 'toolLoading'

type EntryInput = Omit<McpManagedServerEntry, DefaultedField> & Partial<Pick<McpManagedServerEntry, DefaultedField>>

/** One server a plugin contributes for its own lifetime; it is enabled while registered. */
export type McpServerRegistration = Omit<EntryInput, 'enabled'>

/**
 * Schema of {@link McpManagedServerEntry}. `oauth` and `reconnect` pass through unresolved: the MCP client host
 * owns their fields, defaults, and bounds, and validates them with the rest of the client configuration.
 */
export const ServerEntrySchema = z.object({
  oauth: z.any(),
  transport: z.union(['stdio', 'streamable-http']).required(),
  command: z.string().default(''),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  url: z.string().default(''),
  headers: z.dict(String).default({}),
  enabled: z.boolean().default(true),
  toolCallTimeoutMs: z.number(),
  startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  reconnect: z.any(),
  toolLoading: z.union(['eager', 'on-demand']).default('eager'),
}) as z<EntryInput, McpManagedServerEntry>
