/**
 * The Remote slice, scripted: stats answered by the spec, one push source per
 * opened `changes` generation, and a supervisor that runs one generation and
 * classifies its end the way the real one does.
 */
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { streamHandle } from '@deepseek-ai/dsh-remote-mock'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileWatchFrame, WorkspaceFileStat } from '../src/types.ts'
import type { SupervisedStream, SupervisedStreamOptions, WorkspaceFilesRemote } from '../src/client/remote.ts'

/** One scripted Host `changes` generation: frames pushed by the spec, ended by abort. */
export class Source<T> implements AsyncIterable<T> {
  private readonly queue: Array<
    { kind: 'value'; value: T; delivered?: () => void } | { kind: 'end' } | { kind: 'fail'; error: unknown }
  > = []
  private wake: (() => void) | undefined

  get aborted(): boolean {
    return this.signal.aborted
  }

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.abort, { once: true })
  }

  private readonly abort = (): void => {
    this.wake?.()
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
    try {
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
    } finally {
      this.signal.removeEventListener('abort', this.abort)
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
  readonly path: string
  readonly source: Source<WorkspaceFileWatchFrame>
}

/** Scripted stats and target-scoped Host streams, with explicit delivery and disposal barriers. */
export class FakeRemote implements WorkspaceFilesRemote {
  readonly calls: Array<'changes' | 'accept' | 'stat'> = []
  readonly opened: OpenedWatch[] = []
  readonly disposed: string[] = []
  readonly stats: PendingStat[] = []
  private readonly statWaiters = new Map<number, Array<(stat: PendingStat) => void>>()
  private readonly watchWaiters = new Map<number, Array<(watch: OpenedWatch) => void>>()
  private readonly disposeWaiters = new Map<number, Array<() => void>>()
  private readonly streams: Array<{ readonly done: Promise<void>; dispose(): Promise<void> }> = []
  private readonly disposeGates: Array<PromiseWithResolvers<undefined>> = []
  private closed = false
  /** False lets a spec keep the Host subscription unacknowledged. */
  autoReady = true
  /** When set, every stream dispose waits for it before settling. */
  disposeGate: Promise<void> | undefined

  /** Hold subsequent stream disposals until the spec releases or rejects this gate. */
  holdDisposal(): PromiseWithResolvers<undefined> {
    const gate = Promise.withResolvers<undefined>()
    this.disposeGates.push(gate)
    this.disposeGate = gate.promise
    return gate
  }

  /** Acknowledge one opened Host subscription and await the feed's acceptance. */
  async ready(index: number): Promise<OpenedWatch> {
    const watch = await this.waitForChanges(index)
    await watch.source.deliver({ kind: 'ready' })
    return watch
  }

  /** Wait until the feed requests an indexed stream disposal, before its gate settles. */
  waitForDispose(index: number): Promise<void> {
    if (this.disposed[index] !== undefined) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.disposeWaiters.get(index) ?? []
      waiters.push(resolve)
      this.disposeWaiters.set(index, waiters)
    })
  }

  /** Wait for one supervised iterator to finish independently of its disposal gate. */
  waitForStreamEnd(index: number): Promise<void> {
    const stream = this.streams[index]
    if (stream === undefined) throw new Error(`No supervised stream at index ${index}`)
    return stream.done
  }

  /** Release gates, settle pending stats, and await every fake stream, including rejected disposals. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const gate of this.disposeGates) gate.resolve(undefined)
    for (const request of this.stats) request.resolve(this.closedStat())
    await Promise.allSettled(this.streams.map(stream => stream.dispose()))
  }

  private closedStat(): RemoteResult<WorkspaceFileStat> {
    return { ok: false, error: new RemoteError('gateway/internal', 'test ended', {}) }
  }

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
    const calls = this.calls
    const done = Promise.withResolvers<undefined>()
    let closing: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      if (closing !== undefined) return closing
      const index = this.disposed.length
      this.disposed.push(options.name)
      controller.abort(new Error('disposed'))
      const gate = this.disposeGate
      closing = (async () => {
        try {
          await gate
        } finally {
          await done.promise
        }
      })()
      for (const waiter of this.disposeWaiters.get(index) ?? []) waiter()
      this.disposeWaiters.delete(index)
      return closing
    }
    this.streams.push({ done: done.promise, dispose })
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
      dispose,
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
        if (this.closed) resolve(this.closedStat())
      }),
    changes: (sessionId: SessionId, path: string, signal?: AbortSignal): RemoteStreamHandle<WorkspaceFileWatchFrame, never> => {
      this.calls.push('changes')
      if (signal === undefined) throw new Error('the feed must hand its signal to the Host stream')
      const source = new Source<WorkspaceFileWatchFrame>(signal)
      const watch = { sessionId, path, source }
      const index = this.opened.length
      this.opened.push(watch)
      for (const waiter of this.watchWaiters.get(index) ?? []) waiter(watch)
      this.watchWaiters.delete(index)
      if (this.autoReady) source.push({ kind: 'ready' })
      return streamHandle(source)
    },
  }
}

/** Let queued microtasks and background pumps settle. */
export const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })
