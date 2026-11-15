/**
 * The one definition of a well-formed API key and of the diagnostic for a key
 * that is not, shared by every consumer that puts a resolved key in an HTTP
 * header.
 * @module @deepseek-ai/dsh-credentials/api-key
 */

/**
 * Characters an HTTP header value carries verbatim and every known provider
 * key uses: printable ASCII, space excluded. A key outside this set cannot
 * reach any provider — `fetch` refuses to build the header — so this is a
 * transport invariant rather than one provider's policy. Latin-1 is excluded
 * deliberately: a header could carry it, but no provider issues it, and
 * admitting it trades a local explained refusal for an opaque 401.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** Why a supplied API key cannot be used. */
export type ApiKeyRejection = 'empty' | 'illegalCharacters'

/** The verdict on one supplied API key. */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/**
 * Judge one *supplied* API key, trimming surrounding whitespace first.
 *
 * Trimming is silent because a padded key has one unambiguous reading; every
 * other defect is reported. Absence is a configuration state this function
 * never sees — a profile naming no credential authenticates through the
 * provider's own ambient discovery or OAuth — so callers decide whether a
 * value was supplied before asking.
 * @param raw - the key exactly as configured, stored, or typed.
 * @returns the trimmed key, or why it cannot be used.
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/**
 * The diagnostic for one resolved key {@link normalizeApiKey} rejected. The key
 * never enters the text: `ref` names where to fix it. The Models page is named
 * as the writer it usually is, not as the only one, because the same value can
 * arrive from a hand-edited `.env` or a shell export in a composition that
 * mounts no credentials service.
 * @param reason - why the key cannot be used.
 * @param owner - settings namespace or package name of the consumer that refuses the key, prefixed to the text.
 * @param ref - the credential reference the value resolved through.
 * @returns the text for the consumer's own error type.
 */
export function unusableApiKeyMessage(reason: ApiKeyRejection, owner: string, ref: string): string {
  return reason === 'empty'
    ? `${owner}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
      + ' (the web Models page writes it) or export it in the launching environment'
    : `${owner}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
      + ` set ${ref} to the raw key alone (the web Models page writes it)`
}
