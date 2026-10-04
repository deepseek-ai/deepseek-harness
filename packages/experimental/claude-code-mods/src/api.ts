/**
 * The `$` a hook receives. Each method shapes its arguments into the mods API
 * event of the same name and hands it to the binding's `invoke`, which runs
 * the mods loaded before this one and then the engine's implementation. The
 * hook's running-time clock pauses while a call is awaited, except for
 * `$.clock.sleep`, which Claude Code counts as the hook's own time.
 * @module
 */

import { uiElements } from './elements.ts'
import type { BudgetClock, LoadedMod } from './chain.ts'
import { messageOf } from './values.ts'
import type {
  AskOptions, CommandInfo, CommandRunResult, CommandSpec, FsEntry, FsStat, HttpInit, HttpResponse, ModsApi, PaneOpenArgs,
  PaneOpenResult, ProcessRunInit, ProcessRunResult, PromptSubmitArgs, SessionMessage, SessionUsage, SessionVersion,
  StateRef, ModTimer, ToastOptions, ToolCallResult, ToolInfo, ToolSpec, UiLogOptions,
} from './types.ts'

/** Timers the engine owns on a mod's behalf, so disposal and reload can cancel them. */
export interface TimerHost {
  after(ms: number, fn: () => unknown): ModTimer
  every(ms: number, fn: () => unknown): ModTimer
}

/** What one `$` instance is bound to. */
export interface ApiBinding {
  readonly mod: LoadedMod
  /** The running hook's clock, paused while mods API calls are awaited; absent outside a hook. */
  readonly clock: BudgetClock | undefined
  /**
   * Raise one mods API call as its event and resolve to the value the chain
   * answered with; a `{ deny }` answer rejects with the reason.
   */
  readonly invoke: (op: string, input: unknown) => Promise<unknown>
  readonly timers: TimerHost
  /** Receives a rejected fire-and-forget call's reason. */
  readonly report: (line: string) => void
}

/**
 * Build the `$` for one hook invocation.
 * @param binding - the mod, clock, and engine entry points this instance uses.
 * @returns the mods API.
 */
