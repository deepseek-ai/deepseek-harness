/**
 * Host desktop availability, file associations, and open/reveal actions over the Session Remote.
 * The desktop answer is read once per page; a failed read renders no control. Association answers
 * are recorded per association class so menus can show them without waiting for the Host.
 */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionOpenWorkspacePathRequest, SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import type { OpenInAppOutcome, OpenInAppPathFailure } from './outcome.ts'

type Applications = readonly SessionWorkspacePathApplication[]

/**
 * Name the association class of a Host path: desktops look handlers up by the final name extension, so
 * files sharing it share one answer; a name without one (`Makefile`, `.env`) is its own class.
 */
function associationKey(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? `extension:${name.slice(dot)}` : `path:${path}`
}

/** The compared application fields; a field added to the type fails to compile until it is listed here. */
const APPLICATION_FIELDS = Object.keys({
  id: true, name: true, default: true, icon: true,
} satisfies Record<keyof SessionWorkspacePathApplication, true>) as readonly (keyof SessionWorkspacePathApplication)[]

/** Equal answers keep the published snapshot, so observers re-resolve only when an answer changes. */
function sameApplications(left: Applications, right: Applications): boolean {
  return left.length === right.length && left.every((app, index) => {
    const other = right[index]
    return other !== undefined && APPLICATION_FIELDS.every(field => app[field] === other[field])
  })
}

/** What a path gesture asks of the Host desktop: the default application, or the file manager showing the file. */
export type OpenInAppPathAction = 'open' | 'reveal'

/** The slice of the Client Remote the path actions call. */
export interface OpenInAppPathRemote {
  readonly session: {
    /** Whether the Host can hand a workspace path to a native desktop. */
    canOpenWorkspacePath(): Promise<RemoteResult<boolean>>
    /** Current registered file handlers and their default selection. */
    workspacePathApplications(
      request: { path: string }, signal?: AbortSignal,
    ): Promise<RemoteResult<readonly SessionWorkspacePathApplication[]>>
    /** Open one Host path in its default application, or reveal it in the file manager. */
    openWorkspacePath(request: SessionOpenWorkspacePathRequest, signal?: AbortSignal): Promise<RemoteResult<unknown>>
  }
}

/**
 * Page-lifetime desktop availability, association answers, and the open/reveal carrier shared by every path control.
 * Answers are kept per association class for the page's life and grow with the classes queried.
 */
export class OpenInAppPathController {
  /** Whether the Host desktop can open paths; null until the Host answered, false also after a failed read. */
  readonly desktop: SnapshotStore<boolean | null> = createSnapshotStore<boolean | null>(null)
  private readonly answers = createSnapshotStore<ReadonlyMap<string, Applications>>(new Map())
  /** Latest successful answer per association class; the snapshot keeps its identity until an answer changes. */
  readonly associations: ObservableSnapshot<ReadonlyMap<string, Applications>> = this.answers
  private loading: Promise<void> | undefined
  private readonly lifetime = new AbortController()
  /** The latest background refresh; a newer refresh aborts it. */
  private refresh: AbortController | undefined
  /** Start order of the query whose answer each class holds; an earlier query never replaces a later one. */
  private readonly answeredBy = new Map<string, number>()
  /** One icon string per application id, reused by every class that lists the application so its data URL is held once. */
  private readonly icons = new Map<string, string>()
  private queries = 0

  /**
   * @param remote - the Session Remote namespace answering availability and running gestures.
   */
  constructor(private readonly remote: OpenInAppPathRemote) {}

  /**
   * Read desktop availability once per controller life; concurrent calls share the read.
   * @returns after availability is published.
   */
  load(): Promise<void> {
    this.loading ??= this.run()
    return this.loading
  }

  /**
   * Open one Host path in its default application, or reveal it in the file manager.
   * @param path - absolute path on the Host, as the file's metadata reports it.
   * @param action - default application open, or file-manager reveal.
   * @param application - registered application path for an explicit open.
   * @returns the acknowledged open or reveal, or the named failure to announce.
   */
  async openPath(path: string, action: OpenInAppPathAction, application?: string): Promise<OpenInAppOutcome> {
    const request: SessionOpenWorkspacePathRequest = action === 'reveal' ? { path, action } : { path, ...(application === undefined ? {} : { application }) }
    let ok = false
    try {
      ok = (await this.remote.session.openWorkspacePath(request)).ok
    } catch {
      // Swallows carrier rejections: a Host that cannot be reached failed the
      // gesture like a Host that refused it, and the control announces that.
    }
    if (ok) return { kind: action === 'reveal' ? 'revealed' : 'opened' }
    const failure: OpenInAppPathFailure = action === 'open' ? 'openError' : 'revealError'
    return { kind: 'failed', failure }
  }

  /**
   * Query the file's current OS associations and record a successful answer for its association class.
   * Failures remain distinct from an empty handler list and leave the recorded answer in place.
   * @param path - file path reported by the Host.
   * @param signal - lifetime of the requesting control.
   * @returns application metadata, or null when the query fails.
   */
  async applications(path: string, signal: AbortSignal): Promise<Applications | null> {
    const order = ++this.queries
    let result: RemoteResult<Applications>
    try {
      result = await this.remote.session.workspacePathApplications({ path }, signal)
    } catch (_error) {
      // The control reports query failure and keeps file reveal available.
      return null
    }
    if (!result.ok) return null
    this.record(associationKey(path), order, result.value)
    return result.value
  }

  /**
   * Read the recorded answer of a file's association class without querying the Host.
   * @param path - absolute Host path of the file.
   * @returns the latest successful answer, or undefined before a query of this class succeeded.
   */
  cachedApplications(path: string): Applications | undefined {
    return this.answers.getSnapshot().get(associationKey(path))
  }

  /**
   * Re-query a file's associations in the background. One refresh runs at a time: it outlives the
   * requesting menu and ends with its answer, the next refresh, which cancels it, or {@link dispose}.
   * @param path - absolute Host path of the file.
   * @returns settles without rejecting when this refresh's query settles, after any answer is recorded;
   * already settled after {@link dispose}.
   */
  refreshApplications(path: string): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.refresh?.abort()
    const refresh = new AbortController()
    this.refresh = refresh
    return this.applications(path, AbortSignal.any([this.lifetime.signal, refresh.signal])).then(() => {})
  }

  /** Cancel background refreshes and refuse new ones; recorded answers stay readable. */
  dispose(): void {
    this.lifetime.abort()
  }

  private record(key: string, order: number, applications: Applications): void {
    if ((this.answeredBy.get(key) ?? 0) > order) return
    this.answeredBy.set(key, order)
    const answers = this.answers.getSnapshot()
    const previous = answers.get(key)
    if (previous !== undefined && sameApplications(previous, applications)) return
    const next = new Map(answers)
    next.set(key, applications.map((app) => {
      if (app.icon === null) return app
      const icon = this.icons.get(app.id)
      if (icon === app.icon) return { ...app, icon }
      this.icons.set(app.id, app.icon)
      return app
    }))
    this.answers.set(next)
  }

  private async run(): Promise<void> {
    let available = false
    try {
      const result = await this.remote.session.canOpenWorkspacePath()
      available = result.ok && result.value
    } catch {
      // Swallows carrier rejections: an unreachable Host reads as no desktop,
      // so the preview shows no path control rather than a broken one.
    }
    this.desktop.set(available)
  }
}
