/**
 * Schemas of the two server configuration shapes. The entry composes them into its `Config`, and the host resolves a
 * server configuration through its transport's schema, so a failure names the offending field instead of the whole union.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_MAX_INSTRUCTION_BYTES, RECONNECT_DEFAULTS } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
import { OAuthSchema } from './oauth-options.ts'
import type { McpOAuthConfigInput } from './oauth-options.ts'
import type { Config, StdioConfig, StreamableHttpConfig } from './index.ts'

/** Default timeout for individual MCP tool calls and resource requests (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Default budget for transport closure and local cleanup (ms). */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000

/** Default cap on each tool summary in an on-demand server's prompt catalog. */
const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 160

/** Valid `serverName`, kept below the public tool-name budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** {@link StdioConfig} before defaults. */
type StdioConfigInput = Omit<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates' | 'toolLoading' | 'catalogDescriptionMaxLength'>
  & Partial<Pick<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates' | 'toolLoading' | 'catalogDescriptionMaxLength'>>

/** {@link StreamableHttpConfig} before defaults. */
type StreamableHttpConfigInput = Omit<StreamableHttpConfig, 'oauth' | 'headers' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates' | 'toolLoading' | 'catalogDescriptionMaxLength'>
  & Partial<Pick<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates' | 'toolLoading' | 'catalogDescriptionMaxLength'>>
  & { oauth?: McpOAuthConfigInput }

/** One server's configuration before defaults. */
export type ConfigInput = StdioConfigInput | StreamableHttpConfigInput

/** Reconnect-policy section schema shared by both transports. */
export const ReconnectSchema: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

/* jscpd:ignore-start */
// The catalog generator statically walks these literals and rejects spreads and
// computed keys, so the transports restate their shared rows by construction.

/** Schema of {@link StdioConfig}. */
export const StdioSchema = z.object({
  transport: z.const('stdio'),
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CLOSE_TIMEOUT_MS),
  expandTemplates: z.boolean().default(false),
  failOnStartupError: z.boolean().default(false),
  maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
  reconnect: ReconnectSchema,
  toolLoading: z.union(['eager', 'on-demand']).default('eager'),
  catalogDescriptionMaxLength: z.natural().min(4).default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
}) as z<StdioConfigInput, StdioConfig>

/** Schema of {@link StreamableHttpConfig}. */
export const StreamableHttpSchema = z.object({
  transport: z.const('streamable-http'),
  oauth: z.union([z.const(undefined), OAuthSchema]),
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  url: z.string().required(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
  closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CLOSE_TIMEOUT_MS),
  expandTemplates: z.boolean().default(false),
  failOnStartupError: z.boolean().default(false),
  maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
  reconnect: ReconnectSchema,
  toolLoading: z.union(['eager', 'on-demand']).default('eager'),
  catalogDescriptionMaxLength: z.natural().min(4).default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
}) as z<StreamableHttpConfigInput, StreamableHttpConfig>
/* jscpd:ignore-end */

/**
 * Whether a server configures OAuth beside its own Authorization header, which an instance refuses.
 * @param config - resolved server configuration.
 * @returns true for an OAuth server whose headers include `Authorization` in any letter case.
 */
export function hasOAuthWithAuthorizationHeader(config: Config): boolean {
  return config.transport === 'streamable-http' && config.oauth !== undefined
    && Object.keys(config.headers).some(name => name.toLowerCase() === 'authorization')
}
