/** Cancellation and settlement of complete PTC calls, including nested tools. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

interface Call {
  mode: SandboxMode
  controller: AbortController
  done: Promise<void>
}

/** Keeps calls under a changed policy from overlapping their canceled predecessors. */
export class PtcCalls {
  private readonly calls = new Map<SessionId, Set<Call>>()
  private disposed = false

  /**
   * Observe policy changes for the owning tool registry.
   * @param ctx - Registry lifecycle and Session events.
   */
  constructor(ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      for (const call of this.calls.get(session.id) ?? []) {
        if (call.mode !== event.data.mode) call.controller.abort(new Error('sandbox mode changed'))
      }
    }, { global: true })
    ctx.effect(() => async () => {
      this.disposed = true
      const calls = [...this.calls.values()].flatMap(calls => [...calls])
      for (const call of calls) call.controller.abort(new Error('PTC tool registry disposed'))
      await Promise.all(calls.map(call => call.done))
    }, 'PTC calls')
  }

  /**
   * Await canceled predecessors before resolving authority and admitting a call.
   * @param sessionId - Calling Session.
   * @param signal - Caller cancellation.
   * @param mode - Current standing mode, read after preceding cleanup.
   * @param run - Complete call, including nested-tool cleanup.
   * @returns The call result.
   */
  async run<T>(sessionId: SessionId, signal: AbortSignal, mode: () => SandboxMode, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (;;) {
      const pending = [...this.calls.get(sessionId) ?? []].filter(call => call.controller.signal.aborted)
      if (pending.length === 0) break
      await Promise.all(pending.map(call => call.done))
    }
    signal.throwIfAborted()
    if (this.disposed) throw new Error('PTC tool registry disposed')
    const controller = new AbortController()
    const done = Promise.withResolvers<undefined>()
    const call = { mode: mode(), controller, done: done.promise }
    let calls = this.calls.get(sessionId)
    if (calls === undefined) this.calls.set(sessionId, calls = new Set())
    calls.add(call)
    try { return await run(AbortSignal.any([signal, controller.signal])) } finally {
      calls.delete(call)
      if (calls.size === 0) this.calls.delete(sessionId)
      done.resolve(undefined)
    }
  }
}
