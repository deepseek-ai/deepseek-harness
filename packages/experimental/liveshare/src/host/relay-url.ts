/**
 * Normalize a public Relay base URL by removing query, hash, and trailing slashes.
 * @param value Public Relay URL or base URL.
 * @returns Canonical base URL without credentials, query, hash, or trailing slash.
 */
export function normalizeRelayUrl(value: string): string {
  if (value === '') throw new Error('liveshare relayUrl must not be empty')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('liveshare relayUrl must be an absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('liveshare relayUrl must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('liveshare relayUrl must not include credentials')
  }
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.href.replace(/\/$/u, '')
}

/**
 * Split one Relay base URL into its origin and base path.
 * @param relay Public Relay URL or base URL.
 * @returns Validated origin and trailing-slash-free base path.
 */
export function relayEndpoint(relay: string): { origin: string; basePath: string } {
  const url = new URL(normalizeRelayUrl(relay))
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/u, '') }
}
