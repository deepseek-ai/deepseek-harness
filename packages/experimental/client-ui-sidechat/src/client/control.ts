/** Client ownership of side creation: one in-flight fork per source and the operation outcome. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sidechatAddress } from './resource.ts'

/** Transient outcome rendered by the root overlay; `serial` restarts the Toast for a repeated notice. */
export interface SidechatNotice { readonly serial: number; readonly key: 'createFailed' | 'noTurn' }

/**
 * Seq of the newest durable event in the Client window once the source has started a Turn; live chunk rows
 * carry no durable seq, and a Session that only holds configuration events has nothing to branch.
 * @param window - event window of the retained source, or undefined when the source is not retained.
 * @returns the inclusive fork cut, or undefined before the first `turn/start` or without a window.
 */
function latestTurnSeq(window: SessionEventWindow | undefined): number | undefined {
  if (window === undefined || !window.entries.some(entry => entry.type === 'event' && entry.event.type === 'turn/start')) return undefined
  return window.entries.findLast(entry => entry.type === 'event')?.event.seq
}

/** Forks at the newest event on screen and opens the child beside the Session that was on screen when the user asked. */
export class SidechatControl {
  /** Source Sessions with an in-flight fork; a source accepts one creation at a time. */
  readonly pending = createSnapshotStore<readonly SessionId[]>([])
  /** Latest failure, retained across conversation navigation until dismissed. */
  readonly notice = createSnapshotStore<SidechatNotice | null>(null)
  private serial = 0
  private closed = false

  /** @param ctx - Client Session and right-Sidebar services. */
  constructor(private readonly ctx: Context) {}

  /**
   * Fork at the newest durable event the Client has seen, including inside a running Turn, and open the
   * child in the right Sidebar of the Session on screen. Forking from a side conversation therefore adds
   * the child beside it, not inside it. A source whose window shows no `turn/start` yet reports that
   * there is nothing to branch instead of forking. A source with a fork in flight and a disposed control
   * are ignored.
   * @param sessionId - source conversation.
   */
  fork(sessionId: SessionId): void {
    if (this.closed || this.pending.getSnapshot().includes(sessionId)) return
    const main = this.ctx.sidebarRight.mounted.getSnapshot()
    if (main === undefined) return
    const atSeq = latestTurnSeq(this.ctx.sessions.binding(sessionId)?.eventSource.getSnapshot())
    if (atSeq === undefined) {
      this.notice.set({ serial: ++this.serial, key: 'noTurn' })
      return
    }
    void this.create(sessionId, atSeq, main)
  }

  /** Stop publishing results; a fork already issued settles on the Host without further effect here. */
  dispose(): void {
    this.closed = true
  }

  /** Clear the displayed failure. */
  dismiss(): void {
    this.notice.set(null)
  }

  private async create(sessionId: SessionId, atSeq: number, main: SessionId): Promise<void> {
    this.pending.set([...this.pending.getSnapshot(), sessionId])
    let childId: SessionId | undefined
    try {
      // `onCreated` runs before the child title rename, so a rename failure still opens the created child.
      await this.ctx.sessions.fork({ sessionId, atSeq, increaseTitle: true, onCreated: (id) => { childId = id } })
    } catch (error) {
      this.ctx.logger.error(childId === undefined ? 'Side conversation creation failed' : 'Side conversation title rename failed', error)
      if (childId === undefined && !this.closed) this.notice.set({ serial: ++this.serial, key: 'createFailed' })
    } finally {
      this.pending.set(this.pending.getSnapshot().filter(id => id !== sessionId))
    }
    // A released main Session store makes the open a no-op; the child remains in the Session list.
    if (childId !== undefined && !this.closed) this.ctx.sidebarRight.openResourceIn(main, sidechatAddress(childId))
  }
}
