/**
 * Command-directory cache keyed by session: one entry per served catalog —
 * every session is agent-backed, so `command.list({sessionId})` is the only
 * request fields. Each entry keeps the single-flight / soft-hard invalidation
 * / epoch-guard behavior of the original global cache; the session-key axis
 * is the only extra dimension.
 */
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveCommand } from './resolution.ts'

export type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'

/**
 * cold = never pulled; pending = pull in flight with nothing servable;
 * ready = snapshot serving (a soft-invalidate repull keeps this status);
 * failed = last winning pull rejected, snapshot dropped.
 */
export type DirectoryStatus = 'cold' | 'pending' | 'ready' | 'failed'

/** Injected pull (the service binds command.list off the root connection). */
export type FetchCommands = (sessionId: SessionId) => Promise<readonly CommandDescriptor[]>

/** One session key's cache cell. */
class Entry {
  state: DirectoryStatus = 'cold'
  commands: readonly CommandDescriptor[] = []
  /** Bumped at each pull start; only the latest pull may publish its outcome. */
  epoch = 0
  lastError: unknown
  waiters: Array<() => void> = []
}

/** The session-keyed directory cache. Plain class — the owning service wires events and RPC. */
export class CommandDirectory {
  private readonly entries = new Map<SessionId, Entry>()

  constructor(private readonly fetchCommands: FetchCommands) {}

  /**
   * Current cache status for one session.
   * @param sessionId - session key.
   * @returns the entry status (cold when never touched).
   */
  status(sessionId: SessionId): DirectoryStatus {
    return this.entries.get(sessionId)?.state ?? 'cold'
  }

  /**
   * Synchronous command lookup over one Session's ready catalog; exact names precede localized aliases.
   * @param sessionId - session key.
   * @param name - typed command spelling without the leading slash.
   * @returns the descriptor, or undefined when absent or the entry is not ready.
   */
  resolve(sessionId: SessionId, name: string): CommandDescriptor | undefined {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.state !== 'ready') return undefined
    return resolveCommand(name, entry.commands)
  }

  /** Soft invalidation (commands-changed): background repull on every touched key; ready snapshots keep serving. */
  invalidateAll(): void {
    for (const key of this.entries.keys()) void this.refresh(key)
  }

  /**
   * Drop one Session's obsolete composition-specific snapshot and prewarm its replacement.
   * @param sessionId - Session whose effective command composition changed.
   */
  resetSession(sessionId: SessionId): void {
    const entry = this.entry(sessionId)
    entry.state = 'cold'
    entry.commands = []
    entry.lastError = undefined
    void this.refresh(sessionId)
  }

  /**
   * Hard reset on reconnect: every entry drops its snapshot (the agent world
   * may have changed shape across the generation) and prewarms.
   */
  resetConnected(): void {
    for (const [key, entry] of this.entries) {
      entry.state = 'cold'
      entry.commands = []
      void this.refresh(key)
    }
  }

  /**
   * Fire-and-forget prewarm of one session (the command source's scope-birth
   * warm hook lands here).
   * @param sessionId - session key.
   */
  warm(sessionId: SessionId): void {
    const entry = this.entry(sessionId)
    if (entry.state === 'cold' || entry.state === 'failed') void this.refresh(sessionId)
  }

  /**
   * Start one pull for one session. Publishes ready/failed only while it is
   * still the key's latest pull (epoch guard); a ready snapshot is not
   * demoted while the pull flies.
   * @param sessionId - session key.
   * @returns settled when this pull's outcome is published or discarded.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    const entry = this.entry(sessionId)
    const epoch = ++entry.epoch
    if (entry.state !== 'ready') entry.state = 'pending'
    try {
      const commands = await this.fetchCommands(sessionId)
      if (epoch !== entry.epoch) return
      entry.commands = commands
      entry.state = 'ready'
      entry.lastError = undefined
    } catch (error) {
      if (epoch !== entry.epoch) return
      entry.commands = []
      entry.state = 'failed'
      entry.lastError = error
    } finally {
      if (epoch === entry.epoch) notifyWaiters(entry)
    }
  }

  /**
   * Strong-wait until one session's catalog is servable (the enter-
   * adjudication "directory must be reached" rule): ready returns at once;
   * cold/failed launch a fresh pull; pending joins the flying one. Rejects
   * when the awaited pull fails or the signal aborts.
   * @param sessionId - session key.
   * @param signal - attempt-scoped abort (the SubmitAttempt signal).
   * @returns the hot command snapshot.
   */
  async ensureReady(sessionId: SessionId, signal: AbortSignal): Promise<readonly CommandDescriptor[]> {
    const entry = this.entry(sessionId)
    while (true) {
      if (entry.state === 'ready') return entry.commands
      if (entry.state !== 'pending') void this.refresh(sessionId)
      await settled(entry, signal)
      if (entry.state === 'failed') {
        throw new Error(`command directory warmup failed: ${entry.lastError instanceof Error ? entry.lastError.message : String(entry.lastError)}`)
      }
      // Still pending (the awaited pull was superseded) → wait for the winner.
    }
  }

  private entry(sessionId: SessionId): Entry {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = new Entry()
      this.entries.set(sessionId, entry)
    }
    return entry
  }
}

/** One settlement tick for one entry: resolves at the next winning publish, rejects on abort. */
function settled(entry: Entry, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const waiter = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      entry.waiters = entry.waiters.filter(w => w !== waiter)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.waiters.push(waiter)
  })
}

function notifyWaiters(entry: Entry): void {
  const woken = entry.waiters
  entry.waiters = []
  for (const wake of woken) wake()
}

/** Normalize an abort into an Error rejection. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('command directory wait aborted')
}