export function createModsApi(binding: ApiBinding): ModsApi {
  const { mod, clock, timers } = binding

  async function call<T>(op: string, input: unknown): Promise<T> {
    clock?.pause()
    try {
      return await binding.invoke(op, input) as T
    } finally {
      clock?.resume()
    }
  }

  function fire(op: string, input: unknown): void {
    call(op, input).catch((error: unknown) => {
      binding.report(`${mod.name}: $.${op} failed: ${messageOf(error)}`)
    })
  }

  // Not frozen: the proxy below returns a wrapped namespace, which a frozen target's invariant would forbid.
  const served: ModsApi = {
    plugin: Object.freeze({ name: mod.name, root: mod.root }),
    ui: Object.freeze({
      log(text: string, options?: UiLogOptions): void {
        fire('ui.log', { text, to: options?.to ?? 'transcript' })
      },
      toast(text: string, options?: ToastOptions): void {
        fire('ui.toast', { text, ...options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs } })
      },
      status(text: string | undefined): void {
        fire('ui.status', { text })
      },
      invalidate(event: string): void {
        fire('ui.invalidate', { event })
      },
      open(pane: PaneOpenArgs): Promise<PaneOpenResult> {
        return call('ui.open', pane)
      },
      close(pane: { id: string }): Promise<void> {
        return call('ui.close', { id: pane.id, origin: 'plugin' })
      },
      panes(): Promise<never[]> {
        return call('ui.panes', {})
      },
      ask(question: string, options?: readonly string[] | AskOptions): Promise<string> {
        const normalized: AskOptions = Array.isArray(options) ? { options } : options as AskOptions | undefined ?? {}
        return call('ui.ask', { question, ...normalized })
      },
      resolve: () => uiElements(),
    }),
    command: Object.freeze({
      register(command: CommandSpec): Promise<void> {
        return call('command.register', command)
      },
      run(input: { command: string; args?: string }): Promise<CommandRunResult> {
        return call('command.run', { command: input.command, args: input.args ?? '' })
      },
      list(): Promise<CommandInfo[]> {
        return call('command.list', {})
      },
    }),
    tool: Object.freeze({
      register(tool: ToolSpec): Promise<void> {
        return call('tool.register', tool)
      },
      call(input: { tool: string; [argument: string]: unknown }): Promise<ToolCallResult> {
        return call('tool.call', input)
      },
      list(): Promise<ToolInfo[]> {
        return call('tool.list', {})
      },
    }),
    prompt: Object.freeze({
      submit(input: PromptSubmitArgs): Promise<{ text: string }> {
        return call('prompt.submit', { text: input.text, asUser: input.asUser === true })
      },
    }),
    session: Object.freeze({
      id: (): Promise<string> => call('session.id', {}),
      cwd: (): Promise<string> => call('session.cwd', {}),
      root: (): Promise<string> => call('session.root', {}),
      model: (): Promise<string> => call('session.model', {}),
      turns: (): Promise<number> => call('session.turns', {}),
      messages: (): Promise<SessionMessage[]> => call('session.messages', {}),
      usage: (): Promise<SessionUsage> => call('session.usage', {}),
      version: (): Promise<SessionVersion> => call('session.version', {}),
    }),
    state: Object.freeze({
      get(ref: StateRef): Promise<{ value: unknown }> {
        return call('state.get', { plugin: ref.plugin, key: ref.key })
      },
      set(ref: StateRef, value: unknown): Promise<void> {
        return call('state.set', { plugin: ref.plugin, key: ref.key, value })
      },
    }),
    store: Object.freeze({
      get: (key: string): Promise<unknown> => call('store.get', { key }),
      set: (key: string, value: unknown): Promise<void> => call('store.set', { key, value }),
      delete: (key: string): Promise<void> => call('store.delete', { key }),
      keys: (): Promise<string[]> => call('store.keys', {}),
    }),
    clock: Object.freeze({
      now: (): Promise<number> => call('clock.now', {}),
      // Counted as the hook's own time, so the clock is not paused.
      sleep: (ms: number): Promise<void> => binding.invoke('clock.sleep', { ms }) as Promise<void>,
      after: (ms: number, fn: () => unknown): ModTimer => timers.after(ms, fn),
      every: (ms: number, fn: () => unknown): ModTimer => timers.every(ms, fn),
    }),
    fs: Object.freeze({
      read: (path: string): Promise<string> => call('fs.read', { path, as: 'text' }),
      write: (path: string, text: string): Promise<void> => call('fs.write', { path, text }),
      list: (path?: string): Promise<FsEntry[]> => call('fs.list', { path: path ?? '.' }),
      exists: (path: string): Promise<boolean> => call('fs.exists', { path }),
      stat: (path: string): Promise<FsStat> => call('fs.stat', { path, resolve: true }),
    }),
    process: Object.freeze({
      run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> {
        return call('process.run', { argv, ...init === undefined ? {} : { init } })
      },
    }),
    http: Object.freeze({
      fetch(url: string, init?: HttpInit): Promise<HttpResponse> {
        return call('http.fetch', { url, ...init === undefined ? {} : { init } })
      },
    }),
    env: Object.freeze({
      get: (name: string): Promise<string | undefined> => call('env.get', { name }),
      set: (name: string, value: string | undefined): Promise<void> => call('env.set', { name, ...value === undefined ? {} : { value } }),
    }),
  }
  return withUnservedMembers(served, mod.name)
}

/** The method namespaces Claude Code's `$` has; `plugin` holds facts, not methods, and stays as served. */
const METHOD_NAMESPACES: ReadonlySet<string> = new Set([
  'ui', 'command', 'tool', 'prompt', 'session', 'state', 'store', 'clock', 'fs', 'process', 'http', 'env',
  'model', 'agent', 'config', 'settings', 'mcp', 'audio', 'telemetry', 'turn',
])

/**
 * Give `$` Claude Code's full namespace set: a served member is itself; any
 * other member of a method namespace is a function whose call rejects with
 * `no implementation for <namespace>.<member>`, so a mod that reaches past
 * this host fails with the gap named, not with a TypeError.
 * @param served - the frozen object of served namespaces.
 * @param modName - the mod the `$` belongs to, for the rejection text.
 * @returns the `$` a hook receives.
 */
function withUnservedMembers(served: ModsApi, modName: string): ModsApi {
  const namespaces = new Map<string, object>()
  const namespaceOf = (name: string, base: object): object => {
    let wrapped = namespaces.get(name)
    if (wrapped === undefined) {
      wrapped = new Proxy(base, {
        get(target, member, receiver) {
          const own: unknown = Reflect.get(target, member, receiver)
          if (own !== undefined || typeof member !== 'string' || member === 'then') return own
          return () => Promise.reject(new Error(`${modName}: no implementation for ${name}.${member}`))
        },
      })
      namespaces.set(name, wrapped)
    }
    return wrapped
  }
  return new Proxy(served, {
    get(target, namespace, receiver) {
      const own: unknown = Reflect.get(target, namespace, receiver)
      if (typeof namespace !== 'string' || !METHOD_NAMESPACES.has(namespace)) return own
      return namespaceOf(namespace, typeof own === 'object' && own !== null ? own : Object.freeze({}))
    },
    // `$` is read-only, as the frozen object was.
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}
