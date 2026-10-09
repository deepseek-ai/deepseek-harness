/**
 * The engine behavior for each mods API call this bridge serves, mapped onto
 * harness services: commands and tools on the agent's scoped registries,
 * `ui.ask` on the user-questions answerer, files on `ctx.fs`, processes on
 * `ctx.subprocess`, the store on a storage domain, session facts on the
 * agent's Session and projections. A service a deployment did not compose
 * fails the call with the service name.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: activate the `ctx.get('subprocess')` and `ctx.get('sessionProjections')` Context declarations.
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
// Type-only: merges the token-meter projection states into SessionProjectionStateMap.
import type {} from '@deepseek-ai/dsh-token-meter'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { record, requireString, stringify } from './values.ts'
import { z as zod } from 'zod'
import type { LoadedMod } from './chain.ts'
import type { ModsEngine, OpContext, OpTable } from './engine.ts'
import type { ToolNameAliases } from './tool-names.ts'
import type {
  CommandInfo, CommandRunInput, CommandRunResult, FsEntry, FsStat, HttpResponse, ProcessRunResult, SessionMessage,
  SessionUsage, SessionVersion, ToolCallResult, ToolInfo,
} from './types.ts'

/** The binding every event of this bridge carries: the agent it belongs to, when one does. */
export interface AgentBinding {
  readonly agent: Agent | undefined
}

/** The mods API version string `$.session.version()` reports. */
export const MODS_API_VERSION: SessionVersion = Object.freeze({ version: 'claude-code-mods/0.1', engine: 'deepseek-harness' })

/** Largest file `$.fs.read` returns and `$.fs.write` accepts, Claude Code's own limit. */
export const FS_MAX_BYTES = 4 * 1024 * 1024

/** Largest JSON a plugin's `$.store` holds in total, Claude Code's own limit. */
export const STORE_MAX_BYTES = 4 * 1024 * 1024

/** Largest stdout or stderr `$.process.run` keeps. */
const PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024

/** Largest response body `$.http.fetch` returns. */
export const HTTP_MAX_BYTES = 4 * 1024 * 1024

/**
 * Full name the model sees for a mod-registered tool: Claude Code's MCP-style spelling.
 * @param plugin - the registering plugin's name.
 * @param tool - the name the mod registered.
 * @returns `mcp__<plugin>__<tool>`.
 */
export function modToolName(plugin: string, tool: string): string {
  return `mcp__${plugin}__${tool}`
}

/** Tool-local names stay short and id-safe, Claude Code's own rule. */
const REGISTERED_NAME = /^[A-Za-z0-9_-]{1,64}$/u

/** Per-plugin `$.store` records: one JSON object of keys per plugin. */
const storeDomainSpec = defineDomain({
  name: 'claude_code_mods',
  version: 1,
  tables: { store: domainTable<string, Record<string, JsonValue>>(zod.record(zod.string(), zod.json())) },
})

/** Options the host op table is built from. */
export interface HostOpsOptions {
  readonly ctx: Context
  readonly aliases: ToolNameAliases
  /** Default `$.process.run` timeout in milliseconds. */
  readonly processTimeoutMs: number
  /**
   * Disposers of registrations mods made, keyed by the session they were scoped to
   * (`''` for global ones), so bridge disposal undoes them and a disposed agent's
   * entries can be dropped.
   */
  readonly registrations: Map<string, Set<() => void>>
  /** The mod that raised each in-flight `$.tool.call`, by call id, so the pipeline raises `tool.call` from it. */
  readonly callOrigins: Map<string, LoadedMod>
  /** Names of commands mods registered, for `$.command.list` sources. */
  readonly modCommands: Set<string>
  /** Full names of tools mods registered, whose calls a `tool.call` hook may answer with a successful result. */
  readonly modTools: Set<string>
  /** Redraw a session's band after a `$.ui` call that changes what it shows; absent when no surface is drawn. */
  readonly redraw?: (sessionId: string) => void
  /** Note a prompt a mod submitted, so the `prompt.submit` it raises carries the mod as its origin. */
  readonly submitted?: (messageId: string, mod: string) => void
}

