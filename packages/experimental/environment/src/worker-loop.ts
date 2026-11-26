/**
 * Worker-thread half of daemon runs. The daemon ships as one file and starts every worker from the source text of
 * {@link runWorker}, so that function uses only its port, globals and `process.getBuiltinModule`.
 */

import type { Script } from 'node:vm'
import type { MessagePort } from 'node:worker_threads'
import type { ThrownFields } from './protocol.ts'
import type { EnvironmentContext, EnvironmentExecResult, EnvironmentHostHandler, EnvironmentLimits, EnvironmentValue } from './types.ts'

/** An error crossing the worker boundary; structured cloning alone drops custom names and `code`. */
export interface WorkerError {
  /** Error name, such as `TypeError`. */
  readonly name: string
  /** Error message. */
  readonly message: string
  /** The error's `code` property, when it is a string. */
  readonly code?: string
}

/** How a run, an `exec` or an origin call settled. */
export type WorkerOutcome = { readonly value: unknown } | { readonly error: WorkerError }

/**
 * A message from the daemon's main thread to a worker: start a run, abort the current run's `env.signal`, or settle
 * the worker's `exec` or origin request `id`.
 */
export type ToWorker =
  | {
    readonly type: 'run'
    readonly hash: string
    readonly source: string
    readonly args: unknown
    readonly methods: readonly string[]
    readonly limits: EnvironmentLimits
  }
  | { readonly type: 'cancel'; readonly reason: WorkerError }
  | { readonly type: 'settle'; readonly id: number; readonly outcome: WorkerOutcome }

/** A message from a worker to the daemon's main thread: an `exec` or origin request, or the outcome of its run. */
export type FromWorker =
  | {
    readonly type: 'exec'
    readonly id: number
    readonly argv: readonly string[]
    readonly options: { readonly cwd?: string | undefined; readonly input?: string | undefined }
  }
  | { readonly type: 'call'; readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly type: 'settle'; readonly outcome: WorkerOutcome }

/** Handlers for the errors that no code of a worker caught, which the worker's `process` events deliver. */
export interface WorkerErrorHandlers {
  /** Fails the run in progress with the exception; between runs, reports it on standard error and keeps serving. */
  readonly uncaughtException: (error: unknown) => void
  /** Reports the rejection on standard error without ending the run in progress. */
  readonly unhandledRejection: (reason: unknown) => void
}

type RunContext = EnvironmentContext<Record<string, EnvironmentHostHandler>>

/**
 * Serve the runs posted to `port`, one at a time. Each run evaluates its source in a fresh `node:vm` context; the
 * worker compiles the source of each definition hash once. `exec` and origin calls become requests to the main thread;
 * their ids grow across runs, so a reply arriving after its run finished settles only that run's request.
 * @param port - the channel to the daemon's main thread.
 * @returns the handlers the worker installs for errors that no code caught.
 */
