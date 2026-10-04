/**
 * The middleware chain: runs the hooks selected for one event in order, each
 * hook's `next` reaching the hooks beneath and then the engine behavior, under
 * Claude Code's failure rules (skip a hook that throws, times out, or returns
 * no result; keep the result from beneath when it had already called `next`;
 * give a `.catch` handler the chance to answer in its place).
 * @module
 */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { messageOf } from './values.ts'
import type { AnyHook, HookFailure, HookOrigin, HookMatcher, ModsApi, HookNext, PluginOptions } from './types.ts'
import { matcherMatches } from './matcher.ts'

/** One loaded mod: its plugin identity and the `register` options it received. */
export interface LoadedMod {
  readonly name: string
  readonly version: string | undefined
  /** Absolute directory the mod ships in, as `$.plugin.root` reports it. */
  readonly root: string
  readonly options: PluginOptions
  /** Load order; hooks of an earlier mod run outside those of a later one. */
  readonly order: number
}

/** One `on(...)` registration. */
export interface RegisteredHook {
  readonly mod: LoadedMod
  readonly event: string
  readonly matcher: HookMatcher | undefined
  readonly hook: AnyHook
  catchHandler: AnyHook | undefined
  /** Failure kinds already reported for this hook; one line per kind until the mod reloads. */
  readonly reported: Set<string>
}

/** The `next.error.kind === 'timeout'` failure. */
export class HookTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`ran past its ${budgetMs} ms limit`)
    this.name = 'HookTimeoutError'
  }
}

/**
 * Accounts a hook's own running time: the clock runs while the hook is busy
 * and pauses while it awaits `next` or a mods API call. The deadline promise
 * rejects once the busy time reaches the limit.
 */
export class BudgetClock {
  private spent = 0
  private busySince: number | undefined
  private pauses = 0
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly deadline = Promise.withResolvers<never>()

  /**
   * @param ms - the running-time limit in milliseconds.
   * @param now - monotonic clock in milliseconds.
   */
  constructor(readonly ms: number, private readonly now: () => number = () => performance.now()) {
    // The deadline only matters while a race awaits it; an unobserved
    // rejection after the hook settled must not surface.
    this.deadline.promise.catch(() => {})
  }

  /** Rejects with {@link HookTimeoutError} when the busy time reaches the limit. */
  get expired(): Promise<never> {
    return this.deadline.promise
  }

  /** Milliseconds left before the deadline fires. */
  get remainingMs(): number {
    const busy = this.busySince === undefined ? 0 : this.now() - this.busySince
    return Math.max(0, this.ms - this.spent - busy)
  }

  /** Start counting; the hook is busy from now on. */
  start(): void {
    if (this.stopped) return
    this.busySince = this.now()
    this.arm()
  }

  /** Stop counting while the hook awaits `next` or a mods API call. Nested pauses are counted. */
  pause(): void {
    if (this.stopped) return
    this.pauses += 1
    if (this.busySince !== undefined) {
      this.spent += this.now() - this.busySince
      this.busySince = undefined
    }
    this.disarm()
  }

  /** Resume counting after the awaited call settled. */
  resume(): void {
    if (this.stopped || this.pauses === 0) return
    this.pauses -= 1
    if (this.pauses === 0) {
      this.busySince = this.now()
      this.arm()
    }
  }

  /** The hook settled: no deadline can fire from now on. */
  stop(): void {
    if (this.busySince !== undefined) this.spent += this.now() - this.busySince
    this.stopped = true
    this.busySince = undefined
    this.disarm()
  }

