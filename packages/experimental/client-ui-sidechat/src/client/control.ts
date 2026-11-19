/** Client ownership of side creation and its outcome notice. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionForkError } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sidechatAddress } from './resource.ts'

/** Transient outcome rendered by the root overlay; `serial` restarts the Toast for a repeated notice. */
export interface SidechatNotice { readonly serial: number; readonly key: 'createFailed' | 'noTurn' | 'subagentSource' }

/** Client plugin bundles do not share error-class identity, so the Host refusal is told by name and code. */
function forkUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionForkError'
    && (error as Partial<SessionForkError>).rpcError?.code === 'session/fork-unavailable'
}

/** Forks at the latest completed Turn and opens the child beside the Session that was on screen when the user asked. */
export class SidechatControl {
  /** Latest outcome notice, retained across conversation navigation until dismissed. */
  readonly notice = createSnapshotStore<SidechatNotice | null>(null)
  private serial = 0
  private closed = false

  /** @param ctx - Client Session and right-Sidebar services. */
  constructor(private readonly ctx: Context) {}

  /**
   * Fork at the latest completed Turn, as the ordinary fork does with an omitted cut, and open the child in
   * the right Sidebar of the Session on screen. Forking from a side conversation therefore adds the child
   * beside it, not inside it. A subagent source reports that it cannot start a side conversation: its child
   * would inherit the delegated approval policy and preset without the delegation itself. The Host refuses a
   * source without a completed Turn, which the notice reports as having no completed turn. The child records
   * `origin: 'side'`, which keeps it out of the left Sidebar. Every other call forks.
   * @param sessionId - source conversation.
   */
  fork(sessionId: SessionId): void {
    const main = this.ctx.sidebarRight.mounted.getSnapshot()
    if (main === undefined) {
      this.ctx.logger.warn('Side conversation not created: no conversation is on screen')
      return
    }
    if (this.ctx.sessions.list.getSnapshot().byId[sessionId]?.origin === 'subagent') {
      this.notice.set({ serial: ++this.serial, key: 'subagentSource' })
      return
    }
    void this.create(sessionId, main)
  }

  /** Stop publishing results; a fork already issued settles on the Host without further effect here. */
  dispose(): void {
    this.closed = true
  }

  /** Clear the displayed failure. */
  dismiss(): void {
    this.notice.set(null)
  }

  private async create(sessionId: SessionId, main: SessionId): Promise<void> {
    let childId: SessionId | undefined
    try {
      // `onCreated` runs before the child title rename and also reports a child whose Workspace attachment
      // failed, so either failure still opens the created child.
      await this.ctx.sessions.fork({ sessionId, origin: 'side', increaseTitle: true, onCreated: (id) => { childId = id } })
    } catch (error) {
      if (childId === undefined && !this.closed) {
        this.notice.set({ serial: ++this.serial, key: forkUnavailable(error) ? 'noTurn' : 'createFailed' })
      }
      if (forkUnavailable(error)) return
      this.ctx.logger.error(childId === undefined ? 'Side conversation creation failed' : 'Side conversation setup failed after creation', error)
    }
    // A released main Session store makes the open a no-op; the stored child then has no left sidebar row.
    if (childId !== undefined && !this.closed) this.ctx.sidebarRight.openResourceIn(main, sidechatAddress(childId))
  }
}
