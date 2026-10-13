/**
 * The `secret` UserText rule. A value is recognized by its published format
 * alone: provider key and token prefixes, JSON Web Tokens, private key blocks,
 * and the password of an address that carries credentials. Free-form passwords
 * and `name=value` assignments have no such format and stay plain. The formats
 * live in [credential-formats.ts](./credential-formats.ts); scanning lives in
 * [credential-scanner.ts](./credential-scanner.ts).
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CredentialScanner } from './credential-scanner.ts'
import { formatTables } from './format-tables.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** One recognized credential range. */
    secret: {
      /** Display form of the original range; line breaks stay in place. */
      readonly masked: string
    }
  }
}

/**
 * Create the credential matcher. Each instance owns a scanner whose memo holds
 * the last queried text until a query for another text.
 * @returns the `secret` rule; it reads no Facts, so Facts changes never invalidate its queries.
 */
export function createSecretRule(): UserTextRule<'secret'> {
  const scanner = new CredentialScanner(formatTables())
  return {
    id: 'secret',
    // Same-start ties with other rules draw the credential masked.
    order: 0,
    match: (text, from) => scanner.match(text, from),
  }
}
