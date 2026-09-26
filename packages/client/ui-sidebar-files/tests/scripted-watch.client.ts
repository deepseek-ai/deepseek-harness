/** Target-scoped watch streams with explicit delivery and asynchronous release barriers. */
import { vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WatchWorkspaceDirectory } from '../src/client/face.ts'

type Event = 'ready' | 'change'
type Frame = { kind: 'event'; value: Event; delivered: () => void } | { kind: 'error'; error: unknown }

/** One directory subscription; delivering an event waits for the consumer's next pull. */
export class DirectoryWatch implements AsyncIterable<Event> {
  readonly releasing = Promise.withResolvers<undefined>()
  readonly released = Promise.withResolvers<undefined>()
  private readonly controller = new AbortController()
  private readonly lifetime: AbortSignal
  private readonly queue: Frame[] = []
  private wake: (() => void) | undefined
  private releaseGate: PromiseWithResolvers<undefined> | undefined

  constructor(readonly sessionId: SessionId, readonly path: string, readonly signal: AbortSignal) {
    this.lifetime = AbortSignal.any([signal, this.controller.signal])
  }

  deliver(value: Event): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'event', value, delivered: resolve })
      this.wake?.()
    })
  }

  fail(error: unknown): void {
    this.queue.push({ kind: 'error', error })
    this.wake?.()
  }

  holdRelease(): PromiseWithResolvers<undefined> {
    return this.releaseGate ??= Promise.withResolvers<undefined>()
  }

  stop(): void {
    this.controller.abort()
    this.releaseGate?.resolve(undefined)
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Event> {
    const abort = (): void => { this.wake?.() }
    this.lifetime.addEventListener('abort', abort, { once: true })
    try {
      while (!this.lifetime.aborted) {
        const next = this.queue.shift()
        if (next === undefined) {
          await new Promise<void>((resolve) => { this.wake = resolve })
          this.wake = undefined
          continue
        }
        if (next.kind === 'error') throw next.error
        try {
          yield next.value
        } finally {
          next.delivered()
        }
      }
    } finally {
      this.lifetime.removeEventListener('abort', abort)
      this.releasing.resolve(undefined)
      await this.releaseGate?.promise
      this.released.resolve(undefined)
    }
  }
}

/** Records independent streams, including new subscriptions to a reopened directory. */
export class DirectoryWatches {
  readonly opened: DirectoryWatch[] = []
  private readonly waiters = new Set<() => void>()

  readonly watch = vi.fn<WatchWorkspaceDirectory>((sessionId, path, signal) => {
    const stream = new DirectoryWatch(sessionId, path, signal)
    this.opened.push(stream)
    for (const waiter of this.waiters) waiter()
    return stream
  })

  forPath(path: string, occurrence = 0): Promise<DirectoryWatch> {
    const current = (): DirectoryWatch | undefined => this.opened.filter(stream => stream.path === path)[occurrence]
    const stream = current()
    if (stream !== undefined) return Promise.resolve(stream)
    return new Promise((resolve) => {
      const wait = (): void => {
        const stream = current()
        if (stream === undefined) return
        this.waiters.delete(wait)
        resolve(stream)
      }
      this.waiters.add(wait)
    })
  }

  async ready(path: string, occurrence = 0): Promise<DirectoryWatch> {
    const stream = await this.forPath(path, occurrence)
    await stream.deliver('ready')
    return stream
  }

  async dispose(): Promise<void> {
    for (const stream of this.opened) stream.stop()
    await Promise.all(this.opened.map(stream => stream.released.promise))
    this.waiters.clear()
  }
}
