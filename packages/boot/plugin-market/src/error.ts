/** Typed `plugin_market` tool failures converted from the market service's Remote failures. */

import { HarnessError } from '@deepseek-ai/dsh-error'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Every {@link PluginMarketError} code:
 * - `PLUGIN_MARKET_INDEX_NOT_FOUND`: the URL is not a configured index source; call `list_indexes`.
 * - `PLUGIN_MARKET_INVALID_INDEX_URL`: a configured index URL is invalid; only the user can fix the source.
 * - `PLUGIN_MARKET_FETCH_FAILED`: the index could not be fetched (network, timeout, redirect, status, or size).
 * - `PLUGIN_MARKET_INVALID_INDEX`: the fetched index document is invalid.
 * - `PLUGIN_MARKET_PLUGIN_NOT_FOUND`: the index lists no plugin with the requested name.
 * - `PLUGIN_MARKET_FAILED`: any other market failure; `cause` is the original error.
 */
export const PLUGIN_MARKET_ERROR_CODES = [
  'PLUGIN_MARKET_INDEX_NOT_FOUND',
  'PLUGIN_MARKET_INVALID_INDEX_URL',
  'PLUGIN_MARKET_FETCH_FAILED',
  'PLUGIN_MARKET_INVALID_INDEX',
  'PLUGIN_MARKET_PLUGIN_NOT_FOUND',
  'PLUGIN_MARKET_FAILED',
] as const

/** One {@link PluginMarketError} code. */
export type PluginMarketErrorCode = typeof PLUGIN_MARKET_ERROR_CODES[number]

/** Typed `plugin_market` failure; `code` is one of {@link PLUGIN_MARKET_ERROR_CODES}. */
export class PluginMarketError extends HarnessError {
  override readonly code: PluginMarketErrorCode

  constructor(message: string, code: PluginMarketErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PluginMarketError'
    this.code = code
  }
}

/**
 * Remote failure codes `search` and `entry` reject with for a query the tool already validated;
 * `invalid-query` cannot occur because the tool checks the same page bounds first.
 */
type ToolRemoteCode = Extract<RemoteErrorCode,
  'plugin-market/unknown-index' | 'plugin-market/invalid-index-url' | 'plugin-market/fetch-failed' | 'plugin-market/invalid-index'>

/** Tool code for each Remote failure code the tool's market reads can reject with. */
const REMOTE_CODES: Readonly<Record<ToolRemoteCode, PluginMarketErrorCode>> = {
  'plugin-market/unknown-index': 'PLUGIN_MARKET_INDEX_NOT_FOUND',
  'plugin-market/invalid-index-url': 'PLUGIN_MARKET_INVALID_INDEX_URL',
  'plugin-market/fetch-failed': 'PLUGIN_MARKET_FETCH_FAILED',
  'plugin-market/invalid-index': 'PLUGIN_MARKET_INVALID_INDEX',
}

/**
 * Convert a market failure for the tool registry. A market `RemoteError` with
 * one of the codes `search` and `entry` reject with keeps its message and
 * becomes the matching code with the Remote failure as `cause`; any other
 * `HarnessError` keeps its identity; anything else is `PLUGIN_MARKET_FAILED`.
 * @param error - the rejection of a market service call.
 * @returns the failure to throw from the tool body.
 */
export function pluginMarketToolError(error: unknown): HarnessError {
  if (error instanceof HarnessError) {
    if (!Object.hasOwn(REMOTE_CODES, error.code)) return error
    return new PluginMarketError(error.message, REMOTE_CODES[error.code as ToolRemoteCode], { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new PluginMarketError(message, 'PLUGIN_MARKET_FAILED', { cause: error })
}
