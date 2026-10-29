/** Coalesced Session state observations with Host-local revisions. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionState } from '../types.ts'

/** One complete state with its listener-local revision. */
export interface VersionedSessionState { state: SessionState; revision: number }

/** Coalesces Session/Agent invalidations with local revisions; pending events are sampled on reads. */
export class StateListener implements Disposable {
  private readonly disposes: (() => void)[] = []
  private readonly cancellation = new AbortController()
  private readonly signal: AbortSignal
  private revision = 0
  private resolver = createDeferredSignal()
  private closed = false

  /**
   * @param ctx - lifecycle notification owner.
   * @param target - Session to observe.
   * @param signal - caller cancellation.
   * @param readState - passive complete-state reader.
   */
  constructor(
    ctx: Context, target: SessionId, signal: AbortSignal,
    private readonly readState: (signal: AbortSignal) => Promise<SessionState>,
  ) {
    signal.throwIfAborted()
    this.signal = AbortSignal.any([signal, this.cancellation.signal])
    const notify = (id: string | undefined): void => {
      if (id !== target || this.closed) return
      this.revision++
      const resolver = this.resolver
      this.resolver = createDeferredSignal()
      resolver.resolve()
    }
    const close = (): void => { this[Symbol.dispose]() }
    signal.addEventListener('abort', close, { once: true })
    this.disposes.push(() => { signal.removeEventListener('abort', close) })
    try {
      this.disposes.push(ctx.on('session/event', (session) => { notify(session.id) }, { global: true }))
      this.disposes.push(ctx.on('session/created', (session) => { notify(session.id) }, { global: true }))
      this.disposes.push(ctx.on('session/disposed', (session) => { notify(session.id) }, { global: true }))
      this.disposes.push(ctx.on('agent/status', ({ agent }) => { notify(agent.id) }, { global: true }))
      this.disposes.push(ctx.on('agent/created', ({ agent }) => { notify(agent.id) }, { global: true }))
      this.disposes.push(ctx.on('agent/disposed', ({ agent }) => { notify(agent.id) }, { global: true }))
      const dispose = ctx.effect(() => close, 'session-controller.state-listener')
      this.disposes.push(() => { void dispose() })
    } catch (error: unknown) {
      this[Symbol.dispose]()
      throw error
    }
  }

  /**
   * Check whether a completed read still represents the latest invalidation.
   * @param revision - revision captured with a completed read.
   * @returns whether no intervening invalidation occurred.
   */
  isCurrent(revision: number): boolean { return !this.closed && revision === this.revision }

  /**
   * Read coalesced state replacements with optional periodic refresh.
   * @param refreshMs - optional idle recheck interval; omitted for event-only observation.
   * @returns complete state replacements with internal consistency revisions.
   */
  async *observeStates(refreshMs?: number): AsyncGenerator<VersionedSessionState> {
    let lastRevision = -1
    try {
      while (!this.closed) {
        if (lastRevision === this.revision) {
          if (refreshMs === undefined) {
            await this.resolver.promise
          } else {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                this.resolver.promise,
                new Promise<void>((resolve) => { timer = setTimeout(resolve, refreshMs) }),
              ])
            } finally {
              clearTimeout(timer)
            }
            if (this.isCurrent(lastRevision)) {
              this.revision++
              const resolver = this.resolver
              this.resolver = createDeferredSignal()
              resolver.resolve()
            }
          }
        }
        if (!this.isCurrent(this.revision)) return
        lastRevision = this.revision
        const state = await this.readState(this.signal)
        if (this.isCurrent(lastRevision)) yield { state, revision: lastRevision }
      }
    } finally {
      this[Symbol.dispose]()
    }
  }

  [Symbol.dispose](): void {
    if (this.closed) return
    this.closed = true
    this.cancellation.abort()
    this.resolver.resolve()
    for (const dispose of this.disposes.splice(0).reverse()) dispose()
  }
}

function createDeferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}
