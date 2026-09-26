/**
 * The operator Peer: the one party this Host answers to. Connection owns it
 * for its own lifetime, admits every request as it, and hands it to each
 * Remote call as `invocation.peer`.
 * @module @deepseek-ai/dsh-client-connection/src/operator-peer
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'

/**
 * The operator's scope. The instance is its own scope key, so `scopeOf(peer.ctx)`
 * returns it and events dispatched with `scopeTarget(subject, peer)` reach
 * listeners registered through `peer.ctx` and nobody else.
 */
export class OperatorPeer implements PeerScope {
  readonly id: PeerId = randomUUID() as PeerId
  readonly ctx: Context
  private readonly scope: Scope

  /** @param owner - Connection plugin context the scope fiber hangs under. */
  constructor(owner: Context) {
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
  }

  /** Tear down every connection-lifetime registration; racing calls share one completion. */
  dispose(): Promise<void> {
    return this.scope.dispose()
  }
}
