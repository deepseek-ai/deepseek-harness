/**
 * Mods-facing types: the hooks-module contract (`register`, `on`, hooks,
 * `next`), the event inputs and results this bridge raises, and the `$` mods
 * API subset it serves. Field names follow Claude Code's declarations so an
 * unmodified mod type-checks against the same names; only the members this
 * bridge implements are declared.
 * @module
 */

import type { UiElements, UiNode } from './elements.ts'

/** Values a plugin manifest's `userConfig` fields and `register(on, options)` carry. */
export type PluginOptionValue = string | number | boolean | readonly string[]

/** The `options` argument of `register`: manifest `userConfig` defaults overlaid by deployment values. */
export type PluginOptions = Readonly<Record<string, PluginOptionValue>>

/** Tier a mod runs in; this bridge loads every mod as `user`, and its own engine behavior is `core`. */
export type ModTier = 'prepend' | 'user' | 'append' | 'builtin' | 'core'

/** Who raised an event: the engine itself, or the mod whose `$` call became the event. */
export interface HookOrigin {
  readonly plugin: string
  readonly tier: ModTier
}

/** The failing hook's error as a `.catch` handler sees it on `next.error`. */
export interface HookFailure {
  readonly kind: 'throw' | 'timeout'
  readonly message: string
}

/** The hook's own running-time limit: the whole limit and what is left now. */
export interface HookBudget {
  readonly ms: number
  readonly remainingMs: number
}

/**
 * The `next` handler every hook receives: calling it runs the hooks beneath,
 * then the engine behavior, and resolves to the event's result. Time spent
 * awaiting it does not count against the hook's budget.
 */
export interface HookNext<E, R> {
  (e: E): Promise<R>
  /** Fires when the event is abandoned (the owning agent cancelled). */
  readonly signal: AbortSignal
  /** Who raised the event. */
  readonly origin: HookOrigin
  /** The hook's running-time limit. */
  readonly budget: HookBudget
  /** Skipping tiers is a managed-settings feature this bridge does not implement; always throws. */
  to(e: E, tier: ModTier): Promise<R>
  /** In a `.catch` handler: how the hook failed. */
  readonly error?: HookFailure
  /** In a `.catch` handler: whether the failed hook had called `next`. */
  readonly called?: boolean
}

/** A hook on one event: the mods API, the frozen event input, and the next handler. */
export type ModHook<E, R> = ($: ModsApi, e: E, next: HookNext<E, R>) => R | Promise<R>

/** A hook whose event and result the registry does not narrow. */
export type AnyHook = ModHook<unknown, unknown>

/** What `on` returns: `.catch` attaches the hook's error handler. */
export interface HookRegistration {
  catch(handler: AnyHook): void
}

/** A matcher field: one value, a list of allowed values, or a regular expression. */
export type MatcherValue = string | number | boolean | null | RegExp | readonly (string | number | boolean | null)[]

/** The optional second argument of `on`: top-level event fields the hook requires. */
export type HookMatcher = Readonly<Record<string, MatcherValue>>

/** The engine events this host raises, with their inputs and results, so a typed hook reads `e` without a cast. */
export interface ModEvents {
  'session.start': { input: SessionStartInput; result: SessionStartResult }
  'session.end': { input: SessionEndInput; result: SessionEndResult }
  'prompt.submit': { input: PromptSubmitInput; result: PromptSubmitResult }
  'turn.start': { input: TurnStartInput; result: TurnStartResult }
  'turn.complete': { input: TurnCompleteInput; result: TurnCompleteResult }
  'tool.call': { input: ToolCallInput; result: ToolCallResult }
  'command.run': { input: CommandRunInput; result: CommandRunResult }
  'ui.render': { input: UiRenderInput; result: UiRenderResult }
}

/** The `on` function `register` receives: typed for the events this host raises, open for every other Claude Code event. */
export interface ModOn {
  <K extends keyof ModEvents>(event: K, hook: ModHook<ModEvents[K]['input'], ModEvents[K]['result']>): HookRegistration
  <K extends keyof ModEvents>(event: K, matcher: HookMatcher, hook: ModHook<ModEvents[K]['input'], ModEvents[K]['result']>): HookRegistration
  (event: string, hook: AnyHook): HookRegistration
  (event: string, matcher: HookMatcher, hook: AnyHook): HookRegistration
}

/** The function a hooks module exports. */
export type ModRegister = (on: ModOn, options: PluginOptions) => unknown

/**
 * One mod as a DSH plugin hands it to the bridge: the plugin identity Claude
 * Code reads from `plugin.json`, the `register` its hooks module exports, and
 * the `options` that `register` receives (the mod's validated plugin config).
 */
