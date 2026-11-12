/** Ordered live-event batching shared by the persistence backends. @module */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Backend-owned serialization and commit operations for a live batch. */
interface LiveWriteOptions {
  delayMs: number
  maxEvents: number
  enqueue(operation: () => Promise<void>): Promise<unknown>
  persist(batch: readonly SessionEvent[]): Promise<void>
  retry(error: unknown): boolean
  canSchedule(): boolean
}

/** Retains admitted copies until commit, pausing automatic retries after failure. */
export class LiveWriteBuffer {
  private events: SessionEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private draining: Promise<void> | undefined
  private paused = false
  private report: ((error: unknown) => void) | undefined

  constructor(private readonly options: LiveWriteOptions) {}

  /** Number of admitted events awaiting commit. */
  get length(): number { return this.events.length }

  /** Whether a durability drain is in progress. */
  get active(): boolean { return this.draining !== undefined }

  /**
   * Admit exclusively owned event copies and schedule their durability deadline.
   * @param events - backend-validated or snapshotted live events.
   * @param report - observes automatic write failures.
   */
  append(events: readonly SessionEvent[], report: (error: unknown) => void): void {
    this.events.push(...events)
    this.report = report
    if (this.paused || !this.options.canSchedule()) return
    if (this.events.length >= this.options.maxEvents) {
      void this.drain().catch(report)
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.drain().catch(report)
      }, this.options.delayMs)
    }
  }

  /**
   * Commit all admitted events in order; concurrent callers join one drain.
   * @returns durability completion, rejecting with the backend's write failure.
   */
  drain(): Promise<void> {
    if (this.draining !== undefined) return this.draining
    this.cancelTimer()
    this.paused = false
    return this.draining = this.commit().finally(() => {
      this.draining = undefined
      if (this.events.length > 0 && !this.paused && this.options.canSchedule() && this.report !== undefined) {
        void this.drain().catch(this.report)
      }
    })
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
  }

  private async commit(): Promise<void> {
    while (this.events.length > 0) {
      try { await this.options.enqueue(async () => {
        this.cancelTimer()
        const batch = this.events.splice(0, this.options.maxEvents)
        try { await this.options.persist(batch) }
        catch (error: unknown) {
          if (this.options.retry(error)) this.events = batch.concat(this.events)
          this.paused = true
          throw error
        }
      }) } catch (error: unknown) {
        this.paused = true
        throw error
      }
    }
  }
}
