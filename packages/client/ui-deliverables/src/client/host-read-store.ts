/**
 * Fetch-once cache of Host-served records keyed by their authenticated URL:
 * one read per URL while a state stands, cleared on connection replacement,
 * cancelled on disposal. Each store decides what a response means and which
 * states a later request reads again.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What one store makes of its reads. */
export interface HostReadPolicy<T> {
  /** The state published while a request runs. */
  loading: T
  /** The state a transport failure publishes. */
  failed: T
  /**
   * Whether a later request replaces a standing state with a new read.
   * @param state - the standing state.
   * @returns true to read again.
   */
  retryable(state: T): boolean
  /**
   * Turn a settled response into a state.
   * @param response - the Host's answer.
   * @returns the state to publish.
   */
  decode(response: Response): Promise<T>
}

/** One browser plugin's reads of one record kind. */
export class HostReadStore<T> {
  /** Record URLs key the state across Sessions and turns. */
  readonly state = createSnapshotStore<Record<string, T | undefined>>({})
  private readonly lifetime = new AbortController()
  /** The connection generation the current states belong to; a reset aborts it so no older read publishes. */
  private generation = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly policy: HostReadPolicy<T>) {}

  /**
   * Read one URL unless a state the policy keeps already stands for it.
   * @param url - the record's authenticated URL.
   * @returns after the state is published.
   */
  protected async loadUrl(url: string): Promise<void> {
    const current = this.state.getSnapshot()[url]
    if (this.lifetime.signal.aborted || (current !== undefined && !this.policy.retryable(current))) return
    this.state.update((state) => { state[url] = this.policy.loading })
    const task = this.read(url, AbortSignal.any([this.lifetime.signal, this.generation.signal]))
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }

  /** Forget every state and abandon in-flight reads; a replaced connection may reach a Host that no longer serves them. */
  reset(): void {
    this.generation.abort()
    this.generation = new AbortController()
    this.state.set({})
  }

  /** Cancel outstanding reads and wait until none can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all(this.pending)
  }

  private async read(url: string, signal: AbortSignal): Promise<void> {
    let next: T
    try {
      next = await this.policy.decode(await fetch(url, { signal }))
    } catch {
      // A transport failure publishes the policy's failed state until the connection is replaced and the store reset.
      next = this.policy.failed
    }
    if (!signal.aborted) this.state.update((state) => { state[url] = next })
  }
}
