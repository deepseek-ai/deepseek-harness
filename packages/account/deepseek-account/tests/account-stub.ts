/** `deepseekAccount` stand-ins for consumers of the account's request credential. */
import type { DeepSeekAccount } from '../src/index.ts'
import { ACCOUNT_TOKEN_HEADER } from '../src/protocol.ts'

/** Token policy and rejection observer of one stand-in. */
export interface AccountStubOptions {
  /** The token released for a destination; undefined or empty releases nothing, and a throw fails the read. */
  readonly token: (url: string) => string | undefined | Promise<string | undefined>
  /** Observes each rejected token; a throw is contained, as the service contains storage failures. */
  readonly reject?: (token: string) => void | Promise<void>
}

/**
 * An account service releasing request credentials as the real one does: the token header, the bare token, and an
 * invalidation that reports no failure.
 * @param options - token policy and rejection observer.
 * @returns the stand-in, typed as the service for `ctx.provide`.
 */
export function accountStub(options: AccountStubOptions): DeepSeekAccount {
  const stub: Pick<DeepSeekAccount, 'resolveRequestCredential'> = {
    async resolveRequestCredential(url) {
      const token = await options.token(url)
      if (token === undefined || token.length === 0) return undefined
      return {
        headers: { [ACCOUNT_TOKEN_HEADER]: token },
        value: token,
        reject: async () => {
          try { await options.reject?.(token) }
          catch (_storageFailure) { /* The destination's rejection is the failure to report, as in the service. */ }
        },
      }
    },
  }
  return stub as DeepSeekAccount
}
