/** Configuration for explicit MCP OAuth authorization. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** One server's credential identity and authorization budgets. */
export interface McpOAuthConfig {
  /** Stable `mcp-client/<id>` credential-record address, unique per managed entry. */
  credentialKey: string
  /** Pre-registered public client; omission enables explicit dynamic registration. */
  clientId?: string
  /** Requested scope; omission uses the server's challenge. */
  scope?: string
  /** Deadline for each authorization-server request, in milliseconds (default 10000). */
  requestTimeoutMs: number
  /** Deadline through the browser callback and token exchange, in milliseconds (default 600000). */
  authorizationTimeoutMs: number
}

/** Input before authorization budgets receive their defaults. */
export type McpOAuthConfigInput = Pick<McpOAuthConfig, 'credentialKey'> & Partial<Omit<McpOAuthConfig, 'credentialKey'>>

/** Validate explicit OAuth configuration and resolve its request and interaction budgets. */
export const OAuthSchema: z<McpOAuthConfigInput, McpOAuthConfig> = z.object({
  credentialKey: z.string().pattern(/^mcp-client\//).required(),
  clientId: z.string().pattern(/\S/),
  scope: z.string(),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
  authorizationTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
})
