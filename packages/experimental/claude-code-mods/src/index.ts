/**
 * Experimental bridge for Claude Code mods. A mod is a DSH plugin built with
 * {@link defineMod} around the mod's `register(on, options)`; this service
 * keeps the loaded mods and raises their events from harness extension
 * points — `session.start` on `agent/created`, `prompt.submit` and
 * `turn.start` on `agent/pre-step`, `tool.call` around `tools/execute`,
 * `turn.complete` on `turn/end`, `session.end` on `agent/disposed`, and
 * `command.run` from the commands a mod registers. The `$` a hook receives is
 * served by {@link createHostOps} over the composed harness services.
 * @module @deepseek-ai/dsh-experimental-claude-code-mods
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AssistantMessage, ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { LoadedMod } from './chain.ts'
import { RewriteRefusedError } from './chain.ts'
import { ModsEngine } from './engine.ts'
import { createHostOps, toolCallResultOf } from './host-ops.ts'
import type { AgentBinding } from './host-ops.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SurfaceTable } from './surfaces.ts'
import { createToolNameAliases } from './tool-names.ts'
import { messageOf, record, stringify } from './values.ts'
import type {
  ModDefinition, PromptSubmitInput, PromptSubmitResult, SessionEndInput, SessionEndResult, SessionStartInput,
  SessionStartResult, ToolCallInput, ToolCallResult, TurnCompleteInput, TurnCompleteResult, TurnStartInput,
  SurfaceSnapshot, TurnStartResult, TurnUsage, UiRenderInput, UiRenderResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    claudeCodeMods: ClaudeCodeMods
  }
}

export type * from './types.ts'
export type { BoxProps, ButtonProps, TextProps, UiElement, UiElements, UiNode } from './elements.ts'
export { defineMod, type ModConfig, type ModPlugin, type ModSpec } from './define-mod.ts'
export { DEFAULT_TOOL_ALIASES } from './tool-names.ts'
export { KNOWN_EVENTS } from './matcher.ts'
export { MODS_API_VERSION } from './host-ops.ts'

/** Plugin config: the limits mod hooks run under. */
export interface Config {
  /** A hook's own running-time limit in milliseconds (Claude Code: 10 seconds). */
  hookTimeoutMs?: number
  /** A `.catch` handler's running-time limit in milliseconds (Claude Code: 1 second). */
  catchTimeoutMs?: number
  /** Default `$.process.run` and `$.http.fetch` timeout in milliseconds (Claude Code: 30 seconds). */
  processTimeoutMs?: number
  /** Claude Code tool name → harness tool name entries added to the built-in alias table. */
  toolAliases?: Record<string, string>
  /** Columns the band above the prompt reports to `ui.render` as `bodyColumns` and `viewport.columns`. */
  bandColumns?: number
  /** Rows the band reports as `maxRows`. */
  bandRows?: number
}

/** Engine events this host raises; a hook on any other known event registers and is reported as unserved. */
export const SERVED_EVENTS: ReadonlySet<string> = new Set([
  'session.start', 'session.end', 'prompt.submit', 'turn.start', 'turn.complete', 'tool.call', 'command.run', 'ui.render',
])

/** Where the deferred argument-rewrite mechanism is specified. */
const REWRITE_NOTE = '.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md'

function assertPositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`claude-code-mods: ${field} must be a positive number of milliseconds`)
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
}

/** The human's own messages among a claim: the prompt a `prompt.submit` hook sees and may rewrite. */
function promptMessages(claimed: readonly UserMessage[]): UserMessage[] {
  return claimed.filter(message => message.source.kind === 'user')
}

/**
 * Replace the prompt text across the human's messages with one rewritten
 * text: the first text block carries it, other text blocks go, every
 * non-text block stays in place. A prompt without any text block, such as an
 * image alone, gains the text after its blocks.
 */
