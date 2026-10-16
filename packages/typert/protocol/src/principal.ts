/**
 * Reads the non-owner caller of the current Remote call.
 * @module @deepseek-ai/dsh-typert-protocol/principal
 */

import type { Principal, RemoteInvocation } from './types.ts'

/**
 * The identity a Remote-call producer records on durable output.
 * @param invocation - `ctx.invocation`; `undefined` outside a Remote call.
 * @returns the caller's principal when it is not the owner; `undefined` for the
 *   owner and for trusted in-process code outside a Remote call.
 */
export function principalOf(invocation: RemoteInvocation | undefined): Principal | undefined {
  const principal = invocation?.peer.principal
  return principal?.kind === 'owner' ? undefined : principal
}
