/** Decoding, JSON parsing, and format validation of a fetched index body; the parse Worker runs it. */
import { MarketIndexError, parseMarketIndex, type MarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

/** A validated index, or the JSON path, rule, and diagnostic of the first violation; `$` covers UTF-8 and JSON errors. */
export type IndexParseResult =
  | { readonly ok: true; readonly index: MarketIndex }
  | { readonly ok: false; readonly path: string; readonly reason: string; readonly message: string }

/** The request a parse Worker receives as `workerData`. */
export interface IndexParseRequest {
  readonly body: Uint8Array
  readonly url: string
}

/**
 * Decode a body as strict UTF-8, parse it as JSON, and validate it as format 1.
 * @param body - the complete response body.
 * @param url - the index URL relative icon references resolve against.
 * @returns the validated index, or the first violation.
 */
export function parseIndexBody(body: Uint8Array, url: string): IndexParseResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    // A fatal TextDecoder throws only for malformed UTF-8.
    return { ok: false, path: '$', reason: 'must be UTF-8', message: 'must be UTF-8' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const reason = `must be JSON: ${(error as Error).message}`
    return { ok: false, path: '$', reason, message: reason }
  }
  try {
    return { ok: true, index: parseMarketIndex(value, url) }
  } catch (error) {
    /* v8 ignore next -- parseMarketIndex throws nothing but its own validation failure */
    if (!(error instanceof MarketIndexError)) throw error
    return { ok: false, path: error.path, reason: error.reason, message: error.message }
  }
}
