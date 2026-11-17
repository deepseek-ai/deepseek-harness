/** Cancellation and settlement of complete PTC calls, including nested tools. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { CodeRunFailedError } from './errors.ts'

interface Call {
  mode: SandboxMode | undefined
  controller: AbortController
  signal: AbortSignal
  done: Promise<void>
}

interface Reset {
  done: Promise<void>
  settled: boolean
}

/** Serializes recovery with complete calls, including their nested-tool cleanup. */
export class PtcCalls {
  private readonly calls = new Map<SessionId, Set<Call>>()
  private readonly resets = new Map<SessionId, Reset>()
  private disposed = false

  /**
   * Observe policy changes for the owning executor.
   * @param ctx - Executor lifecycle and Session events.
   */
  constructor(ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      for (const call of this.calls.get(session.id) ?? []) {
        if (call.mode !== undefined && call.mode !== event.data.mode) call.controller.abort(new Error('sandbox mode changed'))
      }
    }, { global: true })
    ctx.effect(() => async () => {
      this.disposed = true
      const calls = [...this.calls.values()].flatMap(calls => [...calls])
      for (const call of calls) call.controller.abort(new Error('PTC tool executor disposed'))
      // Reset callers report release failures; disposal still waits for every call.
      await Promise.allSettled([...calls.map(call => call.done), ...[...this.resets.values()].map(reset => reset.done)])
    }, 'PTC calls')
  }

  /**
   * Await canceled predecessors before resolving authority and admitting a call.
   * @param sessionId - Calling Session.
   * @param signal - Caller cancellation.
   * @param mode - Current standing mode, if supported, read after preceding cleanup.
   * @param run - Complete call, including nested-tool cleanup.
   * @returns The call result.
   */
  async run<T>(
    sessionId: SessionId, signal: AbortSignal, mode: () => SandboxMode | undefined, run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const reset = this.resets.get(sessionId)
      if (reset !== undefined) {
        try { await reset.done } catch (error) {
          throw new CodeRunFailedError(`Program environment unavailable: ${toolErrorMessage(error)}. Ask the host to reset it before running more code.`)
        }
        continue
      }
      const pending = [...this.calls.get(sessionId) ?? []].filter(call => call.signal.aborted)
      if (pending.length === 0) break
      await Promise.all(pending.map(call => call.done))
    }
    signal.throwIfAborted()
    if (this.disposed) throw new CodeRunFailedError('PTC tool executor disposed', 'CODE_RUN_UNAVAILABLE')
    const controller = new AbortController()
    const done = Promise.withResolvers<undefined>()
    const currentSignal = AbortSignal.any([signal, controller.signal])
    const call = { mode: mode(), controller, signal: currentSignal, done: done.promise }
    let calls = this.calls.get(sessionId)
    if (calls === undefined) this.calls.set(sessionId, calls = new Set())
    calls.add(call)
    try { return await run(currentSignal) } finally {
      calls.delete(call)
      if (calls.size === 0) this.calls.delete(sessionId)
      done.resolve(undefined)
    }
  }

  /**
   * Cancel calls and release their environment independently of program cooperation.
   * A failed release blocks new calls until a later reset succeeds.
   * @param sessionId - Calling Session.
   * @param release - Host operation that terminates and cleans the owned environment.
   * @param notify - Queue the state-loss notice after cleanup and before admitting new calls.
   * @returns Completion after release and all canceled calls settle; concurrent resets share it.
   */
  reset(sessionId: SessionId, release: () => Promise<void>, notify?: () => void): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('PTC tool executor disposed'))
    const previous = this.resets.get(sessionId)
    if (previous !== undefined && !previous.settled) return previous.done
    const done = Promise.withResolvers<undefined>()
    const reset = { done: done.promise, settled: false }
    this.resets.set(sessionId, reset)
    const calls = [...this.calls.get(sessionId) ?? []]
    for (const call of calls) call.controller.abort(new Error('PTC environment reset'))
    void Promise.allSettled([Promise.resolve().then(release), ...calls.map(call => call.done)]).then((results) => {
      const failure = results.find(result => result.status === 'rejected')
      if (failure !== undefined) throw failure.reason
      notify?.()
    }).then(() => {
      reset.settled = true
      this.resets.delete(sessionId)
      done.resolve(undefined)
    }, (error: unknown) => {
      reset.settled = true
      done.reject(error)
    })
    return reset.done
  }
}
