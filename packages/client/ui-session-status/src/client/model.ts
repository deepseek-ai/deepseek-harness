/** React-free Client copy of the Host reading records; internal to the Session status plugin. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-session-status/remote'
import type { SessionReadAction, SessionReadState } from '../types.ts'

/** Reading records retained during reconnection; mutations require a ready baseline. */
export interface SessionReadSnapshot {
  readonly items: Readonly<Record<SessionId, SessionReadState>>
  readonly ready: boolean
}

/** Projects the ordered Host stream; mutation responses never replace reading records. */
export class SessionReadModel {
  /** Current reading records and baseline readiness, published synchronously on every change. */
  readonly state: SnapshotStore<SessionReadSnapshot> = createSnapshotStore<SessionReadSnapshot>(
    { items: {}, ready: false }, { flush: 'sync' },
  )

  /** @param remote - generated `sessionStatus` Remote methods. */
  constructor(private readonly remote: Pick<TypertClientRemote['sessionStatus'], 'mark'>) {}

  /**
   * Replace the complete projection for a new connection.
   * @param items - complete authoritative baseline for the new stream generation.
   */
  replace(items: readonly SessionReadState[]): void {
    this.state.set({ items: Object.fromEntries(items.map(item => [item.sessionId, item])), ready: true })
  }

  /**
   * Accept the next committed record from the ordered subscription.
   * @param item - Committed whole-record change.
   */
  accept(item: SessionReadState): void {
    const snapshot = this.state.getSnapshot()
    this.state.set({ ...snapshot, items: { ...snapshot.items, [item.sessionId]: item } })
  }

  /** Retain the last projection while disabling writes until a new baseline. */
  disconnected(): void {
    this.state.set({ ...this.state.getSnapshot(), ready: false })
  }

  /**
   * Mark the Session through the latest completion known to this Client, without optimistically changing it.
   * @param sessionId - known Session identity.
   * @param unread - requested reminder state.
   * @throws when no current baseline exists or the Host or carrier rejects; reconnect to refresh an unknown outcome.
   */
  async mark(sessionId: SessionId, unread: boolean): Promise<void> {
    const throughTurn = this.state.getSnapshot().items[sessionId]?.completedTurn ?? 0
    await this.send(sessionId, unread ? { type: 'unread' } : { type: 'read', throughTurn })
  }

  /**
   * Acknowledge content received by the visible Session view.
   * @param sessionId - Known Session identity.
   * @param throughTurn - Latest completed turn received in the Session body.
   * @param clearManual - Clear the manual reminder of a Session the main view switched to.
   */
  async acknowledge(sessionId: SessionId, throughTurn: number, clearManual: boolean): Promise<void> {
    await this.send(sessionId, { type: clearManual ? 'read' : 'acknowledge', throughTurn })
  }

  private async send(sessionId: SessionId, action: SessionReadAction): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (!snapshot.ready) throw new Error('Reading state is unavailable. Reload the page to reconnect.')
    const result = await this.remote.mark(sessionId, action)
    if (!result.ok) throw result.error
  }
}
