/** Index source URL validation shared by `setIndexes` and the per-use check of configured sources. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Validate and normalize one index source URL.
 * @param text - URL as configured or entered.
 * @returns the URL's serialization.
 * @throws {RemoteError} `plugin-market/invalid-index-url` for anything but an http(s) URL without credentials or
 * fragment.
 */
export function normalizeIndexUrl(text: string): string {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    // Unparseable text: report the rule instead of the parser message.
    throw new RemoteError('plugin-market/invalid-index-url', `Not an absolute URL: ${text}`, { url: text, reason: 'not-absolute' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RemoteError('plugin-market/invalid-index-url', `Index URLs use http or https: ${text}`, { url: text, reason: 'scheme' })
  }
  if (url.username !== '' || url.password !== '' || url.href.includes('#')) {
    throw new RemoteError('plugin-market/invalid-index-url', `Index URLs carry no credentials or fragment: ${text}`, { url: text, reason: 'credentials-or-fragment' })
  }
  return url.href
}
