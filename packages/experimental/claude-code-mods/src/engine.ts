/**
 * The mods engine: loaded mods and their hooks, engine-raised events, mods
 * API calls raised as events, per-session `$.state`, and the timers mods
 * start. It knows nothing of Cordis; the plugin supplies the engine behavior
 * for each mods API call and the test kit supplies stubs.
 * @module
 */

import type { BudgetClock, LoadedMod, RegisteredHook } from './chain.ts'
import { dispatch, ENGINE_ORIGIN } from './chain.ts'
import { createModsApi } from './api.ts'
import type { TimerHost } from './api.ts'
import { messageOf, record } from './values.ts'
import { HookRegistry, registerMod } from './module.ts'
import type { ModDefinition, ModsApi, OpResult, ModTimer } from './types.ts'

/** The engine behavior for one mods API call. */
export type OpCore<B> = (input: unknown, context: OpContext<B>) => unknown

/** Engine behaviors by event name, `<namespace>.<method>`. */
export type OpTable<B> = Readonly<Record<string, OpCore<B>>>

/** Looks up the engine behavior for one mods API call; `undefined` means none is served. */
export type OpResolver<B> = (op: string) => OpCore<B> | undefined

/**
 * Thrown by an engine behavior to answer a mods API call with `{ deny }`, so
 * the calling mod's `$` call rejects with the reason.
 */
export class OpDenied extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'OpDenied'
  }
}

/** What an op core and a `$` instance know about the raising hook's surroundings. */
export interface OpContext<B> {
  readonly mod: LoadedMod
  /** The engine-specific binding of the event that is running: the plugin's agent, or the test kit's fixture. */
  readonly binding: B
  readonly signal: AbortSignal
  readonly engine: ModsEngine<B>
}

/** Engine construction options. */
export interface ModsEngineOptions<B> {
  /**
   * Engine behaviors for mods API calls. The engine answers `state.*`,
   * `clock.now`, and `clock.sleep` itself when the resolver serves none.
   */
  readonly ops: OpResolver<B>
  /**
   * The key `$.state` values and a mod's timers live under: Claude Code's "for
   * the whole session". The empty string is the sessionless scope.
   */
  readonly stateKey: (binding: B) => string
  /** A hook's own running-time limit in milliseconds. */
  readonly budgetMs: number
  /** A `.catch` handler's running-time limit in milliseconds. */
  readonly catchBudgetMs: number
  /** Receives diagnostics: skipped hooks, failed fire-and-forget calls, timer callback errors. */
  readonly report: (line: string) => void
  /** Observes `$.state` reads, by session key and `<plugin>\u0000<key>` slot, so a drawing can subscribe to what it read. */
  readonly onStateRead?: (key: string, slot: string) => void
  /** Observes `$.state` writes, by session key and slot. */
  readonly onStateWritten?: (key: string, slot: string) => void
}

/** Options for raising one engine event. */
export interface RaiseOptions<B, E = unknown> {
  readonly binding: B
  readonly signal?: AbortSignal
  /** Checks the input a hook passes to `next`; a throw skips that hook and continues with the input it received. */
  readonly validateNext?: (e: E, hook: RegisteredHook) => void
}

const NEVER_ABORTS = new AbortController().signal

