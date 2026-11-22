/** Recording readiness derived from the configured DeepSeek credentials; nothing is downloaded or contacted. */
import type { SpeechPreparation, SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/**
 * Inspect whether recordings can be sent now.
 * @returns the complete state to publish.
 */
export type ReadinessInspection = () => Promise<SpeechPreparationState>

/** Host-owned cloud readiness; the latest inspection wins and disposal stops publication. */
export class CloudReadiness implements SpeechPreparation {
  private state: SpeechPreparationState = { phase: 'unavailable', reason: 'sign-in-required' }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private closed = false

  /** @param inspection - credential check, rerun whenever a credential may have changed. */
  constructor(private readonly inspection: ReadinessInspection) {}

  /** @returns the latest published state. */
  snapshot(): SpeechPreparationState { return this.state }

  /** @param listener - invalidation callback. @returns subscription disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Re-inspect the credentials; cloud recognition has no resources to download. */
  prepare(): void { void this.refresh() }

  /** Nothing runs between inspections, so there is no preparation to cancel. */
  async cancel(): Promise<void> {}

  /**
   * Run the inspection; an older inspection that settles later is discarded, and a failure publishes `failed`.
   * @returns after this inspection settles.
   */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    let next: SpeechPreparationState
    try { next = await this.inspection() } catch (error) {
      next = { phase: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    if (generation !== this.generation || this.closed) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /** Stop publishing; later inspections settle without notifying. */
  dispose(): void {
    this.closed = true
    this.listeners.clear()
  }
}
