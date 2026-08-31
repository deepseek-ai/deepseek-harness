/**
 * `${env:NAME}` / `${credential:REF}` templates in managed-server strings.
 * Validation runs synchronously at the settings write so a malformed token is
 * refused where it is typed; resolution runs at instance mount so the
 * configuration document never carries a secret value and a rotated
 * credential reaches the next mounted instance.
 *
 * @module
 */

/** One well-formed template token. */
const TOKEN = /\$\{(env|credential):([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Any `${…}` occurrence, well-formed or not, for fail-loud validation. */
const SUSPECT = /\$\{[^}]*\}/g

/** Sources a resolver draws template values from. */
export interface TemplateSources {
  /**
   * Environment lookup.
   * @param name - the environment variable name.
   * @returns the value, or `undefined` while unset.
   */
  env(name: string): string | undefined
  /**
   * Credential-reference lookup.
   * @param ref - the credential reference name.
   * @returns the secret value, or `undefined` while unconfigured.
   */
  credential(ref: string): Promise<string | undefined>
}

/** A resolved string plus the credential references its templates named. */
export interface ResolvedTemplateString {
  value: string
  credentialRefs: string[]
}

/**
 * The credential references one configured string names, read statically. A
 * rotation observer uses this over the raw configuration so a server whose
 * earlier resolution failed — a credential configured only now — is still
 * recognized as affected.
 * @param value - the configured string.
 * @returns the referenced credential names, in template order.
 */
export function credentialRefsIn(value: string): string[] {
  TOKEN.lastIndex = 0
  return [...value.matchAll(TOKEN)]
    .filter(token => token[1] === 'credential')
    .map(token => token[2] as string)
}

/**
 * Reject a string whose `${…}` occurrences are not all well-formed template
 * tokens, naming the offending occurrence and where it sits.
 * @param value - the configured string.
 * @param where - configuration path used in the thrown message.
 */
export function assertTemplateSyntax(value: string, where: string): void {
  for (const occurrence of value.matchAll(SUSPECT)) {
    TOKEN.lastIndex = 0
    if (!TOKEN.test(occurrence[0])) {
      throw new Error(
        `${where}: "${occurrence[0]}" is not a template token — use \${env:NAME} or \${credential:REF}`,
      )
    }
  }
}

/**
 * Resolve every template token in one string.
 * @param value - the configured string.
 * @param where - configuration path used in thrown messages.
 * @param sources - environment and credential lookups.
 * @returns the substituted string and the credential references it used.
 * @throws when a named environment variable is unset or a named credential is unconfigured.
 */
export async function resolveTemplateString(
  value: string,
  where: string,
  sources: TemplateSources,
): Promise<ResolvedTemplateString> {
  const credentialRefs: string[] = []
  let out = ''
  let cursor = 0
  TOKEN.lastIndex = 0
  for (const token of value.matchAll(TOKEN)) {
    const [matched, scheme, name] = token as unknown as [string, 'env' | 'credential', string]
    out += value.slice(cursor, token.index)
    if (scheme === 'env') {
      const resolved = sources.env(name)
      if (resolved === undefined) {
        throw new Error(`${where}: environment variable "${name}" is not set — export it or remove the \${env:${name}} template`)
      }
      out += resolved
    } else {
      const resolved = await sources.credential(name)
      if (resolved === undefined) {
        throw new Error(`${where}: credential "${name}" is not configured — store it through the credential seam or remove the \${credential:${name}} template`)
      }
      credentialRefs.push(name)
      out += resolved
    }
    cursor = token.index + matched.length
  }
  out += value.slice(cursor)
  return { value: out, credentialRefs }
}