function rewritePromptText(prompt: readonly UserMessage[], text: string): UserMessage[] {
  // Written inside the map callback, so the flag lives on an object the later read sees current.
  const placement = { placed: false }
  const rewritten = prompt.map((message) => {
    if (!message.content.some(block => block.type === 'text')) return message
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'text') {
        content.push(block)
      } else if (!placement.placed) {
        placement.placed = true
        content.push({ type: 'text', text })
      }
    }
    return { ...message, content }
  })
  const first = rewritten[0]
  if (placement.placed || text.length === 0 || first === undefined) return rewritten
  return [{ ...first, content: [...first.content, { type: 'text', text }] }, ...rewritten.slice(1)]
}

/** Append the context a hook attached as blocks after the prompt as typed, on the last of the human's messages. */
function appendContext(prompt: readonly UserMessage[], context: readonly string[]): UserMessage[] {
  const last = prompt.at(-1)
  /* v8 ignore next -- the caller only appends context to a prompt it raised, which has at least one human message */
  if (last === undefined) return [...prompt]
  const blocks: ContentBlock[] = context.map(line => ({ type: 'text', text: line }))
  return [...prompt.slice(0, -1), { ...last, content: [...last.content, ...blocks] }]
}

/** Keep only the fields of a `prompt.submit` result a mod may set, each with its declared type. */
function acceptPromptSubmit(result: PromptSubmitResult, original: string): PromptSubmitResult {
  if (typeof result.drop === 'string') return { drop: result.drop }
  const context = Array.isArray(result.context) ? result.context.filter((line): line is string => typeof line === 'string') : []
  return { text: typeof result.text === 'string' ? result.text : original, ...context.length === 0 ? {} : { context } }
}

/** What the bridge folds from one session's event stream about its open turn. */
interface TurnRecord {
  turn: number
  startedAt: number
  /** The last committed assistant text of the turn. */
  answer: string
  usage: TurnUsage | undefined
}

/** Fold one committed assistant message into the turn's answer and usage. */
function foldAssistantMessage(turnRecord: TurnRecord, data: { message: AssistantMessage; usage?: TokenUsage }): void {
  turnRecord.answer = textOf(data.message.content)
  if (data.usage === undefined) return
  const { model } = data.message.source
  const usage = turnRecord.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model }
  usage.input_tokens += data.usage.inputTokens
  usage.output_tokens += data.usage.outputTokens
  usage.cache_read_input_tokens += data.usage.cacheReadTokens ?? 0
  usage.cache_creation_input_tokens += data.usage.cacheWriteTokens ?? 0
  usage.model = model
  turnRecord.usage = usage
}

/** Detached mod runs the bridge tracks so disposal can await them; a rejection is reported, never unhandled. */
class DetachedRuns {
  private readonly pending = new Set<Promise<unknown>>()
  readonly controller = new AbortController()

  constructor(private readonly report: (line: string) => void) {}

  track(label: string, run: Promise<unknown>): void {
    /* v8 ignore next -- the engine behaviors beneath these runs are total; the report guards a future rejecting one */
    const settled = run.then(() => undefined, (error: unknown) => { this.report(`${label} failed: ${messageOf(error)}`) })
    this.pending.add(settled)
    void settled.finally(() => { this.pending.delete(settled) })
  }

  /** Abort every run's signal; `drain` then waits for them to settle. */
  cancel(): void {
    this.controller.abort(new Error('claude-code-mods disposed'))
  }

  async drain(): Promise<void> {
    this.cancel()
    await Promise.allSettled([...this.pending])
  }
}

/** The lossless-JSON copy of a mod's answer, or undefined when it has none. */
function jsonValueOf(value: unknown): JsonValue | undefined {
  const text = stringify(value)
  return text === undefined ? undefined : JSON.parse(text) as JsonValue
}

/** An error-shaped tool result carrying a mod's text in place of the tool's own. */
function modAnswered(text: string, code: 'MOD_DENIED' | 'MOD_ANSWERED', rendered = text): ToolExecutionResult {
  return {
    isError: true,
    error: { message: text, info: { name: code === 'MOD_DENIED' ? 'ModDenied' : 'ModAnswered', code } },
    content: [{ type: 'text', text: rendered }],
  }
}