function requireAgent(context: OpContext<AgentBinding>, op: string): Agent {
  const agent = context.binding.agent
  if (agent === undefined) throw new Error(`$.${op} needs a session, and this event has none`)
  return agent
}

function textOf(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
}

/**
 * Project one tool outcome onto Claude Code's `tool.call` result.
 * @param result - the harness tool outcome.
 * @returns its text as `result`, with `isError` on a failure.
 */
export function toolCallResultOf(result: ToolExecutionResult): ToolCallResult {
  return result.isError ? { result: textOf(result.content), isError: true } : { result: textOf(result.content) }
}

/** The model's raw JSON arguments as an object; an unparsable string is an empty input. */
function argumentsOf(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw))
  } catch {
    // A truncated or malformed tool call keeps its id and name; its input is unknown.
    return {}
  }
}

function sessionMessages(messages: readonly Message[], aliases: ToolNameAliases): SessionMessage[] {
  const out: SessionMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const toolUses = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
      .map(block => ({ tool_use_id: block.id, tool: aliases.toMod(block.name), input: argumentsOf(block.arguments) }))
    out.push({ role: message.role, text: textOf(message.content), toolUses })
  }
  return out
}

/** Entry kind in Claude Code's vocabulary. */
function kindOf(type: 'file' | 'directory' | 'symlink' | 'other'): FsEntry['kind'] {
  return type === 'file' ? 'file' : type === 'directory' ? 'dir' : 'other'
}

function readOutput(reader: { readFrom(fromByte: number): { text: string } } | undefined): string {
  /* v8 ignore next -- both streams are spawned collected, so their readers exist */
  return reader === undefined ? '' : reader.readFrom(0).text
}

/** An entry's size, or 0 where the provider reports none. */
function sizeOf(info: { size?: number } | undefined): number {
  return info?.size ?? 0
}

/**
 * Build the op table over the composed harness services.
 * @param options - the context, aliases, limits, and registration tracking.
 * @returns engine behaviors by event name.
 */