export function runWorker(port: MessagePort): WorkerErrorHandlers {
  const vm = process.getBuiltinModule('node:vm')
  const fs = process.getBuiltinModule('node:fs/promises')
  const path = process.getBuiltinModule('node:path')
  const { types } = process.getBuiltinModule('node:util')
  const scripts = new Map<string, Script>()
  const requests = new Map<number, PromiseWithResolvers<unknown>>()
  let nextRequest = 1
  /** The run in progress: its signal's controller and the function that ends it. */
  let current: { readonly controller: AbortController; readonly finish: (outcome: WorkerOutcome) => void } | undefined

  // Errors thrown in a run's context belong to another realm, which `instanceof Error` does not recognize. Code can
  // throw any value, including one whose fields are not strings or cannot be read, so describing never fails.
  const describe = (error: unknown): WorkerError => {
    try {
      if (!types.isNativeError(error)) return { name: 'Error', message: String(error) }
      const { name, message, code }: ThrownFields = error
      const failure = { name: String(name), message: String(message) }
      return typeof code === 'string' ? { ...failure, code } : failure
    } catch {
      return { name: 'Error', message: 'Execution environment run threw a value that cannot be described' }
    }
  }
  const revive = ({ name, message, code }: WorkerError): Error =>
    Object.assign(new Error(message), code === undefined ? { name } : { name, code })
  // Values that structured clone cannot copy fail with the text the connection reports for them.
  const unsendable = (error: unknown): string =>
    `Execution environment cannot send a value that structured clone does not support: ${describe(error).message}`

  const request = async (message: (id: number) => FromWorker, signal: AbortSignal): Promise<unknown> => {
    // A cancelled or finished run starts no request; code that outlives its run cannot act for a later one.
    signal.throwIfAborted()
    const id = nextRequest++
    const reply = Promise.withResolvers<unknown>()
    requests.set(id, reply)
    try {
      port.postMessage(message(id))
    } catch (error) {
      // Parameters that cannot be cloned never reach the main thread.
      requests.delete(id)
      throw new Error(unsendable(error), { cause: error })
    }
    return await reply.promise
  }

  const run = async ({ hash, source, args, methods, limits }: Extract<ToWorker, { type: 'run' }>): Promise<void> => {
    const controller = new AbortController()
    const { signal } = controller
    const timers = new Set<NodeJS.Timeout>()
    let ended = false
    const track = (timer: NodeJS.Timeout): NodeJS.Timeout => {
      // A timer started by code that outlives its run never fires.
      if (ended) clearTimeout(timer)
      else timers.add(timer)
      return timer
    }
    const clear = (timer: NodeJS.Timeout): void => {
      timers.delete(timer)
      clearTimeout(timer)
    }
    /** `AbortSignal.timeout`, with a timer that ends with the run like the run's other timers. */
    const timeout = (delay: number): AbortSignal => {
      if (!Number.isInteger(delay) || delay < 0 || delay > 0xFFFF_FFFF) {
        throw new RangeError(`AbortSignal.timeout requires an integer delay from 0 to 4294967295; received ${String(delay)}`)
      }
      const timed = new AbortController()
      track(setTimeout(() => { timed.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) }, delay))
      return timed.signal
    }
    /** End the run once, whether its function settled or an uncaught exception failed it, and send its outcome. */
    const finish = (outcome: WorkerOutcome): void => {
      if (ended) return
      ended = true
      current = undefined
      controller.abort(new Error('Execution environment run finished'))
      for (const timer of timers) clearTimeout(timer)
      try {
        port.postMessage({ type: 'settle', outcome } satisfies FromWorker)
      } catch (error) {
        // A result that cannot be cloned fails its run instead.
        port.postMessage({ type: 'settle', outcome: { error: { name: 'Error', message: unsendable(error) } } } satisfies FromWorker)
      }
    }
    current = { controller, finish }
    try {
      let script = scripts.get(hash)
      if (script === undefined) {
        script = new vm.Script(`(${source})`, { filename: 'environment-run.js' })
        scripts.set(hash, script)
      }
      // A fresh context per run gives each run its own global object. The utilities it supplies are this worker's
      // objects, shared by every run the worker serves.
      const fn: unknown = script.runInContext(vm.createContext({
        // esbuild's keepNames output, which the tsx source launch emits, calls `__name` from nested named functions;
        // it only sets `.name`, so a no-op suffices.
        __name: (target: unknown) => target,
        setTimeout: (callback: unknown, delay?: number, ...values: unknown[]): NodeJS.Timeout => {
          if (typeof callback !== 'function') throw new TypeError('setTimeout requires a callback function')
          const fire = callback as (...values: unknown[]) => unknown
          const timer = track(setTimeout(() => {
            timers.delete(timer)
            fire(...values)
          }, delay))
          // Refreshing a timeout that already fired schedules it again, so it is tracked again.
          const refresh = timer.refresh.bind(timer)
          timer.refresh = () => track(refresh())
          return timer
        },
        setInterval: (callback: (...values: unknown[]) => void, delay?: number, ...values: unknown[]) =>
          track(setInterval(callback, delay, ...values)),
        clearTimeout: clear,
        clearInterval: clear,
        queueMicrotask, Buffer, TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone, AbortController,
        AbortSignal: new Proxy(AbortSignal, {
          get: (target, key, receiver): unknown => key === 'timeout' ? timeout : Reflect.get(target, key, receiver),
        }),
        atob, btoa, performance,
      }))
      if (typeof fn !== 'function') throw new TypeError('Execution environment source must evaluate to a function')
      const env: RunContext = {
        fs, path, cwd: process.cwd(), platform: process.platform, signal, limits,
        exec: (argv, options) => request(id => ({
          type: 'exec', id, argv, options: { cwd: options?.cwd, input: options?.input },
        }), signal) as Promise<EnvironmentExecResult>,
        origin: Object.fromEntries(methods.map(method => [
          method, (params?: EnvironmentValue) => request(id => ({ type: 'call', id, method, params }), signal),
        ] as const)),
      }
      finish({ value: await (fn as (args: unknown, env: RunContext) => unknown)(args, env) })
    } catch (error) {
      finish({ error: describe(error) })
    }
  }

  /** Write one line about an error that no code caught to standard error. */
  const report = (kind: string, error: unknown): void => {
    process.stderr.write(`execution environment worker: ${kind}: ${describe(error).message}\n`)
  }

  port.on('message', (message: ToWorker) => {
    switch (message.type) {
      case 'run':
        void run(message)
        return
      case 'cancel':
        current?.controller.abort(revive(message.reason))
        return
      case 'settle': {
        const reply = requests.get(message.id)
        if (reply === undefined) return
        requests.delete(message.id)
        if ('error' in message.outcome) reply.reject(revive(message.outcome.error))
        else reply.resolve(message.outcome.value)
      }
    }
  })

  return {
    // Code left over from a finished run, such as an abort listener, can throw between runs.
    uncaughtException: (error) => {
      if (current === undefined) report('uncaught exception outside a run', error)
      else current.finish({ error: describe(error) })
    },
    unhandledRejection: (reason) => { report('unhandled rejection', reason) },
  }
}