  private arm(): void {
    this.disarm()
    const remaining = this.remainingMs
    this.timer = setTimeout(() => {
      this.stopped = true
      this.busySince = undefined
      this.spent = this.ms
      this.deadline.reject(new HookTimeoutError(this.ms))
    }, remaining)
    this.timer.unref()
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** Everything one dispatch needs besides the hooks themselves. */
export interface DispatchRequest<E, R> {
  readonly event: string
  readonly input: E
  /** The engine behavior at the bottom of the chain; receives the input as the chain left it. */
  readonly core: (e: E) => Promise<R> | R
  readonly origin: HookOrigin
  /** Hooks whose event pattern selects this event, outermost first; matchers are evaluated per hook. */
  readonly hooks: readonly RegisteredHook[]
  /** Builds the `$` a hook receives; the clock pauses while its calls are awaited. */
  readonly api: (hook: RegisteredHook, clock: BudgetClock) => ModsApi
  /** A hook's own running-time limit. */
  readonly budgetMs: number
  /** A `.catch` handler's running-time limit. */
  readonly catchBudgetMs: number
  readonly signal: AbortSignal
  /** Receives one diagnostic line per skipped hook and failure kind. */
  readonly report: (line: string) => void
  /**
   * Checks the input a hook passes to `next` before anything beneath runs; a
   * throw skips that hook as a failure of its own and the chain continues with
   * the input the hook received.
   */
  readonly validateNext?: (e: E, hook: RegisteredHook) => void
}

/** Thrown by {@link DispatchRequest.validateNext}: the hook asked for a rewrite this host does not serve. */
export class RewriteRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RewriteRefusedError'
  }
}

/** The engine's own origin. */
export const ENGINE_ORIGIN: HookOrigin = Object.freeze({ plugin: 'engine', tier: 'core' })

/** A hook settled with something other than a result object. */
class NoResultError extends Error {
  constructor() {
    super('returned no result')
    this.name = 'NoResultError'
  }
}

/** Classify a failed hook and word the diagnostic line's tail. */
function failureOf(error: unknown): HookFailure & { readonly line: string } {
  if (error instanceof HookTimeoutError) return { kind: 'timeout', message: error.message, line: `timeout, ${error.message}` }
  if (error instanceof NoResultError || error instanceof RewriteRefusedError) return { kind: 'throw', message: error.message, line: error.message }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : messageOf(error)
  return { kind: 'throw', message, line: `threw ${message}` }
}

/** Freeze the event input in place at every depth, as the mods API promises. */
function freezeInput<E>(input: E): E {
  return typeof input === 'object' && input !== null ? deepFreeze(input) : input
}

/**
 * Run one event through its hooks and the engine behavior.
 * @param request - the event, its hooks, and the engine behavior beneath them.
 * @returns the event's result as the outermost hook returned it.
 */