export interface ModDefinition {
  /** Plugin name: letters, digits, `_` and `-`; the `plugin` of `$.state` refs and the `mcp__<plugin>__` tool prefix. */
  readonly name: string
  readonly version?: string
  /** Absolute directory the mod ships in, as `$.plugin.root` reports it; defaults to the process cwd. */
  readonly root?: string
  readonly options?: PluginOptions
  readonly register: ModRegister
}

// ---- Drawn surfaces, as a Client receives them ----

/** A serialized element: callbacks replaced by the action id the host holds for them. */
export interface SerializedElement {
  readonly type: 'Box' | 'Text' | 'Button'
  readonly props: Readonly<Record<string, string | number | boolean>>
  readonly children: readonly SerializedNode[]
  /** Set on a `Button` whose `onPress` the host holds. */
  readonly actionId?: string
}

/** A serialized tree node: an element or a run of text. */
export type SerializedNode = SerializedElement | string

/** One drawn generation of a session's band above the prompt. */
export interface SurfaceSnapshot {
  /** Increases with every redraw; a press names the generation it saw. */
  readonly generation: number
  /** The serialized tree, or null when no mod drew. */
  readonly tree: readonly SerializedNode[] | null
}

// ---- Event inputs and results ----

/** `ui.render`: the host asks the mods to draw one surface; the first hook that returns a tree draws it. */
export interface UiRenderInput {
  /** The surface being drawn: the band above the prompt, or a pane a mod opened. */
  component: 'AbovePrompt' | 'Pane'
  /** Stable surface instance id: the pane id, or the component name for the band. */
  surface: string
  /** The pane id the mod chose in `$.ui.open`, on a `Pane`. */
  requestId?: string
  /** Surface-owned props: `bodyColumns`, `hasSurvey`, `isWorking`, `maxRows` on the band. */
  props: Readonly<Record<string, unknown>>
  /** Drawable size the host knows. */
  viewport: { readonly columns: number; readonly rows?: number }
}

/** `ui.render` result: the tree to draw; `next(e)` yields the surface to the next mod and finally to the host, which draws nothing. */
export type UiRenderResult = UiNode

/** Where a prompt or command came from. */
export type PromptOrigin =
  | { kind: 'composer' }
  | { kind: 'plugin'; name: string }

/** `session.start`: once per root agent before its first prompt; every loaded mod's hook sees the same event. */
export interface SessionStartInput {
  cwd: string
  /** The drawing surface's name (Claude Code: `terminal`, `desktop`); this host reports `null` when no surface draws mods. */
  surface: string | null
  /** Whether a human answerer is composed, so `$.ui.ask` can resolve. */
  isInteractive: boolean
}

/** Result of `session.start`. */
export interface SessionStartResult {
  cwd: string
}

/** `session.end`: the agent was disposed. */
export interface SessionEndInput {
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'resume' | 'other'
  sessionId: string
}

/** Result of `session.end`. */
export interface SessionEndResult {
  sessionId: string
}

/** `prompt.submit`: a prompt is about to enter a turn. */
export interface PromptSubmitInput {
  text: string
  /** Extra text only the model reads, appended after the prompt. */
  context?: readonly string[]
  turnId?: string
  wait: boolean
  origin: PromptOrigin
}

/** Result of `prompt.submit`: the text that entered, or a drop with its reason. */
export type PromptSubmitResult =
  | { text: string; context?: readonly string[]; drop?: undefined }
  | { drop: string; text?: undefined; context?: undefined }

/** `turn.start`: a turn begins with this prompt text. */
export interface TurnStartInput {
  text: string
  turnId: string
  agentId?: string
}

/** Result of `turn.start`. */
export interface TurnStartResult {
  turnId: string
}

/** Token totals of one turn, in Claude Code's API vocabulary. */
export interface TurnUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

/** `turn.complete`: a turn ended. */
export interface TurnCompleteInput {
  turnId: string
  answer: string
  durationMs: number
  isAborted: boolean
  reason: 'answer' | 'aborted' | 'error'
  agentId?: string
  usage?: TurnUsage
}

/** Result of `turn.complete`: `text` is shown as a line under the answer. */
export interface TurnCompleteResult {
  text: string
}

/** `tool.call`: the tool's name and arguments as top-level fields. */
export interface ToolCallInput {
  tool: string
  tool_use_id: string
  agentId?: string
  [argument: string]: unknown
}

/** Result of `tool.call`: a refusal, or the tool's result. */
export type ToolCallResult =
  | { deny: string; result?: undefined; isError?: undefined }
  | { result: unknown; isError?: true; deny?: undefined }

/** `command.run`: a registered command was typed. */
export interface CommandRunInput {
  command: string
  /** Text typed after the command name, or an empty string. */
  args: string
  origin: PromptOrigin
}

/** Result of `command.run`: `text` prints in the transcript; `{}` prints nothing. */
export interface CommandRunResult {
  text?: string
}

/** Result of a mods API call as an event: the value, or a refusal. */
export type OpResult = { value: unknown; deny?: undefined } | { deny: string; value?: undefined }