export function createHostOps(options: HostOpsOptions): OpTable<AgentBinding> {
  const { ctx, aliases } = options
  let storeDomain: Promise<Domain<typeof storeDomainSpec>> | undefined

  function store(): Promise<Domain<typeof storeDomainSpec>> {
    if (storeDomain !== undefined) return storeDomain
    const domains = ctx.get('storageDomain')
    if (domains === undefined) throw new Error('$.store needs a storage domain service (dsh-storage-domain), which this deployment did not compose')
    const opened = domains.open(storeDomainSpec)
    storeDomain = opened
    ctx.effect(() => () => opened.then(domain => domain.close()), 'claude-code-mods: close store domain')
    return opened
  }

  async function target(path: string, agent: Agent | undefined, signal: AbortSignal): Promise<FsTarget> {
    const cwd = await currentDirectory(agent, signal)
    return fs().resolve(path, { ...cwd === undefined ? {} : { cwd }, signal })
  }

  function directories(): WorkingDirectoryService {
    const service = ctx.get('workingDirectory')
    if (service === undefined) throw new Error('$.session.cwd and session-owned operations need dsh-working-directory, which this deployment did not compose')
    return service
  }

  function currentDirectory(agent: Agent | undefined, signal: AbortSignal): Promise<string | undefined> {
    return agent === undefined ? Promise.resolve(undefined) : directories().ensure(agent, signal)
  }

  function fs(): FileSystem {
    const service = ctx.get('fs')
    if (service === undefined) throw new Error('$.fs needs a filesystem service (dsh-fs), which this deployment did not compose')
    return service
  }

  function track(dispose: () => void, agent: Agent | undefined): void {
    const key = agent?.session.id ?? ''
    let owned = options.registrations.get(key)
    if (owned === undefined) {
      owned = new Set()
      options.registrations.set(key, owned)
    }
    owned.add(dispose)
  }

  /** Per-plugin write chains: `$.store` read-modify-write runs one at a time per plugin. */
  const storeWrites = new Map<string, Promise<void>>()

  function serializeStore(plugin: string, write: () => Promise<void>): Promise<void> {
    const previous = storeWrites.get(plugin) ?? Promise.resolve()
    const next = previous.then(write, write)
    storeWrites.set(plugin, next.catch(() => undefined))
    return next
  }

  /** Ask the band of the event's session to redraw, when a surface is drawn at all. */
  function redraw(agent: Agent | undefined): void {
    if (agent !== undefined) options.redraw?.(agent.session.id)
  }

  /** One projection's state, or undefined when the registry or the projection's owning plugin is not composed. */
  function projection<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined {
    return ctx.get('sessionProjections')?.stateOf(session, key)
  }

  return {
    // ---- ui: no mod drawing surface exists; log-style calls reach the host log ----
    'ui.log': (input, { mod }) => {
      const { text, to } = record(input)
      const line = `${mod.name}: ${requireString(text, '$.ui.log text')}`
      if (to === 'debug') ctx.logger.debug(line)
      else ctx.logger.info(line)
    },
    'ui.toast': (input, { mod }) => { ctx.logger.info(`${mod.name} (toast): ${requireString(record(input).text, '$.ui.toast text')}`) },
    'ui.status': (input, { mod }) => {
      const { text } = record(input)
      ctx.logger.info(`${mod.name} (status): ${text === undefined ? '(cleared)' : requireString(text, '$.ui.status text')}`)
    },
    'ui.invalidate': (_input, { binding }) => { redraw(binding.agent) },
    // No pane is placed: a mod that degrades to the band (`isPlaced: false`) is drawn there after this call.
    'ui.open': (input, { binding }) => {
      redraw(binding.agent)
      return { id: requireString(record(input).id, '$.ui.open id'), isPlaced: false, reason: 'this host places no panes; draw in AbovePrompt' }
    },
    'ui.close': (_input, { binding }) => { redraw(binding.agent) },
    'ui.panes': () => [],
    'ui.ask': async (input, context) => {
      const agent = requireAgent(context, 'ui.ask')
      const questions = ctx.get('userQuestions')
      if (questions === undefined) throw new Error('$.ui.ask needs a user-questions service (dsh-user-questions), which this deployment did not compose')
      const { question, options: labels, header, multiSelect } = record(input)
      const choices: AskUserQuestionOption[] | undefined = Array.isArray(labels)
        ? labels.map(label => ({ label: requireString(label, '$.ui.ask option') }))
        : undefined
      const answer = await questions.ask({
        questions: [{
          id: 'answer',
          question: requireString(question, '$.ui.ask question'),
          ...typeof header === 'string' ? { header } : {},
          ...choices === undefined ? {} : { options: choices },
          ...multiSelect === true ? { multiSelect: true } : {},
        }],
        agent,
        signal: context.signal,
      })
      const item = answer.answers[0]
      if (item === undefined) throw new Error('$.ui.ask: the user dismissed the question')
      return item.custom ?? item.selected.join(', ')
    },

    // ---- commands ----
    'command.register': (input, { mod, binding, engine }) => {
      const spec = record(input)
      const name = requireString(spec.name, '$.command.register name')
      if (!REGISTERED_NAME.test(name)) throw new Error(`"/${name}" refused: command names are letters, digits, "_" and "-", up to 64 characters`)
      const description = requireString(spec.description, '$.command.register description')
      const registry = (binding.agent?.ctx ?? ctx).get('commands')
      if (registry === undefined) throw new Error('$.command.register needs a command registry (dsh-commands), which this deployment did not compose')
      const lowered = name.toLowerCase()
      const definition: CommandDefinition = {
        name: lowered,
        description,
        ...typeof spec.argumentHint === 'string' ? { input: { hint: spec.argumentHint } } : {},
        handler: async (invocation) => {
          const run = await engine.raise<CommandRunInput, CommandRunResult>(
            'command.run',
            { command: lowered, args: invocation.rawInput.trim(), origin: { kind: 'composer' } },
            () => ({ text: `${mod.name} registered /${lowered} but no command.run hook answered it; add on('command.run', { command: '${lowered}' }, hook)` }),
            { binding: { agent: invocation.agent }, signal: invocation.signal },
          )
          return { kind: 'success', ...run.text === undefined ? {} : { text: `${mod.name}: ${run.text}` } }
        },
      }
      const dispose = registry.register(definition)
      options.modCommands.add(lowered)
      track(dispose, binding.agent)
    },
    'command.run': async (input, context) => {
      const agent = requireAgent(context, 'command.run')
      const registry = ctx.get('commands')
      if (registry === undefined) throw new Error('$.command.run needs a command registry (dsh-commands), which this deployment did not compose')
      const { command, args } = record(input)
      const name = requireString(command, '$.command.run command')
      const line = typeof args === 'string' && args.length > 0 ? `/${name} ${args}` : `/${name}`
      const execution = await registry.execute(agent, line, [], context.signal)
      if (execution === undefined) throw new Error(`/${name} is not a command`)
      const { result } = execution
      if (result.kind === 'error') throw new Error(result.text)
      return { ...result.text === undefined ? {} : { text: result.text } } satisfies CommandRunResult
    },
    'command.list': (_input, context) => {
      const agent = requireAgent(context, 'command.list')
      const registry = ctx.get('commands')
      if (registry === undefined) return []
      return registry.list(agent).map((descriptor): CommandInfo => ({
        name: descriptor.name,
        description: descriptor.description,
        source: options.modCommands.has(descriptor.name) ? 'plugin' : 'builtin',
      }))
    },

    // ---- tools ----
    'tool.register': (input, { mod, binding }) => {
      const spec = record(input)
      const name = requireString(spec.name, '$.tool.register name')
      if (!REGISTERED_NAME.test(name)) throw new Error(`tool "${name}" refused: tool names are letters, digits, "_" and "-", up to 64 characters`)
      const description = requireString(spec.description, '$.tool.register description')
      const inputSchema = spec.inputSchema === undefined ? { type: 'object', properties: {} } : record(spec.inputSchema)
      // The schema reaches the model, so an unsupported keyword fails this call, not a later request.
      assertObjectJsonSchema(inputSchema)
      const registry = (binding.agent?.ctx ?? ctx).get('tools')
      if (registry === undefined) throw new Error('$.tool.register needs a tool registry (dsh-tools), which this deployment did not compose')
      const fullName = modToolName(mod.name, name)
      const definition: ToolDefinition = {
        name: fullName,
        description,
        parameters: inputSchema,
        output: {
          // The answering hook's result text; the schema admits only a string.
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value as string }],
        },
        execute() {
          return Promise.reject(new Error(`${mod.name} registered ${fullName} but no tool.call hook answered it; add on('tool.call', { tool: '${fullName}' }, hook)`))
        },
      }
      track(registry.register(definition), binding.agent)
      options.modTools.add(fullName)
    },
    'tool.call': async (input, context) => {
      const agent = context.binding.agent
      const registry = ctx.get('tools')
      if (registry === undefined) throw new Error('$.tool.call needs a tool registry (dsh-tools), which this deployment did not compose')
      const { tool, tool_use_id: _ignored, agentId: _agent, ...args } = record(input)
      const callId = ToolCallId(`mod-${randomUUID()}`)
      // The pipeline raises `tool.call` for this call from the calling mod, so only earlier mods see it.
      options.callOrigins.set(callId, context.mod)
      try {
        const result = await registry.execute({
          callId,
          name: aliases.toHarness(requireString(tool, '$.tool.call tool')),
          arguments: args,
          ...agent === undefined ? {} : { agent },
          signal: context.signal,
        })
        // Guidance a tool defers to the next request still reaches the model when a mod made the call.
        if (agent !== undefined) for (const context of result.additionalContexts ?? []) agent.inject(context)
        return toolCallResultOf(result)
      } finally {
        options.callOrigins.delete(callId)
      }
    },
    'tool.list': (_input, context) => {
      const registry = ctx.get('tools')
      if (registry === undefined) return []
      const agent = context.binding.agent
      return registry.schemas(agent === undefined ? undefined : scopeOf(agent.ctx))
        .map((schema): ToolInfo => ({ name: aliases.toMod(schema.name), description: schema.description }))
    },

    // ---- prompt ----
    'prompt.submit': (input, context) => {
      const agent = requireAgent(context, 'prompt.submit')
      const { text, asUser } = record(input)
      const body = requireString(text, '$.prompt.submit text')
      const framed = asUser === true ? body : `Message from the "${context.mod.name}" mod:\n${body}`
      // Claude Code submits the prompt as the user's own; the framing names the mod unless `asUser` is set.
      const message = createUserMessage({ content: [{ type: 'text', text: framed }], source: { kind: 'user' } })
      options.submitted?.(message.id, context.mod.name)
      agent.followup(message)
      return { text: framed }
    },

    // ---- session facts ----
    'session.id': (_input, context) => requireAgent(context, 'session.id').session.id,
    'session.cwd': (_input, context) => {
      const agent = requireAgent(context, 'session.cwd')
      return directories().get(agent.session)
    },
    'session.root': (_input, context) => requireAgent(context, 'session.root').session.header.cwd ?? process.cwd(),
    'session.model': (_input, context) => {
      const agent = requireAgent(context, 'session.model')
      return agent.session.requestHeader()?.config.model ?? agent.options.model ?? ''
    },
    'session.turns': (_input, context) => {
      const agent = requireAgent(context, 'session.turns')
      const boundary = projection(agent.session, 'turnBoundary')
      if (boundary === undefined) throw new Error('$.session.turns needs the turnBoundary projection, which this deployment did not compose')
      return boundary.lastTurn
    },
    'session.messages': (_input, context) => sessionMessages(requireAgent(context, 'session.messages').session.deriveMessages(), aliases),
    'session.usage': (_input, context): SessionUsage => {
      const agent = requireAgent(context, 'session.usage')
      const pressure = projection(agent.session, 'contextPressure')
      const tokens = pressure?.pressureTokens
      const window = pressure?.contextWindow ?? 0
      return {
        startedAt: agent.session.header.createdAt,
        context: {
          ...tokens === undefined ? {} : { tokens },
          window,
          ...tokens === undefined || window === 0 ? {} : { percent: Math.round((tokens / window) * 100) },
        },
        rateLimits: [],
      }
    },
    'session.version': () => MODS_API_VERSION,

    // ---- store: one durable JSON object per plugin ----
    'store.get': async (input, { mod }) => (await store()).table('store').get(mod.name)?.[requireString(record(input).key, '$.store.get key')],
    'store.set': async (input, { mod }) => {
      const { key, value } = record(input)
      const name = requireString(key, '$.store.set key')
      await serializeStore(mod.name, async () => {
        const table = (await store()).table('store')
        const next = { ...table.get(mod.name), [name]: value as JsonValue }
        const encoded = stringify(next)
        if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > STORE_MAX_BYTES) {
          throw new Error(`$.store.set: ${mod.name}'s store would exceed ${STORE_MAX_BYTES} bytes of JSON`)
        }
        await table.put(mod.name, JSON.parse(encoded) as Record<string, JsonValue>)
      })
    },
    'store.delete': async (input, { mod }) => {
      const name = requireString(record(input).key, '$.store.delete key')
      await serializeStore(mod.name, async () => {
        const table = (await store()).table('store')
        const current = table.get(mod.name)
        if (current === undefined || !(name in current)) return
        const { [name]: _removed, ...rest } = current
        await table.put(mod.name, rest)
      })
    },
    'store.keys': async (_input, { mod }) => Object.keys((await store()).table('store').get(mod.name) ?? {}),

    // ---- files: through the filesystem seam, relative to the session workspace ----
    'fs.read': async (input, context) => {
      const path = requireString(record(input).path, '$.fs.read path')
      const resolved = await target(path, context.binding.agent, context.signal)
      const info = await fs().stat(resolved, context.signal)
      if (info?.size !== undefined && info.size > FS_MAX_BYTES) throw new Error(`$.fs.read: ${path} is larger than ${FS_MAX_BYTES} bytes`)
      return fs().readText(resolved, context.signal)
    },
    'fs.write': async (input, context) => {
      const { path, text } = record(input)
      const body = requireString(text, '$.fs.write text')
      if (Buffer.byteLength(body, 'utf8') > FS_MAX_BYTES) throw new Error(`$.fs.write: content is larger than ${FS_MAX_BYTES} bytes`)
      const resolved = await target(requireString(path, '$.fs.write path'), context.binding.agent, context.signal)
      await fs().writeText(resolved, body, undefined, context.signal)
    },
    'fs.list': async (input, context) => {
      const resolved = await target(requireString(record(input).path, '$.fs.list path'), context.binding.agent, context.signal)
      const entries = await fs().listDir(resolved, context.signal)
      return entries.map((entry): FsEntry => ({ name: entry.name, kind: kindOf(entry.type), size: sizeOf(entry), isLink: false }))
    },
    'fs.exists': async (input, context) => {
      const resolved = await target(requireString(record(input).path, '$.fs.exists path'), context.binding.agent, context.signal)
      return await fs().stat(resolved, context.signal) !== undefined
    },
    'fs.stat': async (input, context) => {
      const path = requireString(record(input).path, '$.fs.stat path')
      const cwd = await currentDirectory(context.binding.agent, context.signal)
      const info = await fs().lstat(path, cwd === undefined ? {} : { cwd }, context.signal)
      if (info === undefined) throw new Error(`$.fs.stat: ${path} does not exist`)
      if (info.type !== 'symlink') return { kind: kindOf(info.type), size: sizeOf(info), mtimeMs: 0, isLink: false } satisfies FsStat
      // A link reports what it points at, as Claude Code's `resolve: true` does; a dangling one is `other`.
      const resolved = await fs().resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: context.signal })
      const followed = await fs().stat(resolved, context.signal)
      return { kind: kindOf(followed?.type ?? 'other'), size: sizeOf(followed), mtimeMs: 0, isLink: true } satisfies FsStat
    },

    // ---- processes: argv, no shell, collected output ----
    'process.run': async (input, context) => {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) throw new Error('$.process.run needs a subprocess service (dsh-subprocess), which this deployment did not compose')
      const { argv, init } = record(input)
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every(item => typeof item === 'string')) {
        throw new TypeError('$.process.run needs a non-empty argv list of strings')
      }
      const settings = record(init)
      const timeoutMs = typeof settings.timeoutMs === 'number' ? settings.timeoutMs : options.processTimeoutMs
      const cwd = typeof settings.cwd === 'string' ? settings.cwd : await currentDirectory(context.binding.agent, context.signal) ?? process.cwd()
      const env = typeof settings.env === 'object' && settings.env !== null ? settings.env as Record<string, string> : undefined
      const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
      const handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: PROCESS_OUTPUT_MAX_BYTES }, stderr: { maxBytes: PROCESS_OUTPUT_MAX_BYTES } },
        graceMs: 1000,
        signal: deadline,
        ...env === undefined ? {} : { env },
      })
      const outcome = await handle.done
      if (deadline.aborted) throw new Error(`$.process.run: ${argv[0]} did not exit within ${timeoutMs} ms`)
      /* v8 ignore next -- a Windows child reports an exit code even when terminated; POSIX coverage owns this branch */
      if (outcome.exitCode === null) throw new Error(`$.process.run: ${argv[0]} was terminated by signal ${String(outcome.signal)}`)
      return {
        exitCode: outcome.exitCode,
        stdout: readOutput(handle.collected.stdout),
        stderr: readOutput(handle.collected.stderr),
      } satisfies ProcessRunResult
    },

    // ---- network ----
    'http.fetch': async (input, context) => {
      const { url, init } = record(input)
      const settings = record(init)
      const timeoutMs = typeof settings.timeoutMs === 'number' ? settings.timeoutMs : options.processTimeoutMs
      const response = await fetch(requireString(url, '$.http.fetch url'), {
        ...typeof settings.method === 'string' ? { method: settings.method } : {},
        ...typeof settings.headers === 'object' && settings.headers !== null ? { headers: settings.headers as Record<string, string> } : {},
        ...typeof settings.body === 'string' ? { body: settings.body } : {},
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        headers[name] = value
      })
      const body = await readBounded(response, HTTP_MAX_BYTES)
      return { status: response.status, ok: response.ok, headers, text: body } satisfies HttpResponse
    },

    // ---- environment of this process ----
    'env.get': input => process.env[requireString(record(input).name, '$.env.get name')],
    'env.set': (input) => {
      const { name, value } = record(input)
      const key = requireString(name, '$.env.set name')
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = requireString(value, '$.env.set value')
    },
  }
}

export type { ModsEngine }

/** Read a response body up to the bound, cancelling the stream at the first byte past it. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`$.http.fetch: the response body is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
