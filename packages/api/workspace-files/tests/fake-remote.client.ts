/**
 * The Remote slice, scripted: stats answered by the spec, one push source per
 * opened `changes` generation, and a supervisor that runs one generation and
 * classifies its end the way the real one does.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileWatchFrame, WorkspaceFileStat } from '../src/types.ts'
import type { SupervisedStream, SupervisedStreamOptions, WorkspaceFilesRemote } from '../src/client/remote.ts'

/** One scripted Host `changes` generation: frames pushed by the spec, ended by abort. */
export class Source<T> implements AsyncIterable<T> {
  private readonly queue: Array<
    { kind: 'value'; value: T; delivered?: () => void } | { kind: 'end' } | { kind: 'fail'; error: unknown }
  > = []
  private wake: (() => void) | undefined
  aborted = false

  constructor(signal: AbortSignal) {
    this.aborted = signal.aborted
    signal.addEventListener('abort', () => {
      this.aborted = true
      this.wake?.()
    }, { once: true })
  }

  push(value: T): void {
    this.queue.push({ kind: 'value', value })
    this.wake?.()
  }

  /** Resolve after the consumer processes this frame and asks for the next one. */
  deliver(value: T): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'value', value, delivered: resolve })
      this.wake?.()
    })
  }

  end(): void {
    this.queue.push({ kind: 'end' })
    this.wake?.()
  }

  fail(error: unknown): void {
    this.queue.push({ kind: 'fail', error })
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.aborted) return
      const next = this.queue.shift()
      if (next === undefined) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
        continue
      }
      if (next.kind === 'value') {
        yield next.value
        next.delivered?.()
        continue
      }
      if (next.kind === 'end') return
      throw next.error
    }
  }
}

/** One `stat` call awaiting the spec's answer. */
export interface PendingStat {
  readonly sessionId: SessionId
  readonly path: string
  readonly signal: AbortSignal | undefined
  resolve(result: RemoteResult<WorkspaceFileStat>): void
}

/** One opened Host watch whose acknowledgement and changes the spec controls. */
interface OpenedWatch {
  readonly sessionId: SessionId
  readonly source: Source<WorkspaceFileWatchFrame>
}

/** The scripted Remote: every stat waits for the spec, every session stream is a {@link Source}. */
export class FakeRemote implements WorkspaceFilesRemote {
  readonly calls: Array<'changes' | 'accept' | 'stat'> = []
  readonly opened: OpenedWatch[] = []
  readonly disposed: string[] = []
  readonly stats: PendingStat[] = []
  private readonly statWaiters = new Map<number, Array<(stat: PendingStat) => void>>()
  private readonly watchWaiters = new Map<number, Array<(watch: OpenedWatch) => void>>()
  /** False lets a spec keep the Host subscription unacknowledged. */
  autoReady = true
  /** When set, every stream dispose waits for it before settling. */
  disposeGate: Promise<void> | undefined

  /** Wait for an indexed stat request without advancing or assuming scheduler timing. */
  waitForStat(index: number): Promise<PendingStat> {
    const stat = this.stats[index]
    if (stat !== undefined) return Promise.resolve(stat)
    return new Promise((resolve) => {
      const waiters = this.statWaiters.get(index) ?? []
      waiters.push(resolve)
      this.statWaiters.set(index, waiters)
    })
  }

  /** Wait until the Client calls changes, independently of the Host acknowledgement. */
  waitForChanges(index: number): Promise<OpenedWatch> {
    const watch = this.opened[index]
    if (watch !== undefined) return Promise.resolve(watch)
    return new Promise((resolve) => {
      const waiters = this.watchWaiters.get(index) ?? []
      waiters.push(resolve)
      this.watchWaiters.set(index, waiters)
    })
  }

  $stream<Item>(options: SupervisedStreamOptions<Item>): SupervisedStream<Item> {
    const controller = new AbortController()
    const disposed = this.disposed
    const calls = this.calls
    const done = Promise.withResolvers<undefined>()
    return {
      async *[Symbol.asyncIterator]() {
        try {
          let accepted = false
          for await (const value of options.open(controller.signal)) {
            if (controller.signal.aborted) return
            yield { value, accept: () => { accepted = true; calls.push('accept') } }
          }
          if (controller.signal.aborted) return
          throw options.ended(accepted)
        } finally {
          done.resolve(undefined)
        }
      },
      dispose: async () => {
        disposed.push(options.name)
        controller.abort(new Error('disposed'))
        await this.disposeGate
        await done.promise
      },
    }
  }

  readonly workspaceFiles = {
    stat: (sessionId: SessionId, path: string, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileStat>> =>
      new Promise((resolve) => {
        this.calls.push('stat')
        const index = this.stats.length
        const stat = { sessionId, path, signal, resolve }
        this.stats.push(stat)
        for (const waiter of this.statWaiters.get(index) ?? []) waiter(stat)
        this.statWaiters.delete(index)
      }),
    changes: (sessionId: SessionId, signal?: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> => {
      this.calls.push('changes')
      if (signal === undefined) throw new Error('the feed must hand its signal to the Host stream')
      const source = new Source<WorkspaceFileWatchFrame>(signal)
      const watch = { sessionId, source }
      const index = this.opened.length
      this.opened.push(watch)
      for (const waiter of this.watchWaiters.get(index) ?? []) waiter(watch)
      this.watchWaiters.delete(index)
      if (this.autoReady) source.push({ kind: 'ready' })
      return source
    },
  }
}

/** Let queued microtasks and background pumps settle. */
export const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** The next item, or `'silent'` when none arrives within a tick. */
export async function peek<T>(it: AsyncIterator<T>): Promise<IteratorResult<T> | 'silent'> {
  return Promise.race([it.next(), settle().then(() => 'silent' as const)])
}
