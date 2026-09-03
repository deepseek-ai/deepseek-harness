/**
 * The E2B control-plane URL, derived the way the SDK derives it.
 * @module @deepseek-ai/dsh-e2b/src/api-url.ts
 */

/** The SDK's own default control-plane domain; `E2B_DOMAIN` overrides it there and here alike. */
const E2B_DEFAULT_DOMAIN = 'e2b.app'

/** The debug control plane the SDK substitutes, on loopback and plain HTTP. */
const E2B_DEBUG_API_URL = 'http://localhost:3000'

/**
 * The control-plane URL the SDK will actually call, derived the way the SDK derives it: an explicit
 * `E2B_API_URL` first, then the debug substitute, then the domain default. Choosing a proxy for
 * anything else would pick the wrong scheme's proxy, ignore a bypass entry naming the real host, and
 * — for the loopback debug plane — hand a proxy the control-plane traffic and its API key.
 *
 * @param env - the process environment to read; overridable so tests need no ambient state.
 * @returns the absolute control-plane URL.
 */
export function e2bApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.E2B_API_URL
  if (explicit !== undefined && explicit !== '') return explicit
  if ((env.E2B_DEBUG ?? 'false').toLowerCase() === 'true') return E2B_DEBUG_API_URL
  return `https://api.${env.E2B_DOMAIN ?? E2B_DEFAULT_DOMAIN}`
}
