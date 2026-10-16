/** Owner Peers for Gateway specs: every in-process call names its Peer explicitly. */
import type { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'

const owners = new WeakMap<Context, PeerScope>()

/**
 * The owner Peer of one test Context tree, created on first use.
 * @param ctx - any Context of the tree; the Peer hangs under its root.
 * @returns the tree's shared owner Peer.
 */
export function ownerPeer(ctx: Context): PeerScope {
  let peer = owners.get(ctx.root)
  if (peer === undefined) {
    peer = new Peer(ctx.root, { principal: { kind: 'owner' } })
    owners.set(ctx.root, peer)
  }
  return peer
}

/**
 * A fresh Peer of one principal under the test Context tree.
 * @param ctx - any Context of the tree; the Peer hangs under its root.
 * @param principal - identity the Peer speaks for.
 * @returns an independent Peer.
 */
export function peerFor(ctx: Context, principal: Principal): PeerScope {
  return new Peer(ctx.root, { principal })
}
