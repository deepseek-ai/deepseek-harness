/** One reference-counted terminal roster stream per watched Session. */
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalRemote } from './model.ts'
import type { WebTerminalInfo } from '../types.ts'

/** Receives each whole roster; a listener added to a live stream first receives its latest roster. */
export type TerminalRosterListener = (terminals: readonly WebTerminalInfo[]) => void

interface RosterEntry {
  readonly listeners: Set<TerminalRosterListener>
  latest: readonly WebTerminalInfo[] | undefined
  stopped: boolean
  /** Disposes the live stream; undefined after the stream failed and before it reopens. */
  dispose: (() => Promise<void>) | undefined
}

/**
 * Shares one Host roster stream among a Session's watchers and stops it with the last watcher. A stream that fails
 * while watched reopens for its remaining watchers on the next watch of that Session or on {@link TerminalRosters.resume}.
 */
export class TerminalRosters {
  private readonly entries = new Map<SessionId, RosterEntry>()
  private readonly stopping = new Set<Promise<void>>()

  /**
   * @param gateway - Client Remote carrier captured while the plugin context is current.
   * @param remote - generated terminal namespace.
   * @param received - shared state update applied before listeners run.
   * @param failed - diagnostic sink for listener and stream failures.
   */
  constructor(
    private readonly gateway: Pick<ClientRemote, '$stream'>,
    private readonly remote: Pick<TerminalRemote, 'watch'>,
    private readonly received: (sessionId: SessionId, terminals: readonly WebTerminalInfo[]) => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  /**
   * Watch one Session's terminals.
   * @param sessionId - watched Session.
   * @param listener - called with every roster while watched.
   * @returns the release; the stream stops when its last watcher releases.
   */
  watch(sessionId: SessionId, listener: TerminalRosterListener): () => void {
    let entry = this.entries.get(sessionId)
    if (entry === undefined || entry.stopped) {
      entry = { listeners: new Set(), latest: undefined, stopped: false, dispose: undefined }
      this.entries.set(sessionId, entry)
    }
    if (entry.dispose === undefined) this.open(sessionId, entry)
    entry.listeners.add(listener)
    if (entry.latest !== undefined) this.notify(listener, entry.latest)
    const owned = entry
    let released = false
    return () => {
      if (released) return
      released = true
      owned.listeners.delete(listener)
      if (owned.listeners.size > 0) return
      if (this.entries.get(sessionId) === owned) this.entries.delete(sessionId)
      this.stop(owned)
    }
  }

  /**
   * Reopen the streams that failed while watched, for example after the connection is replaced.
   */
  resume(): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.dispose === undefined) this.open(sessionId, entry)
    }
  }

  /**
   * Stop every stream.
   * @returns after every stream has closed.
   */
  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) this.stop(entry)
    this.entries.clear()
    await Promise.all(this.stopping)
  }

  private open(sessionId: SessionId, entry: RosterEntry): void {
    const name = `terminal roster ${String(sessionId)}`
    const stream = this.gateway.$stream<WebTerminalInfo[]>({
      name,
      open: signal => this.remote.watch(sessionId, signal),
      // The roster has no natural end while watched: an end after the first frame is a carrier interruption.
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before release`)
        : new Error(`${name} ended before its first frame`),
    })
    const dispose = (): Promise<void> => stream.dispose()
    entry.dispose = dispose
    void (async () => {
      try {
        for await (const item of stream) {
          entry.latest = item.value
          this.received(sessionId, item.value)
          for (const listener of [...entry.listeners]) this.notify(listener, item.value)
          item.accept()
        }
      } catch (error) {
        // Disposal ends the stream without an error, so every caught failure is a live stream failure.
        this.failed(error)
      } finally {
        if (entry.dispose === dispose) {
          entry.dispose = undefined
          this.track(dispose())
        }
      }
    })()
  }

  private notify(listener: TerminalRosterListener, terminals: readonly WebTerminalInfo[]): void {
    try { listener(terminals) } catch (error) { this.failed(error) }
  }

  private stop(entry: RosterEntry): void {
    if (entry.stopped) return
    entry.stopped = true
    const dispose = entry.dispose
    entry.dispose = undefined
    if (dispose !== undefined) this.track(dispose())
  }

  private track(disposal: Promise<void>): void {
    const stopping = disposal.finally(() => { this.stopping.delete(stopping) })
    this.stopping.add(stopping)
  }
}
