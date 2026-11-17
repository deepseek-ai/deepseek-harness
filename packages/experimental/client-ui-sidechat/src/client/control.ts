/** Client ownership of side creation: one in-flight fork per source and the operation outcome. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sidechatAddress } from './resource.ts'

/** Transient creation failure rendered by the root overlay; `serial` restarts the Toast for a repeated failure. */
export interface SidechatNotice { readonly serial: number; readonly key: 'createFailed' }

/** Forks at a committed cut and opens the child beside the Session that was on screen when the user asked. */
export class SidechatControl {
  /** Source Sessions with an in-flight fork; a source accepts one creation at a time. */
  readonly pending = createSnapshotStore<readonly SessionId[]>([])
  /** Latest failure, retained across conversation navigation until dismissed. */
  readonly notice = createSnapshotStore<SidechatNotice | null>(null)
  private serial = 0
  private closed = false
  private readonly tasks = new Set<Promise<void>>()

  /** @param ctx - Client Session and right-Sidebar services. */
  constructor(private readonly ctx: Context) {}

  /**
   * Fork at the latest completed Turn and open the child in the right Sidebar of the Session on screen.
   * Forking from a side conversation therefore adds the child beside it, not inside it.
   * @param sessionId - source conversation.
   */
  fork(sessionId: SessionId): void {
    if (this.closed || this.pending.getSnapshot().includes(sessionId)) return
    const main = this.ctx.sidebarRight.mounted.getSnapshot()
    if (main === undefined) return
    const task = this.create(sessionId, main)
    this.tasks.add(task)
    void task.finally(() => { this.tasks.delete(task) })
  }

  /** Stop publishing results and wait for already-issued forks. */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.all(this.tasks)
  }

  /** Clear the displayed failure. */
  dismiss(): void {
    this.notice.set(null)
  }

  private async create(sessionId: SessionId, main: SessionId): Promise<void> {
    this.pending.set([...this.pending.getSnapshot(), sessionId])
    let childId: SessionId | undefined
    try {
      // `onCreated` runs before the child title rename, so a rename failure still opens the created child.
      await this.ctx.sessions.fork({ sessionId, increaseTitle: true, onCreated: (id) => { childId = id } })
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
