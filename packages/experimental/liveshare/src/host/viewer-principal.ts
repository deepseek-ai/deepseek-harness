/**
 * Caller identity of one share reader on this owner Host.
 *
 * Every Remote call a reader makes through a share speaks for a Peer whose principal is this value, so
 * the Gateway, the `share-viewer` remote access policy, and the durable `user-rpc` message source all
 * name the reader the same way. The value is persisted in Session logs through `source.principal`, so it carries only the
 * share and the Relay-asserted identity: the triple plus an optional display name for attribution; no credential or avatar.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-principal
 */

import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** One reader of one LiveShare share, as the Relay asserted it. */
    'share-viewer': ShareViewerPrincipal
  }
}

/** One reader of one share, identified by the share and the Relay-asserted identity triple. */
export interface ShareViewerPrincipal {
  readonly kind: 'share-viewer'
  /** Share the reader's calls arrive through. */
  readonly shareId: string
  /** Relay-asserted reader identity; the display name is attribution data, not authority. */
  readonly actor: {
    readonly providerId: string
    readonly tenantId: string
    readonly subjectId: string
    readonly displayName?: string
  }
}

/**
 * Build the principal one reader's calls speak for.
 *
 * The identity fields are copied one by one, so a Relay actor that also carries credential or
 * avatar fields contributes only the identity and its display name to the persisted value.
 * @param shareId - Share the reader's calls arrive through.
 * @param actor - Relay-asserted reader identity.
 * @returns The principal of that reader on that share.
 */
export function shareViewerPrincipal(shareId: string, actor: ShareRpcActor): ShareViewerPrincipal {
  return {
    kind: 'share-viewer',
    shareId,
    actor: {
      providerId: actor.providerId,
      tenantId: actor.tenantId,
      subjectId: actor.subjectId,
      ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    },
  }
}

/**
 * The share reader one principal names, when it names one.
 * @param principal - Caller identity a Peer or a message source carries.
 * @returns The share-viewer principal, or undefined for every other kind.
 */
export function shareViewerOf(principal: Principal): ShareViewerPrincipal | undefined {
  return principal.kind === 'share-viewer' ? principal : undefined
}

/**
 * Whether one principal is the given reader of the given share.
 *
 * Readers compare by their whole identity key: the same subject id issued by two providers, or in two
 * tenants, is two readers.
 * @param principal - Share-viewer principal to compare.
 * @param shareId - Share the reader must belong to.
 * @param actor - Reader identity to compare with.
 * @returns True when share and identity key both match.
 */
export function isShareViewer(
  principal: ShareViewerPrincipal,
  shareId: string,
  actor: ShareRpcActor,
): boolean {
  return principal.shareId === shareId && identityKeyOf(principal.actor) === identityKeyOf(actor)
}
