/**
 * `${credential:REF}` syntax and substitution for MCP transport strings.
 * Managers validate syntax at configuration writes; the client resolves values
 * at runtime without changing the stored configuration.
 *
 * @module
 */

import { McpLocalError } from './diagnostic.ts'

/** A referenced credential has no configured value (`MCP_CREDENTIAL_NOT_FOUND`). */
export class MissingTemplateValue extends McpLocalError {
  constructor(message: string) {
    super(message, 'MCP_CREDENTIAL_NOT_FOUND')
  }
}

const TOKEN = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** One whole occurrence must BE a token; containment is not enough. */
const TOKEN_EXACT = /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/

/** Any `${…}` occurrence, well-formed or not, for fail-loud validation. */
const SUSPECT = /\$\{[^}]*\}/g

/**
 * The credential references one configured string names, read statically. A
 * rotation observer uses this over the raw configuration so a server whose
 * earlier resolution failed — a credential configured only now — is still
 * recognized as affected.
 * @param value - the configured string.
 * @returns the referenced credential names, in template order.
 */
export function credentialRefsIn(value: string): string[] {
  return [...value.matchAll(TOKEN)].map(token => token[1] as string)
}

/**
 * Reject a string whose `${…}` occurrences are not all well-formed template
 * tokens, naming the offending occurrence and where it sits.
 * @param value - the configured string.
 * @param where - configuration path used in the thrown message.
 */
export function assertTemplateSyntax(value: string, where: string): void {
  for (const occurrence of value.matchAll(SUSPECT)) {
    // Anchored equality, not containment: `${x${credential:A}` contains a
    // valid token but the resolver would leave its `${x` prefix behind as a
    // literal, so only an occurrence that IS a token may pass.
    if (!TOKEN_EXACT.test(occurrence[0])) {
      throw new Error(`${where}: "${occurrence[0]}" is not a template token — use \${credential:REF}`)
    }
  }
}

/**
 * Resolve every template token in one string.
 * @param value - the configured string.
 * @param where - configuration path used in thrown messages.
 * @param credential - credential-reference lookup returning `undefined` while unconfigured.
 * @returns the substituted string.
 * @throws when a referenced credential is unconfigured.
 */
export async function resolveTemplateString(
  value: string,
  where: string,
  credential: (ref: string) => Promise<string | undefined>,
): Promise<string> {
  let out = ''
  let cursor = 0
  for (const token of value.matchAll(TOKEN)) {
    const name = token[1] as string
    const resolved = await credential(name)
    if (resolved === undefined) {
      throw new MissingTemplateValue(`${where}: credential "${name}" is not configured — store it through the credential seam or remove the \${credential:${name}} template`)
    }
    out += value.slice(cursor, token.index) + resolved
    cursor = token.index + token[0].length
  }
  return out + value.slice(cursor)
}
