/** Synthesis availability derived from the configured DeepSeek credentials; no service is contacted. */
import type { SynthesisAvailability, SynthesisAvailabilitySource } from '@deepseek-ai/dsh-text-to-speech/types'

/** Published credential state. The newest inspection wins, and a stopped source publishes nothing. */
export class CredentialAvailability implements SynthesisAvailabilitySource {
  private current: SynthesisAvailability = { phase: 'unavailable', reason: 'sign-in-required' }
  private readonly listeners = new Set<() => void>()
  private round = 0
  private stopped = false

  /** @param inspect - credential check, rerun whenever a credential may have changed. */
  constructor(private readonly inspect: () => Promise<SynthesisAvailability>) {}

  /** @returns the latest published state. */
  snapshot(): SynthesisAvailability { return this.current }

  /** @param listener - invalidation callback. @returns subscription disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Inspect the credentials and publish the result; a rejected inspection publishes `failed`.
   * @returns after this inspection settles, whether or not a newer one replaced it.
   */
  async refresh(): Promise<void> {
    const round = ++this.round
    const next = await this.inspect().catch((error: unknown): SynthesisAvailability =>
      ({ phase: 'failed', message: error instanceof Error ? error.message : String(error) }))
    if (round !== this.round || this.stopped) return
    this.current = next
    for (const listener of this.listeners) listener()
  }

  /** Stop publishing; inspections still running settle without notifying. */
  stop(): void {
    this.stopped = true
    this.listeners.clear()
  }
}
