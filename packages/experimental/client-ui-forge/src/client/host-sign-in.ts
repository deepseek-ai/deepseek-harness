/** Sign-in state of the hosts a provider row serves, read through `forgePanel.hostReadiness`. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ForgeReadiness } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** What the page knows of one host: its readiness once read, or that the first read is under way. */
export type HostSignIn = ForgeReadiness | { readonly state: 'checking' }

/** Reads one host's readiness; the signal ends the read. */
export type HostReadinessRead = (host: string, signal: AbortSignal) => Promise<RemoteResult<ForgeReadiness>>

/**
 * Keeps the last read sign-in state of each host of one provider. A check reads every named host at once and forgets
 * the hosts it does not name; a later check ends the reads of an earlier one.
 */
export class HostSignInStates {
  /** Sign-in state by host as the provider's configuration lists it. */
  readonly states: SnapshotStore<ReadonlyMap<string, HostSignIn>> = createSnapshotStore<ReadonlyMap<string, HostSignIn>>(new Map())
  private reads = new AbortController()

  /** @param read - one host's readiness read. */
  constructor(private readonly read: HostReadinessRead) {}

  /**
   * Read the sign-in state of `hosts`.
   * @param hosts - every host to keep a state for.
   * @param visibly - show each host as being checked until its read answers; otherwise a host keeps the state it has.
   */
  check(hosts: readonly string[], visibly: boolean): void {
    this.reads.abort()
    const reads = new AbortController()
    this.reads = reads
    const known = this.states.getSnapshot()
    this.states.set(new Map(hosts.map(host => [host, visibly ? { state: 'checking' } : known.get(host) ?? { state: 'checking' }])))
    for (const host of hosts) {
      void this.read(host, reads.signal).then((result) => {
        if (reads.signal.aborted) return
        const readiness: ForgeReadiness = result.ok ? result.value : { state: 'unavailable', message: result.error.message, signIn: null }
        this.states.set(new Map(this.states.getSnapshot()).set(host, readiness))
      })
    }
  }

  /** End the reads under way; their answers are dropped. */
  dispose(): void { this.reads.abort() }
}
