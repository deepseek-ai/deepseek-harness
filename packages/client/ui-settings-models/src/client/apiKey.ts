/**
 * Browser-side judgement of a typed API key.
 * @module @deepseek-ai/dsh-client-ui-settings-models/apiKey
 */

/**
 * Twin of `normalizeApiKey` in `@deepseek-ai/dsh-llm`: printable ASCII, space
 * excluded. Client packages reference only client packages, so the charset
 * rule is mirrored here rather than imported; keep the two in step, as
 * `validateDeepSeekModels` is kept in step with the host's `catalogModel`.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/**
 * A pasted `NAME=value` environment line. Two narrowings keep real keys clear
 * of it: the name must be upper-case, so `sk-` forms break at the hyphen, and
 * the `=` must be followed by something other than another `=`, so base64
 * padding on an all-upper-case key (`ABCD==`) is not mistaken for an
 * assignment. This heuristic runs only here — a resolver applying it could
 * lock a user out of a gateway whose key legitimately takes this shape, with
 * the environment refusing it too and no way through.
 */
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

/**
 * Copy key naming why a typed key cannot be saved. A wrapped paste reports the
 * same format failure as an illegal character: the reader's next move is the
 * same either way — look at the key and paste it again — so naming the two
 * causes apart would spend the field's one line on a distinction that changes
 * nothing about what to do.
 */
export type ApiKeyFailureKey = 'keyBlank' | 'keyIllegalCharacters'

/** Whether a value is wrapped in one matching pair of quotes. */
function isQuoted(value: string): boolean {
  const first = value[0]
  if (first !== '"' && first !== '\'' && first !== '`') return false
  return value.length > 1 && value.endsWith(first)
}

/**
 * Judge the key input's current value.
 *
 * An empty field is not a failure: every card opens with it empty even when a
 * key is already stored, where it means keep that one. A field holding only
 * whitespace is a failure rather than an empty field, so typed input is never
 * silently discarded.
 * @param draft - the key input's current value, untrimmed.
 * @returns the copy key for a field-level failure, or `undefined` to allow submit.
 */
export function apiKeyFailure(draft: string): ApiKeyFailureKey | undefined {
  if (draft.length === 0) return undefined
  const value = draft.trim()
  if (value.length === 0) return 'keyBlank'
  if (ENV_LINE.test(value) || isQuoted(value)) return 'keyIllegalCharacters'
  if (!LEGAL_API_KEY.test(value)) return 'keyIllegalCharacters'
  return undefined
}
