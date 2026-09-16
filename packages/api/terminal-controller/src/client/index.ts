/** Client terminal model service; views are keyed independently from Host terminal identities. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { TerminalView, type TerminalRemote } from './model.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TerminalShell, WebTerminalId, WebTerminalInfo } from '../types.ts'
import { preferredShell, rememberShell } from './shell-preference.ts'
import { TerminalCloseRequests, type TerminalCloseRequest } from './close-requests.ts'
import { TerminalWindowHold } from './retention.ts'
import { TerminalBindings } from './bindings.ts'

export type { TerminalView, TerminalViewState, TerminalViewIssue, TerminalRenderFrame, TerminalRemote } from './model.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free browser terminal views and explicit process cleanup. */
    webTerminals: ClientTerminals
  }
}

/** Host-discovered shell menu with the browser's remembered available choice. */
export interface TerminalLaunchShells {
  readonly shells: readonly TerminalShell[]
  readonly selectedShell: string | undefined
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
  private readonly bindings = new TerminalBindings()
  private readonly holds = new Map<SessionId, Map<WebTerminalId, TerminalWindowHold>>()
  private readonly releasing = new Set<Promise<void>>()
  private openTabs: readonly { sessionId: SessionId; tabId: string; contentId: string }[] = []

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
      this.bindings.clear()
      const holds = [...this.holds.values()].flatMap(holds => [...holds.values()].map(hold => hold.dispose()))
      this.holds.clear()
      await Promise.all([...detaching, ...holds, ...this.releasing, ...this.closing.values()])
    }, 'terminal-controller.client.views')
    for (const request of this.requests.pending()) this.cleanup(request)
  }

  /**
   * Return the stable model for one sidebar occurrence.
   * @param sessionId - owning Session.
   * @param key - sidebar occurrence key.
   * @param contentId - globally unique content identity; layout-local tab ids are not persistence keys.
   * @param terminalId - existing Host identity when restoring a listed terminal; otherwise reuse the saved content identity.
   * @param shellPath - explicit shell for a new terminal; restored terminals retain their own shell.
   * @returns its observable state and terminal commands.
   */
  view(sessionId: SessionId, key: string, contentId: string, terminalId?: WebTerminalId, shellPath?: string): TerminalView {
    let views = this.views.get(sessionId)
    if (views === undefined) { views = new Map(); this.views.set(sessionId, views) }
    let view = views.get(key)
    if (view === undefined) {
      const saved = terminalId ?? this.bindings.get(sessionId, contentId)
      const id = saved ?? randomUUID() as WebTerminalId
      this.bindings.set(sessionId, contentId, id)
      view = new TerminalView(sessionId, this.remote, this.ctx.remote, id, saved === undefined, shellPath,
        signal => this.hold(sessionId, id).ready(signal))
      views.set(key, view)
      this.reconcileHolds()
      void view.refresh()
    }
    return view
  }

  /**
   * Discover available launch choices on demand without allocating a PTY.
   * @param sessionId - target Session.
   * @param signal - the menu request lifetime.
   * @returns installed shells and the currently usable browser preference.
   */
  async launchShells(sessionId: SessionId, signal: AbortSignal): Promise<TerminalLaunchShells> {
    const result = await this.remote.shells(sessionId, signal)
    if (!result.ok) throw new Error(result.error.message)
    const previous = preferredShell()
    return { shells: result.value, selectedShell: result.value.find(shell => shell.path === previous)?.path ?? result.value[0]?.path }
  }

  /**
   * Remember the guide selection before allocating its terminal tab.
   * @param path - shell selected from Host discovery.
   */
  selectShell(path: string): void { rememberShell(path) }

  /**
   * Save a close intent and release the tab immediately; cleanup outlives DOM unmount and reload.
   * @param sessionId - owning Session.
   * @param key - sidebar occurrence key, including an inactive restored tab.
   * @param contentId - globally unique content identity whose binding is removed.
   * @param terminalId - restored identity if the tab has no model yet.
   */
  close(sessionId: SessionId, key: string, contentId: string, terminalId?: WebTerminalId): void {
    const views = this.views.get(sessionId)
    const view = views?.get(key)
    const id = view?.id ?? terminalId ?? this.bindings.get(sessionId, contentId)
    if (id === undefined) return
    const request: TerminalCloseRequest = { sessionId, id, title: view?.state.getSnapshot().title ?? key }
    this.closed.add(id)
    this.requests.save(request)
    this.bindings.delete(sessionId, contentId)
    views?.delete(key)
    if (views?.size === 0) this.views.delete(sessionId)
    this.cleanup(request, view)
    this.reconcileHolds()
  }

  /**
   * Reconcile this window's open terminal occurrences, including dormant saved Sessions.
   * @param tabs - terminal-kind membership supplied by the sidebar layout owner.
   */
  retainTabs(tabs: readonly { sessionId: SessionId; tabId: string; contentId: string }[]): void {
    this.openTabs = tabs
    this.reconcileHolds()
  }

  private hold(sessionId: SessionId, id: WebTerminalId): TerminalWindowHold {
    let holds = this.holds.get(sessionId)
    if (holds === undefined) { holds = new Map(); this.holds.set(sessionId, holds) }
    let hold = holds.get(id)
    if (hold === undefined || hold.failed) {
      if (hold !== undefined) this.release(hold)
      hold = new TerminalWindowHold(this.ctx.remote, this.remote, sessionId, id)
      holds.set(id, hold)
    }
    return hold
  }

  private reconcileHolds(): void {
    if (this.disposed) return
    const wanted = new Map<SessionId, Set<WebTerminalId>>()
    for (const tab of this.openTabs) {
      const id = this.bindings.get(tab.sessionId, tab.contentId)
      if (id === undefined || this.closed.has(id)) continue
      let ids = wanted.get(tab.sessionId)
      if (ids === undefined) { ids = new Set(); wanted.set(tab.sessionId, ids) }
      ids.add(id)
      const view = this.views.get(tab.sessionId)?.get(tab.tabId)
      if (view === undefined || view.state.getSnapshot().info !== undefined) {
        if (!this.holds.get(tab.sessionId)?.has(id)) this.hold(tab.sessionId, id)
      }
    }
    for (const [sessionId, holds] of this.holds) {
      for (const [id, hold] of holds) {
        if (!wanted.get(sessionId)?.has(id)) { holds.delete(id); this.release(hold) }
      }
      if (holds.size === 0) this.holds.delete(sessionId)
    }
  }

  private release(hold: TerminalWindowHold): void {
    const releasing = hold.dispose().finally(() => { this.releasing.delete(releasing) })
    this.releasing.add(releasing)
    void releasing.catch((error: unknown) => { this.ctx.logger.warn('Terminal hold release failed', error) })
  }

  /**
   * Query Host terminals without a live view or unfinished close.
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
