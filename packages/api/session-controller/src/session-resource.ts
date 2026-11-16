/**
 * The `session` resource kind's default identity extraction: the Session one
 * Remote call names, read from its validated wire arguments.
 * @module @deepseek-ai/dsh-api-session-controller/session-resource
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TypertResourceResolveInput } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionAddress } from './types.ts'

/**
 * Extract the Session resource from an ID or a history address.
 *
 * Registers as the `session` kind default, so it applies to every Remote method of
 * every namespace: a top-level `sessionId` parameter, otherwise the first object
 * parameter carrying `sessionId` or an `address`. A new request type whose first
 * object parameter has an unrelated `address` field would be read as an address.
 * @param input - validated wire arguments and their ordered parameter descriptions.
 * @returns the named Session identity, otherwise the first object's Session identity or history address.
 * @throws Error when the request object supplies both sessionId and address.
 */
export function resolveSessionResource(input: TypertResourceResolveInput): SessionId | undefined {
  const { args, parameters } = input
  const sessionParameter = parameters.find(parameter => parameter.name === 'sessionId' || parameter.wire === 'sessionId')
  if (sessionParameter !== undefined) return args[sessionParameter.wire] as SessionId | undefined
  for (const parameter of parameters) {
    const value = args[parameter.wire]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const request = value as { readonly sessionId?: SessionId; readonly address?: SessionAddress }
    const address = request.address
    if (request.sessionId !== undefined && address !== undefined) {
      throw new Error('Session resource request must not contain both sessionId and address')
    }
    return request.sessionId ?? (address === undefined ? undefined
      : address.kind === 'session' ? address.sessionId : address.childSessionId)
  }
  return undefined
}