// ---- The mods API (`$`) ----

/** A command a mod registers for the user. */
export interface CommandSpec {
  name: string
  description: string
  argumentHint?: string
  immediate?: true
}

/** A command in the effective list. */
export interface CommandInfo {
  name: string
  description: string
  source: 'builtin' | 'plugin' | 'user' | 'mcp'
  plugin?: string
}

/** A tool a mod registers for the model. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

/** A tool in the effective list. */
export interface ToolInfo {
  name: string
  description: string
}

/** One message of the transcript as `$.session.messages()` returns it. */
export interface SessionMessage {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUseSummary[]
}

/** One tool call inside an assistant message. */
export interface ToolUseSummary {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
}

/** Context-window occupancy and plan limits. */
export interface SessionUsage {
  startedAt: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: never[]
}

/** The mods API version the bridge reports. */
export interface SessionVersion {
  version: string
  engine: 'deepseek-harness'
}

/** `$.ui.ask` options. */
export interface AskOptions {
  options?: readonly string[]
  header?: string
  multiSelect?: true
}

/** Where `$.ui.log` writes. */
export interface UiLogOptions {
  to?: 'transcript' | 'debug'
}

/** `$.ui.toast` options. */
export interface ToastOptions {
  timeoutMs?: number
}

/** `$.ui.open` arguments. */
export interface PaneOpenArgs {
  id: string
  title?: string
  focus?: true
  closeOnEscape?: true
  holdToasts?: true
  rows?: number
  columns?: number
}

/** `$.ui.open` result: this bridge places no panes. */
export interface PaneOpenResult {
  /** The pane id the mod chose. */
  id: string
  isPlaced: boolean
  reason?: string
}

/** A `$.state` value reference. */
export interface StateRef {
  plugin: string
  key: string
}

/** A timer returned by `$.clock.after` and `$.clock.every`. */
export interface ModTimer {
  cancel(): void
}

/** A file entry from `$.fs.list`. */
export interface FsEntry {
  name: string
  kind: 'file' | 'dir' | 'other'
  size: number
  isLink: boolean
}

/** `$.fs.stat` result. */
export interface FsStat {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
}

/** `$.process.run` options. */
export interface ProcessRunInit {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

/** `$.process.run` result, whatever the exit code. */
export interface ProcessRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** `$.http.fetch` options. */
export interface HttpInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** `$.http.fetch` result once the body is read. */
export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
}

/** `$.prompt.submit` arguments. */
export interface PromptSubmitArgs {
  text: string
  /** Send the text as the user's own words, without the sentence naming the mod. */
  asUser?: boolean
}

/**
 * The mods API a hook receives as `$`. Every method except `$.plugin` and
 * `$.ui.resolve` is also an event named `<namespace>.<method>` that mods
 * earlier in the chain may observe, rewrite, or refuse.
 */
export interface ModsApi {
  readonly plugin: { readonly name: string; readonly root: string }
  readonly ui: {
    log(text: string, options?: UiLogOptions): void
    toast(text: string, options?: ToastOptions): void
    status(text: string | undefined): void
    invalidate(event: string): void
    open(pane: PaneOpenArgs): Promise<PaneOpenResult>
    close(pane: { id: string }): Promise<void>
    panes(): Promise<never[]>
    ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
    /** The element constructors for the surface a `ui.render` event draws; not an event itself. */
    resolve(e: UiRenderInput): UiElements
  }
  readonly command: {
    register(command: CommandSpec): Promise<void>
    run(input: { command: string; args?: string }): Promise<CommandRunResult>
    list(): Promise<CommandInfo[]>
  }
  readonly tool: {
    register(tool: ToolSpec): Promise<void>
    call(input: { tool: string; [argument: string]: unknown }): Promise<ToolCallResult>
    list(): Promise<ToolInfo[]>
  }
  readonly prompt: {
    submit(input: PromptSubmitArgs): Promise<{ text: string }>
  }
  readonly session: {
    id(): Promise<string>
    cwd(): Promise<string>
    root(): Promise<string>
    model(): Promise<string>
    turns(): Promise<number>
    messages(): Promise<SessionMessage[]>
    usage(): Promise<SessionUsage>
    version(): Promise<SessionVersion>
  }
  readonly state: {
    get(ref: StateRef): Promise<{ value: unknown }>
    set(ref: StateRef, value: unknown): Promise<void>
  }
  readonly store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }
  readonly clock: {
    now(): Promise<number>
    sleep(ms: number): Promise<void>
    after(ms: number, fn: () => unknown): ModTimer
    every(ms: number, fn: () => unknown): ModTimer
  }
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    list(path?: string): Promise<FsEntry[]>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<FsStat>
  }
  readonly process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
  }
  readonly http: {
    fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  }
  readonly env: {
    get(name: string): Promise<string | undefined>
    set(name: string, value: string | undefined): Promise<void>
  }
}
