/** Credential sources for provider tests that construct a provider or a request directly. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { DeepSeekAuthCandidate } from '@deepseek-ai/dsh-deepseek-auth'

/**
 * An API-key candidate bound to `endpoint`, as `ctx.deepseekAuth` binds one: it releases `key` as a bearer token and
 * releases nothing for an empty key.
 * @param endpoint - absolute URL the operation dispatches to.
 * @param key - the key; empty means none is configured.
 * @param reference - the credential reference the candidate names.
 * @returns the candidate.
 */
export function keyCandidate(endpoint: string, key: string, reference = 'TEST_KEY'): DeepSeekAuthCandidate {
  const ref = credentialRef(reference)
  return {
    kind: 'api-key', endpoint, reference: ref,
    configured: async () => key.length > 0,
    resolve: async () => key.length > 0 ? { kind: 'api-key', endpoint, reference: ref, headers: { authorization: `Bearer ${key}` } } : undefined,
  }
}
