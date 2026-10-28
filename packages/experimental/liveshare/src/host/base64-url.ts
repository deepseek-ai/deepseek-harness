/**
 * Unpadded base64url encoding for identifiers and credentials.
 *
 * Some execution targets run a Buffer polyfill without the `base64url` encoding
 * name. Encoding through standard base64 keeps those targets working while the
 * output stays the RFC 4648 base64url form that Relay records use.
 * @param value - Bytes to encode.
 * @returns The unpadded base64url text.
 */
export function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Decode unpadded base64url text.
 * @param text - RFC 4648 base64url text without padding.
 * @returns The decoded bytes.
 */
export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4), 'base64')
}
