/**
 * Keep unit suites from requesting the official DeepSeek model listing.
 *
 * The API-key and account routes request `GET https://api.deepseek.com/models` whenever they hold a
 * credential for the official endpoint, and suites routinely boot those routes with a dummy key or
 * inherit a developer's real one. Such a request would reach production and, on a network that never
 * answers, hold the route's first catalog access for its whole listing deadline. Here it fails at once,
 * so the route serves its built-in catalog; a suite that exercises the listing replaces `fetch` itself.
 * @module
 */

/** The listing endpoint of the official DeepSeek API. */
const OFFICIAL_LISTING = 'https://api.deepseek.com/models'

const ambientFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
  if (url === OFFICIAL_LISTING) {
    return Promise.reject(new TypeError(`unit suites do not reach ${OFFICIAL_LISTING}; answer it with a fetch stub`))
  }
  return ambientFetch(input, init)
}
