/** Canonical URL-safe credentials for Node and Preview's Buffer implementation. */

/**
 * Encode bytes without padding, using Buffer encodings supported by Preview.
 * @param bytes - credential or signed payload bytes.
 * @returns canonical URL-safe base64 text.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Decode only canonical, nonempty URL-safe base64 text.
 * @param value - untrusted credential or signed payload text.
 * @returns decoded bytes, or undefined for invalid alphabet, padding, or trailing bits.
 */
export function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const bytes = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(bytes) === value ? bytes : undefined
}
