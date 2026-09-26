/**
 * Node-shaped timer handles. The browser's `setTimeout`/`setInterval` return
 * numeric ids, while harness and vendored code calls `.unref()` on the handle
 * (`client-hmr`'s poll interval, cordis's timer plugin). The wrappers return a
 * handle object with Node's `ref`/`unref`/`hasRef`, and `clear*` accepts either
 * form — the object also converts to its numeric id, so any code that stores it
 * as a number keeps working.
 *
 * Handlers are also bound to the async context where the timer was registered
 * (`./async-context-hooks.ts`), so a callback scheduled inside an initiator
 * boundary is attributed to that boundary when it fires.
 */
import { bindAsyncContext } from '../builtin_modules/implemented/async_hooks.ts'

/** Node `Timeout`/`Immediate` face the harness relies on. */
export interface TimerHandle {
  ref(): TimerHandle
  unref(): TimerHandle
  hasRef(): boolean
  [Symbol.toPrimitive](): number
}

type Scheduler = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => number
type Clear = (id?: number) => void

const handleOf = (id: number): TimerHandle => {
  const handle: TimerHandle = {
    ref: () => handle,
    unref: () => handle,
    hasRef: () => true,
    [Symbol.toPrimitive]: () => id,
  }
  return handle
}

const idOf = (handle: unknown): number | undefined => {
  if (typeof handle === 'number') return handle
  if (typeof handle === 'object' && handle !== null && Symbol.toPrimitive in handle) {
    return Number(handle)
  }
  return undefined
}

const wrapScheduler = (schedule: Scheduler): ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => TimerHandle) =>
  (handler, timeout, ...args) => handleOf(schedule(bindHandler(handler), timeout, ...args))

/** Bind a timer handler to its registration context; string handlers have none to bind. */
const bindHandler = (handler: TimerHandler): TimerHandler =>
  typeof handler === 'function' ? bindAsyncContext(handler as (...args: never[]) => unknown) : handler

const wrapClear = (clear: Clear): ((handle?: unknown) => void) =>
  (handle) => { clear(idOf(handle)) }

/** Replace the worker's timer globals with the Node-shaped wrappers. */
export function installTimerGlobals(): void {
  const scope = globalThis as Record<string, unknown>
  const setTimeoutRaw = globalThis.setTimeout.bind(globalThis) as Scheduler
  const setIntervalRaw = globalThis.setInterval.bind(globalThis) as Scheduler
  const clearTimeoutRaw = globalThis.clearTimeout.bind(globalThis) as Clear
  const clearIntervalRaw = globalThis.clearInterval.bind(globalThis) as Clear
  scope.setTimeout = wrapScheduler(setTimeoutRaw)
  scope.setInterval = wrapScheduler(setIntervalRaw)
  scope.clearTimeout = wrapClear(clearTimeoutRaw)
  scope.clearInterval = wrapClear(clearIntervalRaw)
  scope.setImmediate = (handler: TimerHandler, ...args: unknown[]) =>
    handleOf(setTimeoutRaw(bindHandler(handler), 0, ...args))
  scope.clearImmediate = wrapClear(clearTimeoutRaw)
}
