/**
 * Browser resource ownership for the experimental providers. Resources belong
 * to an exact live Agent activation and never transfer to a resumed Session.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One provider-owned browser or connection and its quiescent cleanup. */
export interface OwnedSessionResource<T> {
  /** Provider-private handle exposed to operations. */
  value: T
  /** Stop admission, interrupt pending operations, and await resource shutdown. */
  close: () => Promise<void>
}

/** Resource creation and attachment ownership selected by one provider. */
export interface SessionResourceOptions<T> {
  /** Provider name included in lifecycle diagnostics. */
  label: string
  /** Reserve one existing browser for at most one live Session. */
  exclusive: boolean
  /**
   * Acquire one resource; reject only after rolling back partial acquisition.
   * @param agent - exact live owner of this acquisition.
   * @param signal - aborts when that owner or the provider is disposed.
   * @returns the acquired resource and its cleanup.
   */
  open: (agent: Agent, signal: AbortSignal) => Promise<OwnedSessionResource<T>>
}

interface Entry<T> {
  controller: AbortController
  ready: Promise<OwnedSessionResource<T>>
  tail: Promise<void>
  closing?: Promise<void>
}

/** Stop a caller's wait while retaining handlers on the resource owner's work. */
function awaitOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('browser operation canceled', { cause: signal.reason })) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then((value) => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted)
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    })
  })
}

/**
 * Lazily acquires one resource per live Session and serializes its operations.
 * Provider disposal closes connections before awaiting operations, allowing
 * transport closure to interrupt work whose upstream API has no abort support.
 */
export class SessionResources<T> {
  private readonly entries = new Map<Agent, Entry<T>>()
  private readonly ownerCleanups = new Map<Agent, () => Promise<void>>()
  private readonly disposedOwners = new WeakSet<Agent>()
  private disposing: Promise<void> | undefined

  /**
   * @param ctx - provider context with the live Agent registry.
   * @param options - provider-owned acquisition and attachment policy.
   */
  constructor(private readonly ctx: Context, private readonly options: SessionResourceOptions<T>) {}

  /**
   * Check admission without reserving or acquiring a browser.
   * @param agent - exact live Agent that would own the resource.
   * @returns whether this owner can use or acquire the configured browser.
   */
  available(agent: Agent): boolean {
    return this.disposing === undefined && !this.disposedOwners.has(agent)
      && this.ctx.get('agents')?.get(agent.id) === agent
      && (this.entries.has(agent) || !this.options.exclusive || this.entries.size === 0)
  }

  /**
   * Obtain the current activation's resource, acquiring it once when absent.
   * @param agent - exact live owner, never merely a durable Session id.
   * @param signal - optional cancellation of this wait; acquisition remains Session-owned.
   * @returns the provider's resource after acquisition and ownership checks.
   */
  async get(agent: Agent, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const entry = this.entry(agent)
    const resource = await (signal === undefined ? entry.ready : awaitOperation(entry.ready, signal))
    signal?.throwIfAborted()
    entry.controller.signal.throwIfAborted()
    return resource.value
  }

  /**
   * Run after earlier operations on this Session settle; other Sessions proceed independently.
   * Cancellation stops this caller's acquisition wait without canceling Session-owned initialization.
   * It reaches an active provider operation and prevents queued work from starting.
   * @param agent - exact live resource owner.
   * @param signal - cancellation for this operation.
   * @param operation - provider call, which must retain ownership until its work settles.
   * @returns the operation result or its acquisition, cancellation, or execution failure.
   */
  run<R>(agent: Agent, signal: AbortSignal, operation: (resource: T, signal: AbortSignal) => Promise<R>): Promise<R> {
    signal.throwIfAborted()
    const entry = this.entry(agent)
    const combined = AbortSignal.any([signal, entry.controller.signal])
    const releaseDisposed = () => {
      const reason = signal.reason as { kind?: unknown } | undefined
      if (reason?.kind !== 'disposed') return
      this.disposedOwners.add(agent)
      // AgentHandle waits for idle before disposing its scope; close interrupts the owned operation first.
      void this.closeEntry(agent, entry).catch((error: unknown) => {
        this.ctx.logger.warn(`${this.options.label}: browser cleanup during Session cancellation failed: ${String(error)}`)
      })
    }
    signal.addEventListener('abort', releaseDisposed, { once: true })
    const task = entry.tail.then(async () => {
      combined.throwIfAborted()
      const resource = await awaitOperation(entry.ready, combined)
      combined.throwIfAborted()
      const result = await operation(resource.value, combined)
      combined.throwIfAborted()
      return result
    }).finally(() => { signal.removeEventListener('abort', releaseDisposed) })
    // The queue tracks settlement independently of a caller observing its error.
    entry.tail = task.then(() => {}, () => {})
    return task
  }

  /**
   * Stop new acquisitions and await every acquired resource and owned operation.
   * A failed close retains its entry and rejects disposal, preserving exclusive ownership.
   * @returns the shared quiescent disposal promise.
   */
  dispose(): Promise<void> {
    return this.disposing ??= Promise.resolve().then(async () => {
      const settled = await Promise.allSettled([...this.entries].map(([agent, entry]) => this.closeEntry(agent, entry)))
      const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (errors.length > 0) throw new AggregateError(errors, `${this.options.label}: browser cleanup failed`)
      await Promise.all([...this.ownerCleanups.values()].map(close => close()))
    })
  }

  private entry(agent: Agent): Entry<T> {
    if (this.disposing !== undefined || this.disposedOwners.has(agent) || this.ctx.get('agents')?.get(agent.id) !== agent) {
      throw new Error(`${this.options.label}: Session is not a live browser owner`)
    }
    const current = this.entries.get(agent)
    if (current !== undefined) return current
    if (this.options.exclusive && this.entries.size > 0) {
      throw new Error(`${this.options.label}: attached browser is already reserved by another Session`)
    }
    if (!this.ownerCleanups.has(agent)) {
      const cleanup = agent.ctx.effect(() => async () => {
        this.disposedOwners.add(agent)
        const owned = this.entries.get(agent)
        if (owned !== undefined) await this.closeEntry(agent, owned)
        this.ownerCleanups.delete(agent)
      }, `${this.options.label}.session`)
      this.ownerCleanups.set(agent, cleanup)
    }
    const controller = new AbortController()
    const entry: Entry<T> = {
      controller,
      ready: Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return this.options.open(agent, controller.signal)
      }).catch((error: unknown) => {
        // open() owns rollback; a failed acquisition has no remaining resource.
        this.entries.delete(agent)
        throw error
      }),
      tail: Promise.resolve(),
    }
    // Acquisition can outlive every canceled caller; later consumers still receive its failure.
    void entry.ready.catch(() => {})
    this.entries.set(agent, entry)
    return entry
  }

  private closeEntry(agent: Agent, entry: Entry<T>): Promise<void> {
    return entry.closing ??= Promise.resolve().then(async () => {
      entry.controller.abort(new Error(`${this.options.label}: Session browser is closing`))
      const resource = await entry.ready.catch(() => undefined)
      try {
        await resource?.close()
      } finally {
        await entry.tail
      }
      this.entries.delete(agent)
    })
  }
}
