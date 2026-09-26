/** DeepSeek Files API identifiers. @module dsh-llm-deepseek/file-id */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier returned by the DeepSeek Files API. */
export type DeepSeekFileId = Branded<'DeepSeekFileId'>

/**
 * Brand a provider-returned file identifier after wire validation.
 * @param id - non-empty Files API identifier.
 * @returns the same string with its provider identity attached at type level.
 */
export function DeepSeekFileId(id: string): DeepSeekFileId {
  return id as DeepSeekFileId
}

/** Non-secret digest identifying one endpoint and API-key file namespace. */
export type DeepSeekFileScope = Branded<'DeepSeekFileScope'>

/**
 * Brand a locally derived namespace digest.
 * @param scope - SHA-256 digest of endpoint and API key.
 * @returns the same string with namespace identity attached at type level.
 */
export function DeepSeekFileScope(scope: string): DeepSeekFileScope {
  return scope as DeepSeekFileScope
}
