/** Recording readiness derived from the DeepSeek account and configured credentials; nothing is downloaded. */
import type { SpeechPreparation, SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/**
 * Inspect whether recordings can be sent now.
 * @param signedIn - whether the account service reports a stored account.
 * @returns the complete state to publish.
 */
export type ReadinessInspection = (signedIn: boolean) => Promise<SpeechPreparationState>

/** Host-owned cloud readiness; the latest inspection wins and disposal stops publication. */
export class CloudReadiness implements SpeechPreparation {
  private state: SpeechPreparationState = { phase: 'unavailable', reason: 'sign-in-required' }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private closed = false
  private present = false

  /** @param inspection - availability check, rerun whenever its inputs change. */
  constructor(private readonly inspection: ReadinessInspection) {}

  /** @returns the latest published state. */
  snapshot(): SpeechPreparationState { return this.state }

  /** @param listener - invalidation callback. @returns subscription disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Re-inspect account and credentials; cloud recognition has no resources to download. */
  prepare(): void { void this.refresh() }

  /** Nothing runs between inspections, so there is no preparation to cancel. */
  async cancel(): Promise<void> {}

  /**
   * Record account presence and re-inspect.
   * @param signedIn - whether an account is stored.
   * @returns after the resulting inspection settles.
   */
  async account(signedIn: boolean): Promise<void> {
    this.present = signedIn
    await this.refresh()
  }

  /**
   * Run the inspection; an older inspection that settles later is discarded, and a failure publishes `failed`.
   * @returns after this inspection settles.
   */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    let next: SpeechPreparationState
    try { next = await this.inspection(this.present) } catch (error) {
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