/** Wait `ms`, or reject with the signal's reason when the event is cancelled before or while waiting. */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReasonOf(signal))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(abortReasonOf(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(`$.clock.sleep cancelled: ${messageOf(reason)}`)
}

/** One named `$.state` slot: `<plugin>\u0000<key>`. */
function stateSlot(plugin: unknown, key: unknown): string {
  if (typeof plugin !== 'string' || typeof key !== 'string') throw new TypeError('$.state needs { plugin, key } strings')
  return `${plugin}\u0000${key}`
}

/**
 * Timers owned by the engine on one mod's behalf. Closing cancels every
 * scheduled timer, refuses new ones, and waits for the callbacks already
 * running, so a mod cannot reschedule itself or touch the host after unload.
 */
class TimerSet implements TimerHost {
  private readonly active = new Set<ReturnType<typeof setTimeout>>()
  private readonly running = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly report: (line: string) => void, private readonly owner: string) {}

  after(ms: number, fn: () => unknown): ModTimer {
    if (this.closed) return { cancel() {} }
    const handle = setTimeout(() => {
      this.active.delete(handle)
      this.run(fn)
    }, ms)
    handle.unref()
    this.active.add(handle)
    return { cancel: () => { clearTimeout(handle); this.active.delete(handle) } }
  }

  every(ms: number, fn: () => unknown): ModTimer {
    if (this.closed) return { cancel() {} }
    const handle = setInterval(() => { this.run(fn) }, ms)
    handle.unref()
    this.active.add(handle)
    return { cancel: () => { clearInterval(handle); this.active.delete(handle) } }
  }

  /**
   * Cancel every scheduled timer, refuse new ones, and settle once the
   * callbacks already running have finished.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const handle of this.active) clearTimeout(handle)
    this.active.clear()
    await Promise.all(this.running)
  }

  private run(fn: () => unknown): void {
    const settled = Promise.resolve().then(fn).then(() => undefined, (error: unknown) => {
      this.report(`${this.owner}: timer callback failed: ${messageOf(error)}`)
    })
    this.running.add(settled)
    void settled.finally(() => { this.running.delete(settled) })
  }
}

/**
 * Loaded mods, their hooks, and the two ways events reach them: the engine
 * raises one through every selected hook, and a mod's `$` call raises one
 * through the mods loaded before it.
 */
export class ModsEngine<B> {
  /** The loaded mods and their registrations. */
  readonly registry = new HookRegistry()
  private readonly state = new Map<string, Map<string, unknown>>()
  /** Timer sets by `<session key>\u0000<plugin>`: a mod's timers belong to the session whose event started them. */
  private readonly timers = new Map<string, TimerSet>()
  private nextOrder = 0

  constructor(private readonly options: ModsEngineOptions<B>) {}

  /**
   * Run one mod's `register` and add its hooks beneath every mod added before it.
   * @param definition - the mod as its plugin defined it.
   * @returns the loaded mod.
   * @throws Error when the name is taken or invalid, or when `register` throws.
   */
  async add(definition: ModDefinition): Promise<LoadedMod> {
    if (this.registry.list().some(loaded => loaded.name === definition.name)) {
      throw new Error(`mod "${definition.name}" not loaded: another mod of that name is already loaded`)
    }
    const order = this.nextOrder
    this.nextOrder += 1
    const { mod, hooks } = await registerMod(definition, order)
    this.registry.add(mod, hooks)
    return mod
  }

  /**
   * Raise one engine event through its hooks, outermost first.
   * @param event - the event name.
   * @param input - the event input; frozen before a hook sees it.
   * @param core - the engine behavior beneath every hook.
   * @param options - the binding events of this agent share, and its cancellation.
   * @returns the result as the outermost hook returned it.
   */
  raise<E, R>(event: string, input: E, core: (e: E) => Promise<R> | R, options: RaiseOptions<B, E>): Promise<R> {
    return this.raiseWith(event, this.registry.select(event), undefined, input, core, options)
  }

  /**
   * Raise one event through hooks the caller already selected, attributed to
   * the mod that caused it: the engine, or a mod whose `$` call the host turned
   * back into this event.
   * @param event - the event name.
   * @param hooks - the selected hooks, outermost first.
   * @param raisedBy - the mod the event is attributed to, or undefined for the engine.
   * @param input - the event input; frozen before a hook sees it.
   * @param core - the engine behavior beneath every hook.
   * @param options - the binding events of this agent share, and its cancellation.
   * @returns the result as the outermost hook returned it.
   */
  raiseWith<E, R>(
    event: string,
    hooks: readonly RegisteredHook[],
    raisedBy: LoadedMod | undefined,
    input: E,
    core: (e: E) => Promise<R> | R,
    options: RaiseOptions<B, E>,
  ): Promise<R> {
    const signal = options.signal ?? NEVER_ABORTS
    return dispatch<E, R>({
      event,
      input,
      core,
      origin: raisedBy === undefined ? ENGINE_ORIGIN : { plugin: raisedBy.name, tier: 'user' },
      hooks,
      api: (hook, clock) => this.api(hook.mod, clock, options.binding, signal),
      budgetMs: this.options.budgetMs,
      catchBudgetMs: this.options.catchBudgetMs,
      signal,
      report: this.options.report,
      ...options.validateNext === undefined ? {} : { validateNext: options.validateNext },
    })
  }

  /**
   * Raise one mods API call as its event through the mods loaded before the
   * caller, then answer it with the engine behavior.
   * @param mod - the calling mod.
   * @param op - the event name, `<namespace>.<method>`.
   * @param input - the call's input.
   * @param binding - the binding of the event the caller is handling.
   * @param signal - cancellation of that event.
   * @returns the value the chain answered with.
   * @throws Error with the reason when a hook or the engine answered `{ deny }`.
   */
  async invoke(mod: LoadedMod, op: string, input: unknown, binding: B, signal: AbortSignal): Promise<unknown> {
    const result = await dispatch<unknown, unknown>({
      event: op,
      input,
      // `tool.call` reaches the earlier mods once the host raises it from the tool pipeline, not here as well.
      hooks: op === 'tool.call' ? [] : this.registry.select(op, mod),
      core: async (e): Promise<OpResult> => {
        try {
          return { value: await this.opCore(op, e, { mod, binding, signal, engine: this }) }
        } catch (error: unknown) {
          if (error instanceof OpDenied) return { deny: error.reason }
          throw error
        }
      },
      origin: { plugin: mod.name, tier: 'user' },
      api: (hook, clock) => this.api(hook.mod, clock, binding, signal),
      budgetMs: this.options.budgetMs,
      catchBudgetMs: this.options.catchBudgetMs,
      signal,
      report: this.options.report,
    })
    // Hooks that settle with anything but an object are skipped, so the result is the core's or a hook's object — or null.
    const answer = result as { value?: unknown; deny?: unknown } | null
    if (answer === null || (!('value' in answer) && !('deny' in answer))) {
      throw new Error(`${op}: a hook returned neither { value } nor { deny }`)
    }
    if (typeof answer.deny === 'string') throw new Error(`${op} refused: ${answer.deny}`)
    return answer.value
  }

  /**
   * Build the `$` for one mod inside one event.
   * @param mod - the mod the instance belongs to.
   * @param clock - the running hook's clock, or undefined outside a hook.
   * @param binding - the event's binding.
   * @param signal - the event's cancellation.
   * @returns the mods API.
   */
  api(mod: LoadedMod, clock: BudgetClock | undefined, binding: B, signal: AbortSignal): ModsApi {
    return createModsApi({
      mod,
      clock,
      invoke: (op, input) => this.invoke(mod, op, input, binding, signal),
      timers: this.timersOf(mod, this.options.stateKey(binding)),
      report: this.options.report,
    })
  }

  /**
   * Forget one session's `$.state` values and close the timers its events started.
   * @param key - the session key the values and timers were kept under.
   * @returns settles once the session's timer callbacks have finished.
   */
  async forgetSession(key: string): Promise<void> {
    this.state.delete(key)
    const closing: Promise<void>[] = []
    for (const [timerKey, timers] of this.timers) {
      if (timerKey.startsWith(`${key}\u0000`)) {
        this.timers.delete(timerKey)
        closing.push(timers.close())
      }
    }
    await Promise.all(closing)
  }

  /**
   * The `claude plugin validate` style `hooks:` line for one mod.
   * @param mod - the loaded mod.
   * @returns its events with matchers, comma-separated.
   */
  describe(mod: LoadedMod): string {
    return this.registry.describe(mod)
  }

  /**
   * Drop one mod: its hooks stop receiving events, its timers are cancelled,
   * and its running timer callbacks are awaited.
   * @param name - the plugin name.
   * @returns settles once the mod's timer callbacks have finished.
   */
  async unload(name: string): Promise<void> {
    this.registry.remove(name)
    const closing: Promise<void>[] = []
    for (const [timerKey, timers] of this.timers) {
      if (timerKey.endsWith(`\u0000${name}`)) {
        this.timers.delete(timerKey)
        closing.push(timers.close())
      }
    }
    await Promise.all(closing)
  }

  /**
   * Drop every registration and close every mod's timers.
   * @returns settles once every timer callback has finished.
   */
  async dispose(): Promise<void> {
    await Promise.all([...this.registry.list()].map(mod => this.unload(mod.name)))
    this.state.clear()
  }

  private timersOf(mod: LoadedMod, sessionKey: string): TimerSet {
    const timerKey = `${sessionKey}\u0000${mod.name}`
    let timers = this.timers.get(timerKey)
    if (timers === undefined) {
      timers = new TimerSet(this.options.report, mod.name)
      this.timers.set(timerKey, timers)
    }
    return timers
  }

  private opCore(op: string, input: unknown, context: OpContext<B>): unknown {
    const served = this.options.ops(op)
    if (served !== undefined) return served(input, context)
    const fields = record(input)
    switch (op) {
      case 'state.get': {
        const slot = stateSlot(fields.plugin, fields.key)
        const key = this.options.stateKey(context.binding)
        this.options.onStateRead?.(key, slot)
        return { value: this.state.get(key)?.get(slot) }
      }
      case 'state.set': {
        const slot = stateSlot(fields.plugin, fields.key)
        const key = this.options.stateKey(context.binding)
        let values = this.state.get(key)
        if (values === undefined) {
          values = new Map()
          this.state.set(key, values)
        }
        values.set(slot, fields.value)
        this.options.onStateWritten?.(key, slot)
        return undefined
      }
      case 'clock.now':
        return Date.now()
      case 'clock.sleep': {
        const ms = fields.ms
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new TypeError('$.clock.sleep needs a non-negative number of milliseconds')
        return sleepUnless(ms, context.signal)
      }
      default:
        throw new Error(`no implementation for ${op}`)
    }
  }
}

export type { RegisteredHook }
