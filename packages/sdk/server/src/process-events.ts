/**
 * Records the last process event seen before runtime teardown, for the SDK
 * server's liveness failures. The launcher owns signal and failure handling;
 * this module only observes.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/process-events
 */

import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { Readable } from 'node:stream'
import type { RuntimeObservation, RuntimeProcessEvent } from './server.ts'

/** The slice of `process` this module observes; `node:events` emitters satisfy it. */
export interface RuntimeProcessEvents {
  listenerCount(event: string): number
  prependListener(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Events whose first listener replaces a Node default, so observation joins only an existing owner. */
const OWNED_PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'unhandledRejection'] as const

/** Longest failure text copied into an SDK error message. */
const FAILURE_TEXT_LIMIT = 200

/** Never throws: a listener that threw here would end the dispatch before the listener that owns the event runs. */
function failureText(reason: unknown): string {
  try {
    const text = reason instanceof Error ? reason.message : String(reason)
    return text.replace(/\n[\s\S]*$/, '').slice(0, FAILURE_TEXT_LIMIT)
  } catch (_unprintable: unknown) {
    // The value has no string form, such as an object without a prototype or an Error whose message is not a string.
    return '<unprintable>'
  }
}

/**
 * Observe runtime disposal, termination signals, fatal failures, and input end until `ctx` is disposed.
 * A signal or unhandled rejection is observed only when another listener already
 * handles it, because the first listener for those events disables Node's default
 * termination. Recording stops once runtime disposal begins, so an event caused by
 * the teardown does not replace the one before it.
 * @param ctx - context that owns the listeners.
 * @param runtimeFiber - fiber whose disposal ends the whole runtime.
 * @param processEvents - process event source.
 * @param input - protocol input whose end is recorded as `stdin closed`.
 * @returns whether runtime disposal is in progress, and the last event recorded before it began.
 */
export function observeRuntime(
  ctx: Context,
  runtimeFiber: Fiber,
  processEvents: RuntimeProcessEvents,
  input: Readable,
): RuntimeObservation {
  let last: RuntimeProcessEvent | undefined
  const unloading = (): boolean =>
    runtimeFiber.state === FiberState.UNLOADING || runtimeFiber.state === FiberState.DISPOSED
  const observe = (description: string): void => {
    if (!unloading()) last = { description, at: new Date() }
  }
  ctx.effect(() => {
    const listeners: [event: string, listener: (...args: unknown[]) => void][] = [
      // The monitor event never replaces Node's default handling of an uncaught exception.
      ['uncaughtExceptionMonitor', (error) => { observe(`uncaught exception: ${failureText(error)}`) }],
    ]
    for (const event of OWNED_PROCESS_EVENTS) {
      if (processEvents.listenerCount(event) === 0) continue
      listeners.push([event, event === 'unhandledRejection'
        ? (reason) => { observe(`unhandled rejection: ${failureText(reason)}`) }
        : () => { observe(event) }])
    }
    // Prepended so the record exists before the owner's listener starts teardown.
    for (const [event, listener] of listeners) processEvents.prependListener(event, listener)
    const onInputEnd = (): void => { observe('stdin closed') }
    input.once('end', onInputEnd)
    return () => {
      for (const [event, listener] of listeners) processEvents.off(event, listener)
      input.off('end', onInputEnd)
    }
  }, 'jsonrpc.processEvents')
  return { unloading, lastProcessEvent: () => last }
}
