/** Deterministic serialization of credential headers for credential-scoped caches. @module dsh-llm-deepseek/auth-headers */

/**
 * Serialize credential headers so caches scoped by credential digest the same
 * credential to the same value whatever the header order. The result is hash
 * input only: never persist or log it.
 * @param headers - credential headers of one request.
 * @returns a stable string representation of the headers.
 */
export function serializeAuthHeaders(headers: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)))
}