/**
 * The bridge service: loaded mods, their hooks, and the harness listeners
 * that raise their events. Mods join through {@link ClaudeCodeMods.add},
 * which {@link defineMod} calls when a mod plugin mounts. The Remote methods
 * let a Client draw each session's band above the prompt and press its buttons.
 */
export class ClaudeCodeMods extends TypertRemoteService {
  static Config: z<Config> = z.object({
    hookTimeoutMs: z.number().default(10_000),
    catchTimeoutMs: z.number().default(1_000),
    processTimeoutMs: z.number().default(30_000),
    toolAliases: z.dict(z.string()),
    bandColumns: z.number().default(120),
    bandRows: z.number().default(10),
  })

  // Session initialization requires its directory owner; other services are read on demand.
  static inject = ['workingDirectory']

  private readonly engine: ModsEngine<AgentBinding>
  private readonly registrations = new Map<string, Set<() => void>>()
  private readonly surfaces: SurfaceTable

  constructor(ctx: Context, config: Config) {
    super(ctx, 'claudeCodeMods', { namespace: 'claudeCodeMods' })
    // The schema supplies every default; a direct construction passes the fields it needs.
    const { hookTimeoutMs = 10_000, catchTimeoutMs = 1_000, processTimeoutMs = 30_000, bandColumns = 120, bandRows = 10 } = config
    assertPositive('hookTimeoutMs', hookTimeoutMs)
    assertPositive('catchTimeoutMs', catchTimeoutMs)
    assertPositive('processTimeoutMs', processTimeoutMs)
    assertPositive('bandColumns', bandColumns)
    assertPositive('bandRows', bandRows)
    const aliases = createToolNameAliases(config.toolAliases)
    const callOrigins = new Map<string, LoadedMod>()
    const modCommands = new Set<string>()
    const modTools = new Set<string>()
    const report = (line: string): void => { ctx.logger.warn(`claude-code-mods: ${line}`) }
    const agentOf = (sessionId: string): Agent | undefined => ctx.get('agents')?.get(SessionId(sessionId))
    const detached = new DetachedRuns(report)
    const surfaces = new SurfaceTable({
      columns: bandColumns,
      rows: bandRows,
      render: (sessionId, input) => {
        const agent = agentOf(sessionId)
        /* v8 ignore next -- agent/disposed forgets the band before the registry drops the agent; a redraw racing it draws nothing */
        if (agent === undefined) return Promise.resolve(null)
        return engine.raise<UiRenderInput, UiRenderResult>('ui.render', input, () => null, {
          binding: { agent }, signal: detached.controller.signal,
        })
      },
      runAction: async (_sessionId, callback) => {
        try {
          await callback()
        } catch (error: unknown) {
          report(`a button's onPress failed: ${messageOf(error)}`)
        }
      },
      report,
    })
    this.surfaces = surfaces
    // Deferred by one macrotask: a mod sets its own state right after the `$` call that triggers the redraw resolves.
    const redraw = (sessionId: string): void => {
      setTimeout(() => {
        if (agentOf(sessionId) !== undefined) void surfaces.refresh(sessionId)
      }, 0).unref()
    }
    const modSubmissions = new Map<string, string>()
    const ops = createHostOps({
      ctx, aliases, processTimeoutMs, registrations: this.registrations, callOrigins, modCommands, modTools, redraw,
      submitted: (messageId, mod) => { modSubmissions.set(messageId, mod) },
    })
    const engine: ModsEngine<AgentBinding> = new ModsEngine<AgentBinding>({
      ops: op => ops[op],
      stateKey: binding => binding.agent?.session.id ?? '',
      budgetMs: hookTimeoutMs,
      catchBudgetMs: catchTimeoutMs,
      report,
      onStateRead: (key, slot) => { surfaces.stateRead(key, slot) },
      onStateWritten: (key, slot) => { surfaces.stateWritten(key, slot) },
    })
    this.engine = engine
    const registrations = this.registrations
    ctx.effect(() => async () => {
      // Cancel first: a timer callback waiting inside a `$` call ends on this signal, and engine.dispose awaits it.
      detached.cancel()
      surfaces.dispose()
      for (const owned of registrations.values()) for (const dispose of owned) dispose()
      registrations.clear()
      await engine.dispose()
      await detached.drain()
    }, 'claude-code-mods: unload mods')

    // Read at each use: the registry may mount after this plugin in a composition.
    const isRoot = (agent: Agent): boolean => {
      const agents = ctx.get('agents')
      return agents === undefined || agents.roots().includes(agent)
    }
    /** Root agents that received `session.start`; the registry no longer lists an agent once it is disposed. */
    const startedRoots = new Set<string>()
    const agentIdOf = (agent: Agent | undefined): { agentId: string } | Record<never, never> =>
      agent !== undefined && !isRoot(agent) ? { agentId: agent.id } : {}

    /** Per-session fold of the open turn, keyed by session id. */
    const turns = new Map<string, TurnRecord>()
    /** Turns whose first pre-step already raised `turn.start`, by session id. */
    const startedTurns = new Map<string, Set<number>>()
    /** Rewritten tool results the post-execute listener installs as content. */
    const replacements = new Map<ToolExecutionToken, string>()

    ctx.on('agent/created', async ({ agent, signal }) => {
      if (!isRoot(agent)) return
      startedRoots.add(agent.session.id)
      // Cancelling creation also cancels directory validation and a waiting hook.
      /* v8 ignore next -- the loop always supplies an initialization signal; the payload type keeps it optional */
      const abandon = signal === undefined ? detached.controller.signal : AbortSignal.any([signal, detached.controller.signal])
      const input: SessionStartInput = {
        cwd: await ctx.workingDirectory.ensure(agent, abandon),
        surface: null,
        isInteractive: ctx.get('userQuestions') !== undefined,
      }
      await engine.raise<SessionStartInput, SessionStartResult>(
        'session.start', input, e => ({ cwd: e.cwd }), { binding: { agent }, signal: abandon },
      )
      redraw(agent.session.id)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = agent.session.id
      turns.delete(sessionId)
      startedTurns.delete(sessionId)
      // The agent's scoped registrations unwound with its context; only the bookkeeping remains.
      registrations.delete(sessionId)
      surfaces.forget(sessionId)
      const forget = (): Promise<void> => engine.forgetSession(sessionId)
      if (!startedRoots.delete(sessionId)) {
        detached.track('session cleanup', forget())
        return
      }
      const input: SessionEndInput = { reason: 'other', sessionId }
      // `$.state` stays readable and the session's timers keep running until the mods' `session.end` hooks have settled.
      detached.track('session.end', engine.raise<SessionEndInput, SessionEndResult>(
        'session.end', input, e => ({ sessionId: e.sessionId }), { binding: { agent }, signal: detached.controller.signal },
      ).then(forget, forget))
    })

    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
      const binding: AgentBinding = { agent }
      const started = startedTurns.get(agent.session.id) ?? new Set<number>()
      startedTurns.set(agent.session.id, started)
      const first = !started.has(turn)
      started.add(turn)
      const prompt = promptMessages(messages)
      const text = textOf(prompt.flatMap(message => message.content))
      let submitted: PromptSubmitResult = { text }
      // A batch of injected context alone is not a prompt: Claude Code raises prompt.submit for typed prompts.
      if (prompt.length > 0) {
        const submitter = prompt.map(message => modSubmissions.get(message.id)).find(name => name !== undefined)
        for (const message of prompt) modSubmissions.delete(message.id)
        const input: PromptSubmitInput = {
          text,
          wait: false,
          origin: submitter === undefined ? { kind: 'composer' } : { kind: 'plugin', name: submitter },
        }
        submitted = acceptPromptSubmit(await engine.raise<PromptSubmitInput, PromptSubmitResult>(
          'prompt.submit', input, e => ({ text: e.text, ...e.context === undefined ? {} : { context: e.context } }), { binding, signal },
        ), text)
        if (submitted.drop !== undefined) {
          ctx.logger.info(`claude-code-mods: prompt dropped: ${submitted.drop}`)
          return { kind: 'reject' }
        }
      }
      if (first) {
        const input: TurnStartInput = { text: submitted.text, turnId: String(turn), ...agentIdOf(agent) }
        await engine.raise<TurnStartInput, TurnStartResult>('turn.start', input, e => ({ turnId: e.turnId }), { binding, signal })
      }
      const downstream = await next()
      if (downstream.kind !== 'enter' || messages.length === 0) return downstream
      const context = submitted.context ?? []
      if (submitted.text === text && context.length === 0) return downstream
      // The rewritten text and the attached context replace the human's messages in place; every other message stays.
      let edited = submitted.text === text ? [...prompt] : rewritePromptText(prompt, submitted.text)
      if (context.length > 0) edited = appendContext(edited, context)
      const rewritten = new Map<UserMessage, UserMessage>()
      edited.forEach((message, index) => { rewritten.set(prompt[index] as UserMessage, message) })
      return { ...downstream, messages: downstream.messages.map(message => rewritten.get(message) ?? message) }
    })

    ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
      // A call a mod raised through `$.tool.call` reaches only the mods loaded before it, never itself.
      const raisedBy = callOrigins.get(exec.callId)
      const hooks = engine.registry.select('tool.call', raisedBy)
      if (hooks.length === 0) return next()
      const agent = exec.agent
      const callArguments = record(exec.arguments)
      const modName = aliases.toMod(exec.name)
      const input: ToolCallInput = { ...callArguments, tool: modName, tool_use_id: exec.callId, ...agentIdOf(agent) }
      const logged = JSON.stringify(callArguments)
      let beneath: ToolExecutionResult | undefined
      const answer = await engine.raiseWith<ToolCallInput, ToolCallResult>('tool.call', hooks, raisedBy, input, async () => {
        beneath = await next()
        return toolCallResultOf(beneath)
      }, {
        binding: { agent },
        signal: exec.signal,
        // The call is logged before policy runs, so the arguments a hook passes down must be the logged ones.
        validateNext: (e) => {
          const { tool, tool_use_id: _id, agentId: _agentId, ...rest } = e
          if (tool !== modName) {
            throw new RewriteRefusedError(`rerouted the call from ${modName} to ${tool}; the logged call runs the tool it named`)
          }
          if (JSON.stringify(rest) !== logged) {
            throw new RewriteRefusedError(`rewrote the arguments of ${modName}; argument rewrites need the pre-tool input rewrite mechanism (${REWRITE_NOTE})`)
          }
        },
      })
      if (agent !== undefined) redraw(agent.session.id)
      if (answer.deny !== undefined) return modAnswered(answer.deny, 'MOD_DENIED', `Error: ${answer.deny}`)
      const text = typeof answer.result === 'string' ? answer.result : stringify(answer.result) ?? ''
      if (beneath !== undefined) {
        const mapped = toolCallResultOf(beneath)
        if (mapped.result === answer.result && mapped.isError === answer.isError) return beneath
        // A success the hook marked as failed becomes a failure; a failure stays one, with the hook's text.
        if (answer.isError === true && !beneath.isError) return modAnswered(text, 'MOD_ANSWERED')
        replacements.set(exec.token, text)
        return beneath
      }
      if (answer.isError === true) return modAnswered(text, 'MOD_ANSWERED')
      if (modTools.has(exec.name)) return { isError: false, value: text, content: [{ type: 'text', text }] }
      // A built-in tool's success value must satisfy its own output schema: a
      // conforming answer is the tool's result, any other is error-shaped.
      const definition = ctx.get('tools')?.get(exec.name, agent === undefined ? undefined : scopeOf(agent.ctx))
      const value = jsonValueOf(answer.result)
      if (definition !== undefined && value !== undefined && validateJsonSchemaValue(definition.output.schema, value).length === 0) {
        return { isError: false, value, content: definition.output.render(exec.arguments, value) }
      }
      return modAnswered(text, 'MOD_ANSWERED')
    })

    // A call that never reaches post-execute (an earlier listener answered, or a pipeline failure) still clears its entry.
    ctx.on('tools/result', (exec) => { replacements.delete(exec.token) })

    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      const replacement = replacements.get(exec.token)
      if (replacement === undefined) return next()
      replacements.delete(exec.token)
      const downstream = await next()
      if (downstream.kind === 'block') return downstream
      return {
        kind: 'accept',
        content: [{ type: 'text', text: replacement }],
        ...downstream.additionalContexts === undefined ? {} : { additionalContexts: downstream.additionalContexts },
      }
    })

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        turns.set(session.id, { turn: event.data.turn, startedAt: Date.now(), answer: '', usage: undefined })
        return
      }
      if (event.type === 'assistant/message') {
        const turnRecord = turns.get(session.id)
        if (turnRecord !== undefined) foldAssistantMessage(turnRecord, event.data)
        return
      }
      if (event.type !== 'turn/end') return
      const { turn, reason } = event.data
      startedTurns.get(session.id)?.delete(turn)
      const agent = ctx.get('agents')?.get(session.id)
      if (agent === undefined) return
      const turnRecord = turns.get(session.id)
      const folded = turnRecord?.turn === turn ? turnRecord : undefined
      const input: TurnCompleteInput = {
        turnId: String(turn),
        answer: folded?.answer ?? '',
        durationMs: folded === undefined ? 0 : Date.now() - folded.startedAt,
        isAborted: reason.kind === 'aborted',
        reason: reason.kind === 'aborted' ? 'aborted' : reason.kind === 'error' ? 'error' : 'answer',
        ...agentIdOf(agent),
        ...folded?.usage === undefined ? {} : { usage: { ...folded.usage } },
      }
      if (folded !== undefined) turns.delete(session.id)
      detached.track('turn.complete', engine.raise<TurnCompleteInput, TurnCompleteResult>(
        'turn.complete', input, () => ({ text: '' }), { binding: { agent }, signal: detached.controller.signal },
      ).then((result) => {
        if (typeof result.text === 'string' && result.text.length > 0) ctx.logger.info(`claude-code-mods: ${result.text}`)
        redraw(session.id)
      }))
    })
  }

  /**
   * Watch the band above the prompt of one session: the current drawing, then
   * every redraw, until the Client stops watching.
   * @param agent - the session's agent, resolved by the Gateway.
   * @param signal - carrier cancellation.
   * @returns the band's snapshots.
   */
  @Remote({ mode: 'stream' })
  watchBand(agent: Agent, signal: AbortSignal): AsyncIterable<SurfaceSnapshot> {
    return this.surfaces.watch(agent.session.id, signal)
  }

  /**
   * Press a button of the band's current drawing: runs the mod's `onPress` and redraws.
   * @param agent - the session's agent, resolved by the Gateway.
   * @param generation - the drawing the Client saw.
   * @param actionId - the button's action id in that drawing.
   * @returns the snapshot after the press.
   */
  @Remote
  pressBand(agent: Agent, generation: number, actionId: string): Promise<SurfaceSnapshot> {
    return this.surfaces.press(agent.session.id, generation, actionId)
  }


  /**
   * Load one mod beneath every mod loaded before it: run its `register`,
   * keep its hooks, and report which of its events this host never raises.
   * @param definition - the mod as its plugin defined it.
   * @returns the disposer that removes the mod's hooks, closes its timers, and releases its registrations.
   * @throws Error when the name is invalid or taken, or when `register` throws (Claude Code's `hooks module did not load` wording).
   */
  async add(definition: ModDefinition): Promise<() => Promise<void>> {
    const mod = await this.engine.add(definition)
    const unserved = this.engine.registry.unserved(mod, SERVED_EVENTS)
    this.ctx.logger.info(`claude-code-mods: hooks module ${mod.name}@inline loaded (tier user); events: ${this.engine.describe(mod) || '(none)'}`)
    if (unserved.length > 0) {
      this.ctx.logger.warn(`claude-code-mods: ${mod.name}: on(${unserved.map(event => JSON.stringify(event)).join(', ')}) registered, but this host never raises ${unserved.length === 1 ? 'that event' : 'those events'}`)
    }
    return async () => {
      await this.engine.unload(mod.name)
    }
  }

  /** The loaded mods in chain order. */
  get mods(): readonly LoadedMod[] {
    return this.engine.registry.list()
  }
}

export default ClaudeCodeMods
