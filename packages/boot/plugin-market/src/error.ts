/** Typed `plugin_market` tool failures converted from the market service's Remote failures. */

import { HarnessError } from '@deepseek-ai/dsh-error'
import { remoteErrorOf, type RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Every {@link PluginMarketError} code:
 * - `PLUGIN_MARKET_INDEX_NOT_FOUND`: the URL is not a configured index source; call `list_indexes`.
 * - `PLUGIN_MARKET_INVALID_INDEX_URL`: a configured index URL is invalid; only the user can fix the source.
 * - `PLUGIN_MARKET_FETCH_FAILED`: the index could not be fetched (network, timeout, redirect, status, or size).
 * - `PLUGIN_MARKET_INVALID_INDEX`: the fetched index document is invalid.
 * - `PLUGIN_MARKET_INVALID_QUERY`: a query field is out of range.
 * - `PLUGIN_MARKET_SETTINGS_UNAVAILABLE`: index sources cannot be saved in this composition.
 * - `PLUGIN_MARKET_PLUGIN_NOT_FOUND`: the index lists no such plugin or version.
 * - `PLUGIN_MARKET_DETAIL_UNAVAILABLE`: a plugin's detail document cannot be read.
 * - `PLUGIN_MARKET_FAILED`: any other market failure; `cause` is the original error.
 */
export const PLUGIN_MARKET_ERROR_CODES = [
  'PLUGIN_MARKET_INDEX_NOT_FOUND',
  'PLUGIN_MARKET_INVALID_INDEX_URL',
  'PLUGIN_MARKET_FETCH_FAILED',
  'PLUGIN_MARKET_INVALID_INDEX',
  'PLUGIN_MARKET_INVALID_QUERY',
  'PLUGIN_MARKET_SETTINGS_UNAVAILABLE',
  'PLUGIN_MARKET_PLUGIN_NOT_FOUND',
  'PLUGIN_MARKET_DETAIL_UNAVAILABLE',
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

/** Remote failure codes the market service declares. */
type MarketRemoteCode = Extract<RemoteErrorCode, `plugin-market/${string}`>

/** Tool code for each market Remote failure code. */
const REMOTE_CODES: Readonly<Record<MarketRemoteCode, PluginMarketErrorCode>> = {
  'plugin-market/unknown-index': 'PLUGIN_MARKET_INDEX_NOT_FOUND',
  'plugin-market/invalid-index-url': 'PLUGIN_MARKET_INVALID_INDEX_URL',
  'plugin-market/fetch-failed': 'PLUGIN_MARKET_FETCH_FAILED',
  'plugin-market/invalid-index': 'PLUGIN_MARKET_INVALID_INDEX',
  'plugin-market/invalid-query': 'PLUGIN_MARKET_INVALID_QUERY',
  'plugin-market/settings-unavailable': 'PLUGIN_MARKET_SETTINGS_UNAVAILABLE',
  'plugin-market/unknown-plugin': 'PLUGIN_MARKET_PLUGIN_NOT_FOUND',
  'plugin-market/detail-unavailable': 'PLUGIN_MARKET_DETAIL_UNAVAILABLE',
}

/**
 * Convert a market failure for the tool registry. A `HarnessError` keeps its
 * identity; a market `RemoteError` keeps its message and becomes the matching
 * code with the Remote failure as `cause`; anything else is `PLUGIN_MARKET_FAILED`.
 * @param error - the rejection of a market service call.
 * @returns the failure to throw from the tool body.
 */
export function pluginMarketToolError(error: unknown): HarnessError {
  if (error instanceof HarnessError) return error
  const remote = remoteErrorOf(error)
  const code = remote !== undefined && Object.hasOwn(REMOTE_CODES, remote.code)
    ? REMOTE_CODES[remote.code as MarketRemoteCode]
    : 'PLUGIN_MARKET_FAILED'
  const message = remote?.message ?? (error instanceof Error ? error.message : String(error))
  return new PluginMarketError(message, code, { cause: error })
}
