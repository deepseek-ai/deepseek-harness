/**
 * Reader Peers for viewer-reader specs: the reader dispatches every call and stream through one Peer
 * per share and reader, so a spec supplies a Connection whose `createPeer` builds real Peers and whose
 * shared handler records which Peer each call spoke for.
 */
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { ViewerReadConnection } from '../src/host/viewer-read.ts'
import type { ShareViewerPrincipal } from '../src/host/viewer-principal.ts'

/** The reader most specs speak as. */
export const READER: ShareRpcActor = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_reader' }

/** Fetch stand-in for the shared `/api` handler; the second argument is the Peer the call speaks for. */
export type ReaderFetch = (request: Request, peer: PeerScope) => Promise<Response>

/** A Connection stand-in plus the Peers it created. */
export interface ReaderConnection {
  readonly connection: ViewerReadConnection
  /** Every Peer `createPeer` returned, in creation order. */
  readonly peers: readonly PeerScope[]
  /**
   * The share-viewer principal of one created Peer.
   * @param index - Creation index.
   * @returns That Peer's principal.
   */
  readonly principalOf: (index: number) => ShareViewerPrincipal
  /** Dispose the Context every created Peer hangs under. */
  readonly dispose: () => Promise<void>
}

/**
 * Build a Connection stand-in for a viewer reader.
 * @param fetch - Shared-handler implementation; answers an empty JSON body by default.
 * @returns The Connection, its Peers, and their owner's disposer.
 */
export function readerConnection(fetch?: ReaderFetch): ReaderConnection {
  const owner = new Context()
  const peers: PeerScope[] = []
  const connection: ViewerReadConnection = {
    createSharedFetchHandler: () => ({
      requestBodyMode: () => 'buffered',
      fetch: (request, peer) => fetch === undefined ? Promise.resolve(Response.json({})) : fetch(request, peer),
    }),
    createPeer: (options) => {
      const peer = new Peer(owner, options)
      peers.push(peer)
      return peer
    },
  }
  return {
    connection,
    peers,
    principalOf: (index) => {
      const principal = peers[index]?.principal
      if (principal?.kind !== 'share-viewer') throw new Error(`peer ${String(index)} is not a share reader`)
      return principal
    },
    dispose: () => owner.fiber.dispose().then(() => undefined),
  }
}
