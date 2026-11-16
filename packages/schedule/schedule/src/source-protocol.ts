/** Shared in-process inputs, outputs, and drainable directed connections. */
import { SourceError } from './source-error.ts'
import type { AutomationConnection, SourceReceiver } from './source-types.ts'

/** Connections and accepted calls owned by one input or output endpoint. */
class SourceEndpoint<T> {
  protected readonly connections = new Set<AutomationConnection<T>>()
  private readonly pending = new Set<Promise<void>>()
  private closing: Promise<void> | undefined

  /**
   * Close related connections immediately and drain accepted calls, including detached connections.
   * Repeated calls join the same cleanup. A receiver must not await disposal of either endpoint or its own
   * connection from inside an accepted call: cleanup waits for that call to return.
   */
  dispose(): Promise<void> {
    if (this.closing === undefined) {
      for (const connection of this.connections) void connection.dispose()
      this.closing = Promise.allSettled([...this.pending]).then(() => {})
    }
    return this.closing
  }

  protected assertOpen(): void {
    if (this.closing !== undefined) throw new SourceError('This source endpoint has been disposed.', 'SOURCE_CLOSED')
  }

  protected attach<Value>(
    this: SourceEndpoint<never>, output: SourceEndpoint<Value>, receive: SourceReceiver<Value>,
  ): AutomationConnection<Value> {
    this.assertOpen()
    output.assertOpen()
    const pending = new Set<Promise<void>>()
    let closing: Promise<void> | undefined
    const connection: AutomationConnection<Value> = {
      send: async (value) => {
        if (closing !== undefined) throw new SourceError('This source connection has been disposed.', 'SOURCE_CONNECTION_CLOSED')
        const work = Promise.resolve().then(() => receive(value))
        pending.add(work)
        this.pending.add(work)
        output.pending.add(work)
        const settled = (): void => {
          pending.delete(work)
          this.pending.delete(work)
          output.pending.delete(work)
        }
        void work.then(settled, settled)
        return work
      },
      dispose: () => {
        if (closing === undefined) {
          this.connections.delete(connection)
          output.connections.delete(connection)
          closing = Promise.allSettled([...pending]).then(() => {})
        }
        return closing
      },
    }
    this.connections.add(connection)
    output.connections.add(connection)
    return connection
  }
}

/** A typed output whose broadcasts share the same delivery operation as directed sends. */
export class SourceOutput<in out T> extends SourceEndpoint<T> {
  /**
   * Close outgoing connections immediately and drain accepted calls. Repeated calls join the same cleanup.
   * Never await this from an accepted receiver call.
   */
  override dispose(): Promise<void> { return super.dispose() }

  /**
   * Admit every connection in the current snapshot before receiver callbacks run, then await all results.
   * @param value - Shared typed value; receivers must not mutate it.
   * @returns Resolves after all receivers accept; no connections means no delivery or retained value.
   * @throws SourceError with SOURCE_CLOSED after disposal starts, or SOURCE_DELIVERY_FAILED after all calls
   * settle if any failed. Other receivers may have committed; there is no rollback or automatic retry.
   */
  async emit(value: T): Promise<void> {
    this.assertOpen()
    const results = await Promise.allSettled([...this.connections].map(connection => connection.send(value)))
    const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      throw new SourceError('Some source receivers failed; other receivers may already have committed. Do not retry the entire output.',
        'SOURCE_DELIVERY_FAILED', { cause: new AggregateError(failures) })
    }
  }
}

/** A receiving endpoint shared by Sources and task runtimes; it owns connections, not borrowed outputs. */
export class SourceInput<T> extends SourceEndpoint<never> {
  /** @param receive - Accepts an input; rejection preserves the receiver's error without implying rollback. */
  constructor(private readonly receive: SourceReceiver<T>) { super() }

  /**
   * Close incoming connections immediately and drain accepted calls; borrowed outputs remain usable.
   * Repeated calls join the same cleanup. Never await this from an accepted receiver call.
   */
  override dispose(): Promise<void> { return super.dispose() }

  /**
   * Connect this receiver to an upstream output. Duplicate connections are independent.
   * @param output - Borrowed upstream output, left usable when this input is disposed.
   * @returns A shareable directed connection; every holder sends to this receiver and observes the same closure.
   * @throws SourceError with SOURCE_CLOSED if either endpoint is closing.
   */
  readonly connect: <Value extends T>(output: SourceOutput<Value>) => AutomationConnection<Value>
    = output => this.attach(output, this.receive)
}
