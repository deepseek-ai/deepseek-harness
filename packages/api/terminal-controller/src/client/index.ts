/** Client terminal model service; views are keyed independently from Host terminal identities. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { TerminalView, type TerminalRemote } from './model.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { WebTerminalId, WebTerminalInfo } from '../types.ts'
import { TerminalCloseRequests, type TerminalCloseRequest } from './close-requests.ts'

export type { TerminalView, TerminalViewState, TerminalViewIssue, TerminalRenderFrame, TerminalRemote } from './model.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free browser terminal views and explicit process cleanup. */
    webTerminals: ClientTerminals
  }
}

/** A failed background close that can be retried without restoring its tab. */
export interface TerminalCloseFailure {
  readonly id: WebTerminalId
  readonly title: string
  readonly message: string
}

/** Session and occurrence lookup, independent tab and terminal identities and background cleanup. */
export class ClientTerminals extends Service {
  /** Failed cleanup tasks; successful and in-progress closes have no visible notification. */
  readonly closeFailures: SnapshotStore<readonly TerminalCloseFailure[]> = createSnapshotStore<readonly TerminalCloseFailure[]>([])
  private readonly requests = new TerminalCloseRequests()
  private readonly closing = new Map<WebTerminalId, Promise<void>>()
  private readonly closed = new Set<WebTerminalId>(this.requests.pending().map(request => request.id))
  private disposed = false
  private readonly views = new Map<SessionId, Map<string, TerminalView>>()

  /**
   * @param ctx - Client root Context with Gateway and terminal Remote namespace.
   * @param remote - generated terminal namespace.
   */
  constructor(ctx: Context, private readonly remote: TerminalRemote) {
    super(ctx, 'webTerminals')
    ctx.effect(() => async () => {
      this.disposed = true
      const detaching = [...this.views.values()].flatMap(views => [...views.values()].map(view => view.dispose()))
      this.views.clear()
      await Promise.all([...detaching, ...this.closing.values()])
    }, 'terminal-controller.client.views')
    for (const request of this.requests.pending()) this.cleanup(request)
  }

  /**
   * Return the stable model for one sidebar occurrence.
   * @param sessionId - owning Session.
   * @param key - sidebar occurrence key.
   * @param terminalId - existing Host identity when restoring a listed terminal.
   * @returns its observable state and terminal commands.
   */
  view(sessionId: SessionId, key: string, terminalId?: WebTerminalId): TerminalView {
    let views = this.views.get(sessionId)
    if (views === undefined) { views = new Map(); this.views.set(sessionId, views) }
    let view = views.get(key)
    if (view === undefined) {
      const id = terminalId ?? randomUUID() as WebTerminalId
      view = new TerminalView(sessionId, this.remote, this.ctx.remote, id, terminalId === undefined)
      views.set(key, view)
      void view.refresh()
    }
    return view
  }

  /**
   * Save a close intent and release the tab immediately; cleanup outlives DOM unmount and reload.
   * @param sessionId - owning Session.
   * @param key - sidebar occurrence key, including an inactive restored tab.
   * @param terminalId - restored identity if the tab has no model yet.
   */
  close(sessionId: SessionId, key: string, terminalId?: WebTerminalId): void {
    const views = this.views.get(sessionId)
    const view = views?.get(key)
    const id = view?.id ?? terminalId
    if (id === undefined) return
    const request: TerminalCloseRequest = { sessionId, id, title: view?.state.getSnapshot().title ?? key }
    this.closed.add(id)
    this.requests.save(request)
    views?.delete(key)
    if (views?.size === 0) this.views.delete(sessionId)
    this.cleanup(request, view)
  }

  /**
   * Query Host terminals that have neither a tab in this page nor an unfinished close.
   * @param sessionId - Session being displayed.
   * @returns terminals available for opening as recovered tabs.
   */
  async recover(sessionId: SessionId): Promise<WebTerminalInfo[]> {
    const result = await this.remote.list(sessionId)
    if (!result.ok) throw new Error(result.error.message)
    const held = new Set([...(this.views.get(sessionId)?.values() ?? [])].map(view => view.id))
    const closing = new Set(this.requests.pending().map(request => request.id))
    return result.value.filter(info => !held.has(info.id) && !closing.has(info.id) && !this.closed.has(info.id))
  }

  /**
   * Retry a saved close request without reopening its tab.
   * @param id - failed terminal identity.
   */
  retryClose(id: WebTerminalId): void {
    const record = this.requests.pending().find(item => item.id === id)
    if (record !== undefined) this.cleanup(record)
  }

  private cleanup(record: TerminalCloseRequest, view?: TerminalView): void {
    if (this.closing.has(record.id) || this.disposed) return
    this.closeFailures.set(this.closeFailures.getSnapshot().filter(failure => failure.id !== record.id))
    const pending = (async () => {
      if (view !== undefined) await view.close()
      else {
        const result = await this.remote.close(record.sessionId, record.id)
        if (!result.ok) throw result.error
      }
      this.requests.remove(record.id)
    })().catch((error: unknown) => {
      if (remoteErrorOf(error)?.code === 'session/not-found') {
        this.requests.remove(record.id)
        return
      }
      if (!this.disposed) this.closeFailures.set([...this.closeFailures.getSnapshot(), {
        id: record.id, title: record.title,
        message: error instanceof Error ? error.message : String(error),
      }])
    }).then(async () => {
      await view?.dispose()
      this.closing.delete(record.id)
    })
    this.closing.set(record.id, pending)
  }
}

/** Required Client transport and terminal namespace. */
export const inject = ['remote', 'remote.terminal']

/**
 * Install the Client terminal models.
 * @param ctx - Client root Context.
 */
export function apply(ctx: Context): void {
  new ClientTerminals(ctx, ctx.remote.terminal)
}
