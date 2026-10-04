/**
 * A test kit in the shape of `claude-code/testing`: load mods, register
 * stubs that answer in the engine's place beneath every mod, raise events
 * through the mods' hooks, and mount a surface to assert what a mod draws —
 * no session, agent, or harness service involved. This repository's test
 * setup wraps it as `claude-code/testing` for the example mods' own tests.
 * @module
 */

import type { LoadedMod, RegisteredHook } from './chain.ts'
import type { ModPlugin } from './define-mod.ts'
import { findAll, renderText, treeProblem } from './elements.ts'
import type { TreePattern, UiElement, UiNode } from './elements.ts'
import { ModsEngine, OpDenied } from './engine.ts'
import type { OpCore } from './engine.ts'
import type {
  CommandRunInput, CommandRunResult, ModDefinition, ModsApi, PromptSubmitInput, PromptSubmitResult,
  SessionEndInput, SessionEndResult, SessionStartInput, SessionStartResult, ToolCallInput, ToolCallResult,
  TurnCompleteInput, TurnCompleteResult, TurnStartInput, TurnStartResult, UiRenderInput,
} from './types.ts'

/**
 * A stub answering one event in the engine's place. For an engine event it
 * returns that event's result; for a mods API call it returns `{ value }` or
 * `{ deny }`, and `undefined` from either reads as "not answered".
 */
export type StubHook = ($: ModsApi, e: never) => unknown

/** Test kit construction options. */
export interface ModTestKitOptions {
  /** Mods to load, in chain order: definitions or the plugins `defineMod` made. */
  readonly mods?: readonly (ModDefinition | ModPlugin)[]
  /** `register` option values by plugin name, overlaid on each mod's own options. */
  readonly options?: Readonly<Record<string, ModDefinition['options']>>
  /** A hook's own running-time limit in milliseconds; defaults to 5 seconds, Claude Code's test limit. */
  readonly budgetMs?: number
}

/** What `$.ui.mount` takes: the surface to draw and the props the host would pass. */
export interface MountArgs {
  /** The plugin under test; accepted for source compatibility, every loaded mod's `ui.render` hooks run in chain order. */
  readonly plugin?: string
  /** The drawing surface's name (`terminal`, `desktop`); accepted for source compatibility. */
  readonly surface?: string
  readonly component: UiRenderInput['component']
  /** The pane id a `Pane` was opened with; the band has none. */
  readonly requestId?: string
  readonly props?: Readonly<Record<string, unknown>>
}

/** A found element with the actions a test takes on it. */
export interface MountedElement {
  readonly element: UiElement
  /** The element's type. */
  readonly type: UiElement['type']
  /** The text the element draws, descendants included. */
  readonly text: string
  /** Run a Button's `onPress` and redraw. */
  press(): Promise<void>
}

/** A mounted surface: every read renders afresh through the mods' `ui.render` hooks. */
export interface MountedSurface {
  /** The current tree, as the hooks returned it. */
  tree(): Promise<UiNode>
  /** The drawn text, one line per top-level node. */
  text(): Promise<string>
  /** The first element matching the pattern, or undefined. */
  find(pattern: TreePattern): Promise<MountedElement | undefined>
  /** Every element matching the pattern, in drawing order. */
  findAll(pattern: TreePattern): Promise<MountedElement[]>
  unmount(): Promise<void>
}

/** The engine's own `$`-shaped raisers: each sends its event through the mods and resolves to the result. */
export interface TestKitRaisers {
  readonly tool: { call(input: Omit<ToolCallInput, 'tool_use_id'> & { tool_use_id?: string }): Promise<ToolCallResult> }
  readonly command: { run(input: Pick<CommandRunInput, 'command' | 'args'>): Promise<CommandRunResult> }
  readonly prompt: { submit(input: Pick<PromptSubmitInput, 'text'> & Partial<PromptSubmitInput>): Promise<PromptSubmitResult> }
  readonly session: {
    start(input?: Partial<SessionStartInput>): Promise<SessionStartResult>
    end(input?: Partial<SessionEndInput>): Promise<SessionEndResult>
  }
  readonly turn: {
    start(input: Partial<TurnStartInput> & Pick<TurnStartInput, 'turnId'>): Promise<TurnStartResult>
    complete(input?: Partial<TurnCompleteInput>): Promise<TurnCompleteResult>
  }
  readonly ui: {
    /** Mount one surface: it renders through the mods' `ui.render` hooks on every read. */
    mount(args: MountArgs): Promise<MountedSurface>
  }
}

/** The engine events the kit raises, with their inputs, so a typed stub reads `e` without a cast. */
export interface KitEventInputs {
  'session.start': SessionStartInput
  'session.end': SessionEndInput
  'turn.start': TurnStartInput
  'turn.complete': TurnCompleteInput
  'prompt.submit': PromptSubmitInput
  'tool.call': ToolCallInput
  'command.run': CommandRunInput
  'ui.render': UiRenderInput
}

