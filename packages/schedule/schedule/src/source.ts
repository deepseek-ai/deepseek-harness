/** Typed output subscriptions shared by independently owned source instances. */
import { SourceError } from '@deepseek-ai/dsh-schedule'
import type { SourceConnection, SourceReceiver } from './source-types.ts'

interface Subscription<T> {
  readonly receive: SourceReceiver<T>
  readonly pending: Set<Promise<void>>
  readonly connection: SourceConnection
}

/**
 * One source instance. Subclasses own observation, timing, input methods, and output policy.
 * Upstream dependencies are typed object references, not source kinds or task bindings.
 */
export abstract class AutomationSource<T> {
  private readonly subscriptions = new Set<Subscription<T>>()
  private readonly pending = new Set<Promise<void>>()
  private closing: Promise<void> | undefined

  /**
   * Subscribe to future output from this instance. Each connection is independent, including duplicate receivers.
   * @param receive - Receiver awaited for each accepted output; concurrent outputs may overlap.
   * @returns A connection whose disposal prevents new calls and drains accepted calls without disposing this source.
   * @throws SourceError with SOURCE_CLOSED after disposal starts.
   */
  subscribe(receive: SourceReceiver<T>): SourceConnection {
    this.assertOpen()
    const pending = new Set<Promise<void>>()
    const subscription: Subscription<T> = {
      receive,
      pending,
      connection: {
        dispose: async () => {
          this.subscriptions.delete(subscription)
          await Promise.allSettled([...pending])
        },
      },
    }
    this.subscriptions.add(subscription)
    return subscription.connection
  }

  /**
   * Stop accepting subscriptions and output immediately, then drain all accepted receiver calls.
   * Subclasses stop their producers and drain accepted inputs before calling this method. Borrowed upstream
   * instances remain owned by their creator; a consumer disposes only its own subscriptions.
   */
  dispose(): Promise<void> {
    if (this.closing === undefined) {
      this.subscriptions.clear()
      this.closing = Promise.allSettled([...this.pending]).then(() => {})
    }
    return this.closing
  }

  /**
   * Deliver to a snapshot of the current subscriptions and await every receiver, including after another fails.
   * @param value - Typed output; receivers must not mutate shared values.
   * @returns Resolves when every receiver accepts the output; no subscribers means no delivery.
   * @throws SourceError with SOURCE_CLOSED after disposal starts, or SOURCE_DELIVERY_FAILED after all receivers
   * settle if any failed. Fan-out is not atomic: other receivers may have committed, so do not retry the fan-out.
   */
  protected async emit(value: T): Promise<void> {
    this.assertOpen()
    const results = await Promise.allSettled([...this.subscriptions].map((subscription) => {
      // Record accepted work before invoking user code, including synchronous callbacks that detach themselves.
      const work = Promise.resolve().then(() => subscription.receive(value))
      subscription.pending.add(work)
      this.pending.add(work)
      const settled = (): void => {
        subscription.pending.delete(work)
        this.pending.delete(work)
      }
      void work.then(settled, settled)
      return work
    }))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      throw new SourceError('Some source receivers failed; other receivers may already have committed. Do not retry the entire output.',
        'SOURCE_DELIVERY_FAILED', { cause: new AggregateError(failures) })
    }
  }

  private assertOpen(): void {
    if (this.closing !== undefined) throw new SourceError('This source has been disposed.', 'SOURCE_CLOSED')
  }
}
