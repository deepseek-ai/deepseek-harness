/** Ordinary Session references owned by Sidebar resource occurrences. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

/** Resource prefix for a side conversation; the remainder is the encoded child Session identity. */
export const SIDECHAT_ADDRESS = 'dsh-resource://sidechat/session/'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    sidechat: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface ResourceProtocolMap {
    sidechat: SessionReference
  }
}

/**
 * Address a child conversation without retaining it.
 * @param id - durable child Session identity.
 * @returns canonical Sidebar resource address.
 */
export function sidechatAddress(id: SessionId): string {
  return `${SIDECHAT_ADDRESS}${encodeURIComponent(id)}`
}

/**
 * Parse a Sidebar address at the resource input boundary.
 * @param address - candidate resource address.
 * @returns the child Session identity, or undefined for malformed or foreign addresses.
 */
export function parseSidechatAddress(address: string): SessionId | undefined {
  if (!address.startsWith(SIDECHAT_ADDRESS)) return undefined
  const encoded = address.slice(SIDECHAT_ADDRESS.length)
  if (encoded === '' || /[/?#]/u.test(encoded)) return undefined
  try {
    return decodeURIComponent(encoded) as SessionId
  } catch (_invalidEncoding) {
    return undefined
  }
}

/**
 * Retain the child Session with its `conversation` facet while its resource is mounted, so the tab's Chat
 * folds the event window; releasing never cancels the Host Agent.
 * Acquisition failures and malformed addresses yield a failure frame.
 * @param sessions - ordinary Session reference owner.
 * @returns the resource provider.
 */
export function sidechatResourceProvider(sessions: Pick<ISessions, 'retain'>): ResourceProvider<'sidechat'> {
  return {
    protocol: 'sidechat',
    async *open(address, { signal }) {
      const id = parseSidechatAddress(address)
      if (id === undefined) {
        yield { ok: false, error: new RemoteError('gateway/bad-request', `sidechat: invalid resource address "${address}"`, {}) }
        return
      }
      if (signal.aborted) return
      let reference: SessionReference
      try {
        reference = sessions.retain(id, { source: 'sidechat', facets: { conversation: true }, signal })
      } catch (error) {
        yield { ok: false, error: remoteErrorOf(error)
          ?? new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) }
        return
      }
      try {
        yield { ok: true, value: reference }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      } finally {
        reference.release()
      }
    },
  }
}
