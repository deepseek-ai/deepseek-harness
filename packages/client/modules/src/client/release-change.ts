/** Which Host graphs a page may apply: only graphs of the release the page booted from. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WebBootRelease } from './manifest.ts'
import { notifySubscribers } from './notify.ts'

/** The connected Host serves another release than the one this page booted from; plugin updates wait for a page reload. */
export interface ClientReleaseChange {
  /** Release this page booted from; every module the page runs belongs to it. */
  readonly page: WebBootRelease | undefined
  /** Release the Host served before its latest release change. */
  readonly previous: WebBootRelease | undefined
  /** Release of the connected Host. */
  readonly host: WebBootRelease | undefined
}

/** Whether two releases are the same: both absent, or equal in every field. */
function sameRelease(left: WebBootRelease | undefined, right: WebBootRelease | undefined): boolean {
  return left?.version === right?.version && left?.commit === right?.commit
}

/** Release identity as diagnostic text. */
function describeRelease(release: WebBootRelease | undefined): string {
  return release === undefined ? 'none' : JSON.stringify(release)
}

/**
 * Tracks the connected Host's release against the page's boot release. The page applies graphs and
 * rebuilt frames only while both match, so every module it runs belongs to its boot release; another
 * release waits for a page reload. A mismatch is announced unless the page dismissed that Host release.
 */
export class ReleaseChangeGate {
  /** Prompt-worthy release change; undefined while the Host serves the boot release or a dismissed one. */
  readonly change: ObservableSnapshot<ClientReleaseChange | undefined> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  private snapshot: ClientReleaseChange | undefined
  private readonly listeners = new Set<() => void>()
  private host: WebBootRelease | undefined
  /** Host release the page last dismissed; a holder because an unpublished release is itself a value. */
  private dismissed: { readonly release: WebBootRelease | undefined } | undefined

  /**
   * Start with the Host that served the boot graph.
   * @param page - boot graph's release identity.
   */
  constructor(private readonly page: WebBootRelease | undefined) {
    this.host = page
  }

  /** Whether the connected Host serves the page's boot release; graphs and rebuilt frames apply only then. */
  get matches(): boolean {
    return sameRelease(this.host, this.page)
  }

  /**
   * Record the release of a received Host graph and update the announced change.
   * @param release - release identity of the received graph.
   * @returns true when the graph belongs to the page's boot release and may be applied.
   */
  observe(release: WebBootRelease | undefined): boolean {
    const previous = this.host
    this.host = release
    const quiet = this.matches || (this.dismissed !== undefined && sameRelease(release, this.dismissed.release))
    if (quiet) {
      if (this.snapshot !== undefined) this.publish(undefined)
    } else if (this.snapshot === undefined || !sameRelease(this.snapshot.host, release)) {
      console.warn(`client-modules: Host release changed from ${describeRelease(previous)} to ${describeRelease(release)}; plugin updates pause until this page reloads`)
      this.publish({ page: this.page, previous, host: release })
    }
    return this.matches
  }

  /** Stop announcing the connected Host's release; the page keeps its boot release and still applies no other release. */
  dismiss(): void {
    if (this.snapshot === undefined) return
    this.dismissed = { release: this.host }
    this.publish(undefined)
  }

  private publish(snapshot: ClientReleaseChange | undefined): void {
    this.snapshot = snapshot
    notifySubscribers(this.listeners, 'release change')
  }
}