/** The kit's `on`: registers a stub that answers one event beneath every mod; name a mods API call without the `$.`. */
export interface KitOn {
  /** A stub for one engine event, with the event's typed input. */
  <K extends keyof KitEventInputs>(event: K, stub: ($: ModsApi, e: KitEventInputs[K]) => unknown): void
  /** A stub for any event or mods API call. */
  (event: string, stub: StubHook): void
}

/** A loaded test kit. */
export interface ModTestKit {
  /** Register a stub that answers `event` beneath every mod; name a mods API call without the `$.`. */
  readonly on: KitOn
  /** Raise any event through the mods; a stub, a built-in default, or `no implementation for <event>` answers at the bottom. */
  raise<R>(event: string, input: unknown): Promise<R>
  /** Typed raisers for the events this bridge sends from the harness, plus `ui.mount`. */
  readonly $: TestKitRaisers
  /** Diagnostic lines the engine reported: skipped hooks, failed fire-and-forget calls, timer errors. */
  readonly reports: string[]
  /** The loaded mods in chain order. */
  readonly mods: readonly LoadedMod[]
  /**
   * Drop every registration and close every mod timer.
   * @returns settles once running timer callbacks have finished.
   */
  dispose(): Promise<void>
}

/** Stubs that answer a whole namespace from memory. */
export const mock = Object.freeze({
  /**
   * Answer `$.store` from an in-memory map.
   * @param on - the kit's `on`.
   * @param initial - entries the store starts with.
   * @returns the live map, to read what the mod saved.
   */
  store(on: ModTestKit['on'], initial: Readonly<Record<string, unknown>> = {}): Map<string, unknown> {
    const saved = new Map(Object.entries(initial))
    on('store.get', (_$, e: { key: string }) => ({ value: saved.get(e.key) }))
    on('store.set', (_$, e: { key: string; value: unknown }) => {
      saved.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', (_$, e: { key: string }) => {
      saved.delete(e.key)
      return { value: undefined }
    })
    on('store.keys', () => ({ value: [...saved.keys()] }))
    return saved
  },
  /**
   * Answer `$.env.get` from fixed variables and record `$.env.set` writes.
   * @param on - the kit's `on`.
   * @param variables - the environment the mod sees.
   * @returns the live record, to read what the mod set.
   */
  env(on: ModTestKit['on'], variables: Readonly<Record<string, string>> = {}): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...variables }
    on('env.get', (_$, e: { name: string }) => ({ value: env[e.name] }))
    on('env.set', (_$, e: { name: string; value?: string }) => {
      env[e.name] = e.value
      return { value: undefined }
    })
    return env
  },
  /**
   * Answer `$.clock.now` from a settable instant and `$.clock.sleep` at once, advancing it.
   * @param on - the kit's `on`.
   * @param startAt - the first `now()`, in epoch milliseconds.
   * @returns the clock, to read or advance `now`.
   */
  clock(on: ModTestKit['on'], startAt = 0): { now: number; advance(ms: number): void } {
    const clock = {
      now: startAt,
      advance(ms: number): void { clock.now += ms },
    }
    on('clock.now', () => ({ value: clock.now }))
    on('clock.sleep', (_$, e: { ms: number }) => {
      clock.now += e.ms
      return { value: undefined }
    })
    return clock
  },
})

/** Engine events whose default answer mirrors Claude Code's test-kit table when no stub is registered. */
const DEFAULT_ENGINE_ANSWERS: Readonly<Record<string, (e: never) => unknown>> = {
  'session.start': (e: SessionStartInput) => ({ cwd: e.cwd }),
  'session.end': (e: SessionEndInput) => ({ sessionId: e.sessionId }),
  'turn.start': (e: TurnStartInput) => ({ turnId: e.turnId }),
  'turn.complete': () => ({ text: '' }),
  'prompt.submit': (e: PromptSubmitInput) => ({ text: e.text, ...e.context === undefined ? {} : { context: e.context } }),
  'command.run': () => ({}),
  'ui.render': () => null,
}

/** Mods API calls the kit answers itself, as Claude Code's kit does. */
const DEFAULT_OP_ANSWERS: Readonly<Record<string, StubHook>> = {
  'ui.invalidate': () => ({ value: undefined }),
  'ui.open': (_$, e: { id: string }) => ({ value: { id: e.id, isPlaced: false } }),
  'ui.close': () => ({ value: undefined }),
}

function definitionOf(mod: ModDefinition | ModPlugin): ModDefinition {
  return 'definition' in mod ? mod.definition : mod
}

/**
 * Load mods for a test and return the kit.
 * @param options - the mods to load and the hook time limit.
 * @returns the kit, with every mod's `register` already run.
 */
