/** Browser download state shared by the Session Header button and `/export`. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SESSION_LOG_EXPORT_ROUTE } from '../routes.ts'

/** Download phases presented by the shared modal. */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'error'

/** One Session's current download-dialog state. */
export interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: SessionLogDownloadStatus
  readonly error: string | null
}

/** Download states keyed by the Session whose Header owns the dialog. */
export interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

/** HTTP carrier for the export route. */
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Save = (url: string, filename: string) => void

const INITIAL: SessionLogDownloadState = { bySession: {} }

/**
 * Collapse an untrusted Session id into the filename convention owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

/**
 * Hand a Host download route to the browser download manager, which resolves it
 * against the document's own base.
 * @param url - document-relative Host download route.
 * @param filename - browser download filename.
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns one in-flight browser download per Session and publishes modal state. */
export class SessionLogDownloadController {
  /** uSES-safe state source shared by every Session-scoped modal contribution. */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param fetcher - HTTP carrier used to read the host-streamed ZIP.
   * @param save - browser save operation.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly save: Save = downloadUrl,
  ) {}

  /**
   * Download one Session tree; concurrent gestures for the same Session share one operation.
   * @param sessionId - root Session whose ZIP includes descendants and attachments.
   * @returns after the browser save starts, an error state is published, or a late post-disposal request is ignored.
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Close one Session's dialog without cancelling an in-flight browser download.
   * @param sessionId - Session whose modal closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Abort active fetches and reach quiescence.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const query = new URLSearchParams({ sessionId, includeDescendants: 'true' })
      const route = `${SESSION_LOG_EXPORT_ROUTE}?${query.toString()}`
      const response = await this.fetcher(route, { method: 'HEAD', signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
      }
      this.save(route, sessionLogZipFilename(sessionId))
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