export async function dispatch<E, R>(request: DispatchRequest<E, R>): Promise<R> {
  const { hooks } = request

  async function runFrom(index: number, input: E): Promise<R> {
    for (let i = index; i < hooks.length; i += 1) {
      const hook = hooks[i] as RegisteredHook
      if (hook.matcher !== undefined && !matcherMatches(hook.matcher, input)) continue
      return runHook(hook, i, input)
    }
    return request.core(input)
  }

  async function runHook(hook: RegisteredHook, index: number, input: E): Promise<R> {
    const frozen = freezeInput(input)
    const clock = new BudgetClock(request.budgetMs)
    // Closure-written flags live on one object so the catch path reads their current values.
    const state: {
      abandoned: boolean
      called: boolean
      beneath: Promise<R> | undefined
      beneathError: { readonly error: unknown } | undefined
      refused: { readonly error: unknown } | undefined
    } = { abandoned: false, called: false, beneath: undefined, beneathError: undefined, refused: undefined }
    const next = Object.assign(
      (e: E): Promise<R> => {
        state.called = true
        // One run beneath per hook: a second call hands back the first run.
        if (state.beneath !== undefined) return state.beneath
        if (state.abandoned) return Promise.resolve(undefined as R)
        if (request.validateNext !== undefined) {
          try {
            request.validateNext(e, hook)
          } catch (error: unknown) {
            const refused = error instanceof Error ? error : new Error(messageOf(error))
            state.refused = { error: refused }
            return Promise.reject(refused)
          }
        }
        clock.pause()
        state.beneath = runFrom(index + 1, e)
          .catch((error: unknown) => {
            state.beneathError = { error }
            throw error
          })
          .finally(() => { clock.resume() })
        return state.beneath
      },
      {
        signal: request.signal,
        origin: request.origin,
        budget: { ms: request.budgetMs, get remainingMs(): number { return clock.remainingMs } },
        to(): Promise<R> {
          return Promise.reject(new Error('next.to is only available to mods in managed prependPlugins or appendPlugins'))
        },
      },
    ) as HookNext<E, R>
    const api = request.api(hook, clock)
    clock.start()
    try {
      const running = Promise.resolve().then(() => hook.hook(api, frozen, next as HookNext<unknown, unknown>) as R | Promise<R>)
      // An abandoned hook's later rejection is not an unhandled rejection.
      running.catch(() => {})
      const result = await Promise.race([running, clock.expired])
      // `null` is an answer (a surface drawn empty); only a hook that settles with no object at all is skipped.
      if (typeof result !== 'object') throw new NoResultError()
      // The hook answered; whatever it started beneath still runs to its end before the event settles.
      clock.stop()
      if (state.beneath !== undefined) {
        await state.beneath.catch((error: unknown) => {
          request.report(`${hook.mod.name}: ${request.event}: the chain beneath failed after the hook answered: ${messageOf(error)}`)
        })
      }
      return result
    } catch (error: unknown) {
      state.abandoned = true
      // The engine beneath failed, not the hook: the failure is the event's own.
      if (state.beneathError !== undefined && error === state.beneathError.error) throw error
      // A refused rewrite is the hook's failure even when the hook let the rejection through unchanged.
      const failure = failureOf(state.refused !== undefined && error === state.refused.error ? state.refused.error : error)
      if (!hook.reported.has(failure.kind)) {
        hook.reported.add(failure.kind)
        request.report(`${hook.mod.name}: ${request.event} hook skipped: ${failure.line}`)
      }
      if (hook.catchHandler !== undefined) {
        const answered = await runCatch(hook, index, frozen, { kind: failure.kind, message: failure.message }, state)
        if (answered !== undefined) return answered
      }
      // Whatever ran beneath, for the hook or its handler, ran once; its result stands.
      if (state.beneath !== undefined) return await state.beneath
      return await runFrom(index + 1, input)
    } finally {
      clock.stop()
    }
  }

  /**
   * Run the failed hook's `.catch` handler. It shares the hook's beneath state:
   * what the hook already ran is handed back, what the handler runs is recorded
   * for the skip path, so nothing beneath runs twice.
   */
  async function runCatch(
    hook: RegisteredHook,
    index: number,
    input: E,
    failure: HookFailure,
    state: { abandoned: boolean; called: boolean; beneath: Promise<R> | undefined },
  ): Promise<R | undefined> {
    const clock = new BudgetClock(request.catchBudgetMs)
    let handlerAbandoned = false
    const next = Object.assign(
      (e: E): Promise<R> => {
        if (state.beneath !== undefined) return state.beneath
        if (handlerAbandoned) return Promise.resolve(undefined as R)
        if (request.validateNext !== undefined) {
          // The same check the hook's own next makes: a handler cannot pass a rewrite beneath either.
          try {
            request.validateNext(e, hook)
          } catch (error: unknown) {
            return Promise.reject(error instanceof Error ? error : new Error(messageOf(error)))
          }
        }
        clock.pause()
        state.beneath = runFrom(index + 1, e).finally(() => { clock.resume() })
        return state.beneath
      },
      {
        signal: request.signal,
        origin: request.origin,
        budget: { ms: request.catchBudgetMs, get remainingMs(): number { return clock.remainingMs } },
        to(): Promise<R> { return Promise.reject(new Error('next.to is not available in a .catch handler')) },
        error: failure,
        called: state.called,
      },
    ) as HookNext<E, R>
    const api = request.api(hook, clock)
    clock.start()
    try {
      const handler = hook.catchHandler as AnyHook
      const running = Promise.resolve()
        .then(() => handler(api, input, next as HookNext<unknown, unknown>) as R | undefined | Promise<R | undefined>)
      running.catch(() => {})
      const result = await Promise.race([running, clock.expired])
      if (typeof result === 'object') return result
    } catch (error: unknown) {
      request.report(`${hook.mod.name}: ${request.event} .catch handler skipped: ${failureOf(error).line}`)
    } finally {
      handlerAbandoned = true
      clock.stop()
    }
    return undefined
  }

  return runFrom(0, request.input)
}