export async function createModTestKit(options: ModTestKitOptions = {}): Promise<ModTestKit> {
  const reports: string[] = []
  const stubs = new Map<string, StubHook>()
  const engine = new ModsEngine<Record<never, never>>({
    ops: (op) => {
      const stub = stubs.get(op) ?? DEFAULT_OP_ANSWERS[op]
      return stub === undefined ? undefined : opStub(op, stub)
    },
    stateKey: () => 'test',
    budgetMs: options.budgetMs ?? 5_000,
    catchBudgetMs: 1_000,
    report: (line) => { reports.push(line) },
  })
  const kitMod: LoadedMod = Object.freeze({
    name: 'claude-code-testing', version: undefined, root: process.cwd(), options: Object.freeze({}), order: Number.MAX_SAFE_INTEGER,
  })
  const binding = {}
  const signal = new AbortController().signal

  function opStub(op: string, stub: StubHook): OpCore<Record<never, never>> {
    return async (input) => {
      const answer = await stub(engine.api(kitMod, undefined, binding, signal), input as never)
      if (typeof answer !== 'object' || answer === null) throw new Error(`${op}: a stub returned neither { value } nor { deny }`)
      const result = answer as { value?: unknown; deny?: unknown }
      if (typeof result.deny === 'string') throw new OpDenied(result.deny)
      if (!('value' in result)) throw new Error(`${op}: a stub returned neither { value } nor { deny }`)
      return result.value
    }
  }

  for (const entry of options.mods ?? []) {
    const definition = definitionOf(entry)
    await engine.add({ ...definition, options: { ...definition.options, ...options.options?.[definition.name] } })
  }

  function raise<R>(event: string, input: unknown): Promise<R> {
    return engine.raise<unknown, R>(event, input, async (e) => {
      const stub = stubs.get(event)
      if (stub !== undefined) {
        const answer = await stub(engine.api(kitMod, undefined, binding, signal), e as never)
        if (typeof answer !== 'object' || answer === null) throw new Error(`${event}: the stub returned no result`)
        return answer as R
      }
      const fallback = DEFAULT_ENGINE_ANSWERS[event]
      if (fallback === undefined) throw new Error(`no implementation for ${event}`)
      return fallback(e as never) as R
    }, { binding, signal })
  }

  let calls = 0
  const mounted = new Set<string>()

  async function render(args: MountArgs): Promise<UiNode> {
    const props = args.props ?? {}
    const columns = typeof props['bodyColumns'] === 'number' ? props['bodyColumns'] : 80
    const input: UiRenderInput = {
      component: args.component,
      surface: args.requestId ?? args.component,
      ...args.requestId === undefined ? {} : { requestId: args.requestId },
      props,
      viewport: { columns },
    }
    const tree = await raise<UiNode>('ui.render', input)
    const problem = treeProblem(tree)
    if (problem !== undefined) throw new Error(`ui.render returned a tree that does not validate: ${problem}`)
    return tree
  }

  function mountedElement(element: UiElement, redraw: () => Promise<UiNode>): MountedElement {
    return {
      element,
      type: element.type,
      text: renderText(element),
      async press(): Promise<void> {
        const onPress = element.props['onPress']
        if (element.type !== 'Button' || typeof onPress !== 'function') throw new Error(`press() needs a Button with onPress, not a ${element.type}`)
        await (onPress as () => unknown)()
        await redraw()
      },
    }
  }

  return {
    on: (event: string, stub: StubHook): void => {
      stubs.set(event, stub)
    },
    raise,
    $: {
      tool: {
        call: input => raise<ToolCallResult>('tool.call', { tool_use_id: `test-${++calls}`, ...input }),
      },
      command: {
        run: input => raise<CommandRunResult>('command.run', { ...input, origin: { kind: 'composer' } }),
      },
      prompt: {
        submit: input => raise<PromptSubmitResult>('prompt.submit', { wait: false, origin: { kind: 'composer' }, ...input }),
      },
      session: {
        start: (input = {}) => raise<SessionStartResult>('session.start', { cwd: process.cwd(), surface: null, isInteractive: true, ...input }),
        end: (input = {}) => raise<SessionEndResult>('session.end', { reason: 'other', sessionId: 'test', ...input }),
      },
      turn: {
        start: input => raise<TurnStartResult>('turn.start', { text: '', ...input }),
        complete: (input = {}) => raise<TurnCompleteResult>('turn.complete', {
          turnId: '1', answer: '', durationMs: 0, isAborted: false, reason: 'answer', ...input,
        }),
      },
      ui: {
        mount: async (args) => {
          const key = args.requestId ?? args.component
          if (mounted.has(key)) throw new Error(`surface ${key} is already mounted`)
          mounted.add(key)
          const redraw = (): Promise<UiNode> => render(args)
          await redraw()
          return {
            tree: redraw,
            text: async () => renderText(await redraw()),
            find: async pattern => findAll(await redraw(), pattern).map(element => mountedElement(element, redraw))[0],
            findAll: async pattern => findAll(await redraw(), pattern).map(element => mountedElement(element, redraw)),
            unmount: () => {
              mounted.delete(key)
              return Promise.resolve()
            },
          }
        },
      },
    },
    reports,
    get mods() {
      return engine.registry.list()
    },
    dispose() {
      return engine.dispose()
    },
  }
}

export type { RegisteredHook }
