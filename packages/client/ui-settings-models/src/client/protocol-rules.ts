/**
 * Constraints a wire protocol places on a hand-declared route that the Models
 * forms check before a write, because the adapter accepts the profile and only
 * the first request would fail.
 */

/** pi-ai's Gemini protocol identifier. */
const GEMINI = 'google-generative-ai'

/** The only thinking levels pi-ai's Gemini protocol sends. */
const GEMINI_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high']

/**
 * Whether a route speaking this protocol cannot work without an API key:
 * pi-ai's Gemini implementation refuses a request without one, and no header
 * or ambient credential replaces it.
 * @param protocol - the route's protocol identifier, when chosen.
 * @returns whether the form must require a key.
 */
export function protocolNeedsKey(protocol: string | undefined): boolean {
  return protocol === GEMINI
}

/** The reasoning levels a protocol's models may declare. */
export interface ProtocolReasoningLevels {
  /** Levels offered, in the schema's escalation order. */
  levels: readonly string[]
  /** Whether only these levels are accepted, each sent under its own name. */
  levelsOnly: boolean
}

/**
 * Narrow the schema's reasoning levels to the ones a protocol accepts. pi-ai's
 * Gemini protocol sends only `minimal`, `low`, `medium`, or `high` and fails a
 * request carrying any other value, so a Gemini route offers those four with
 * fixed values and no Off.
 * @param protocol - the route's protocol identifier, when chosen.
 * @param levels - levels the adapter's schema accepts.
 * @returns the levels to offer and whether their values are fixed.
 */
export function protocolReasoningLevels(protocol: string | undefined, levels: readonly string[]): ProtocolReasoningLevels {
  if (protocol !== GEMINI) return { levels, levelsOnly: false }
  return { levels: levels.filter(level => GEMINI_LEVELS.includes(level)), levelsOnly: true }
}
