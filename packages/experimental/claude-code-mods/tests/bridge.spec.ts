import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { createAssistantMessage, createUserMessage, ToolCallId as ToolCallIdOf } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ClaudeCodeMods, { defineMod, MODS_API_VERSION, type Config, type ModPlugin, type ModRegister } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop bridge tests: a scripted mock MODEL drives the REAL agent loop,
 * tool registry, command registry, filesystem, subprocess, user-questions and
 * storage services, and the REAL bridge loads REAL mod directories — only the
 * model is mocked. Each test asserts the mod's effect on the loop or the
 * services, not on the bridge's internals.
 */

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
const dirs: string[] = []
const fibers: Fiber[] = []
afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'dsh-cc-mods-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

let loads = 0

/** Import a hooks module afresh, as a Claude Code reload evaluates it: module-level variables start over. */
async function importRegister(path: string): Promise<ModRegister> {
  loads += 1
  const namespace: unknown = await import(`${pathToFileURL(path).href}?load=${loads}`)
  const register = (namespace as { register?: unknown }).register
  if (typeof register !== 'function') throw new Error(`${path} does not export register`)
  return register as ModRegister
}

/** Write an inline hooks module and wrap it as a mod plugin. */
async function writeMod(name: string, body: string, userConfig?: Record<string, string>): Promise<ModPlugin> {
  const path = join(scratch(), `${name}.mjs`)
  writeFileSync(path, body)
  return defineMod({ name, version: '0.0.1', ...userConfig === undefined ? {} : { userConfig }, register: await importRegister(path) })
}

/** A fixture mod under `tests/fixtures/<name>.mjs`, wrapped as a plugin with the fixture's `userConfig`. */
async function fixtureMod(name: string): Promise<ModPlugin> {
  const userConfig = name === 'first-mod' ? { greeting: 'Claude has made' } : undefined
  return defineMod({ name, version: '0.1.0', ...userConfig === undefined ? {} : { userConfig }, register: await importRegister(join(FIXTURES, `${name}.mjs`)) })
}

interface HarnessOptions {
  readonly config?: Partial<Config>
  /** Config per mod plugin, by name: the `options` its `register` receives. */
  readonly modConfig?: Record<string, Record<string, string | number | boolean | string[]>>
  readonly services?: (ctx: Context, workspace: string) => Promise<void>
  readonly tools?: { mode?: 'native' | 'ptc' }
}

interface Harness {
  readonly ctx: Context
  readonly adapter: MockAdapter
  readonly workspace: string
  readonly mods: Fiber
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  agent(id?: string): Promise<Agent>
  turn(agent: Agent, text: string): Promise<void>
}

async function harness(
  modsToLoad: readonly (string | ModPlugin | Promise<ModPlugin>)[],
  adapter: MockAdapter,
  options: HarnessOptions = {},
): Promise<Harness> {
  const ctx = new Context()
  fibers.push(ctx.fiber)
  const info = vi.fn()
  const warn = vi.fn()
  ctx.logger.info = info as never
  ctx.logger.warn = warn as never
  await mountAgentLoopTestDependencies(ctx, { tools: options.tools ?? {} })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  const workspace = scratch('dsh-cc-mods-ws-')
  await options.services?.(ctx, workspace)
  if (ctx.get('fs') === undefined) await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace })
  const mods = await ctx.plugin(ClaudeCodeMods, { ...options.config })
  await mods.await()
  for (const entry of modsToLoad) {
    const plugin = typeof entry === 'string' ? await fixtureMod(entry) : await entry
    const fiber = await ctx.plugin(plugin, options.modConfig?.[plugin.definition.name] ?? {})
    await fiber.await()
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  return {
    ctx, adapter, workspace, mods, info, warn,
    agent: id => ctx.agentLoop.create(SessionId(id ?? 'a1'), { provider: 'mock', model: 'mock' }, { cwd: workspace }),
    async turn(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
  }
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

function toolResult(agent: Agent): { isError: boolean; text: string } | undefined {
  const event = events(agent).find(e => e.type === 'tool/result')
  if (event?.type !== 'tool/result') return undefined
  const { message } = event.data
  return { isError: message.isError === true, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') }
}

/** A mock model whose route advertises a context window, so the token meter can report pressure against it. */
class WindowedAdapter extends MockAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(provider, model), context: { contextWindow: 1000 } }
  }
}

function echoTool(name: string, ran: string[] = []) {
  return defineContentToolFixture({
    name, description: 'echoes its command', parameters: { command: { type: 'string' } },
    async execute(args) {
      ran.push(String(args.command))
      return [{ type: 'text', text: `ran ${String(args.command)}` }]
    },
  })
}

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('first-mod: the tutorial mod on the real loop', () => {
  it('registers /tally at session start, counts the turn\'s tool calls, prints the count without a model turn, and unregisters on dispose', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { command: 'ls' }), textResponse('done')])
    const h = await harness(['first-mod'], adapter)
    h.ctx.tools.register(echoTool('echo'))
    const agent = await h.agent()
    expect(h.ctx.commands.list(agent).map(command => command.name)).toEqual(['tally'])
    expect(h.info).toHaveBeenCalledWith(
      'claude-code-mods: hooks module first-mod@inline loaded (tier user); '
      + 'events: session.start, tool.call, command.run{command=tally}, ui.render{component=Spinner}',
    )

    await h.turn(agent, 'list the files here')
    expect(adapter.requests).toHaveLength(2)
    const run = await h.ctx.commands.execute(agent, '/tally', [], new AbortController().signal)
    expect(run?.result).toEqual({ kind: 'success', text: 'first-mod: Claude has made 1 tool calls since this mod loaded' })
    expect(events(agent).filter(e => e.type === 'command/run' || e.type === 'command/done').map(e => e.type)).toEqual(['command/run', 'command/done'])

    // The command is scoped to the agent that started the session, not global.
    const other = await h.agent('a2')
    expect(h.ctx.commands.list(other).map(command => command.name)).toEqual(['tally'])

    await h.mods.dispose()
    expect(h.ctx.commands.list(agent)).toEqual([])
    expect(h.ctx.commands.list(other)).toEqual([])
  })
})

describe('guard-mod: tool.call deny, observe-after, and fail-closed .catch', () => {
  it('refuses a risky Bash command before the tool body runs, with the reason as the model-visible error', async () => {
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'git push --force' }), textResponse('ok')])
    const h = await harness(['guard-mod'], adapter)
    h.ctx.tools.register(echoTool('bash', ran))
    const agent = await h.agent()
    await h.turn(agent, 'force push')
    expect(ran).toEqual([])
    expect(toolResult(agent)).toEqual({ isError: true, text: 'Error: guard-mod refused this command: git push --force' })
  })

  it('lets a safe command through, observes the result, and reaches the host log through $.ui.log', async () => {
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'ls' }), textResponse('ok')])
    const h = await harness(['guard-mod'], adapter)
    h.ctx.tools.register(echoTool('bash', ran))
    const agent = await h.agent()
    await h.turn(agent, 'list')
    expect(ran).toEqual(['ls'])
    expect(toolResult(agent)).toEqual({ isError: false, text: 'ran ls' })
    await waitFor(() => h.info.mock.calls.some(call => call[0] === 'guard-mod: ran Bash: ls'))
  })

  it('fails closed through .catch when the guard throws', async () => {
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'explode' }), textResponse('ok')])
    const h = await harness(['guard-mod'], adapter)
    h.ctx.tools.register(echoTool('bash', ran))
    const agent = await h.agent()
    await h.turn(agent, 'boom')
    expect(ran).toEqual([])
    expect(toolResult(agent)).toEqual({ isError: true, text: 'Error: The command guard failed, so this command was not run: throw' })
    expect(h.warn).toHaveBeenCalledWith('claude-code-mods: guard-mod: tool.call hook skipped: threw Error: guard exploded')
  })
})

describe('ticket-mod: a mod-registered tool, prompt context, and a turn.complete line', () => {
  it('offers mcp__ticket-mod__ticket to the model and answers its calls with a successful result', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'mcp__ticket-mod__ticket', { id: 'T-1' }), textResponse('ok')])
    const h = await harness(['ticket-mod'], adapter)
    const agent = await h.agent()
    const schema = h.ctx.tools.schemas(scopeOf(agent.ctx)).find(tool => tool.name === 'mcp__ticket-mod__ticket')
    expect(schema).toMatchObject({ description: 'Look up a ticket by its id and return its title and status', parameters: { type: 'object', required: ['id'] } })
    await h.turn(agent, 'what is T-1 about?')
    expect(toolResult(agent)).toEqual({ isError: false, text: 'Login button does nothing (open)' })
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('mcp__ticket-mod__ticket')
    await waitFor(() => h.info.mock.calls.some(call => call[0] === 'claude-code-mods: Done in some ms'))
  })

  it('appends prompt.submit context as blocks after the prompt as typed, inside the user\'s own message', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const h = await harness(['ticket-mod'], adapter)
    const agent = await h.agent()
    await h.turn(agent, 'open a PR for this change')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Current branch: feature/mods')
    const prompts = events(agent).filter(e => e.type === 'user/message' && e.data.source.kind === 'user')
    expect(prompts.map(e => e.type === 'user/message' && e.data.source)).toEqual([{ kind: 'user' }])
    expect(prompts[0]?.type === 'user/message' && prompts[0].data.content).toEqual([
      { type: 'text', text: 'open a PR for this change' },
      { type: 'text', text: 'Current branch: feature/mods' },
    ])
    expect(toolResult(agent)).toBeUndefined()
  })
})

describe('prompt.submit: rewrite and drop', () => {
  it('rewrites the prompt text the model sees and drops a prompt with a reason', async () => {
    const mod = writeMod('prompt-mod', `
      const origins = []
      let submitted = false
      export function register(on) {
        on('session.start', async ($, e, next) => { await $.command.register({ name: 'origins', description: 'origins seen' }); return next(e) })
        on('command.run', { command: 'origins' }, async ($) => {
          if (!submitted) {
            submitted = true
            await $.prompt.submit({ text: 'from the mod' })
          }
          return { text: JSON.stringify(origins) }
        })
        on('prompt.submit', async ($, e, next) => {
          origins.push(e.origin)
          if (e.text.includes('secret')) return { drop: 'secrets stay out' }
          if (e.text.includes('junk')) return { text: 7, context: ['kept context', 5] }
          if (e.text.includes('reach')) {
            // Members this host does not serve reject by name instead of being undefined.
            const gaps = []
            await $.model.complete({ messages: [] }).catch(error => gaps.push(error.message))
            await $.fs.ancestors('x').catch(error => gaps.push(error.message))
            await $.ui.notice('x').catch(error => gaps.push(error.message))
            return next({ ...e, context: gaps })
          }
          return next({ ...e, text: e.text.trim().toUpperCase() })
        })
      }
    `)
    const adapter = new MockAdapter([textResponse('ok'), textResponse('junk ok'), textResponse('reached'), textResponse('mod prompt ok')])
    const h = await harness([mod], adapter)
    const agent = await h.agent()
    // Injected context alone is not a prompt: no prompt.submit is raised for it.
    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'injected only' }], source: { kind: 'user-question-reply', callId: ToolCallIdOf('q0'), outcome: 'answered' } }))
    await h.turn(agent, '  hello there  ')
    const entered = events(agent).find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    expect(entered?.type === 'user/message' && entered.data.content).toEqual([{ type: 'text', text: 'HELLO THERE' }])
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('HELLO THERE')

    await h.turn(agent, 'tell me the secret')
    expect(adapter.requests).toHaveLength(1)
    const turns = events(agent).filter(e => e.type === 'turn/end').map(e => e.type === 'turn/end' && e.data.reason.kind)
    expect(turns).toEqual(['completed', 'blocked'])
    expect(h.info).toHaveBeenCalledWith('claude-code-mods: prompt dropped: secrets stay out')

    // A result with the wrong types keeps the original text and only the string context lines.
    await h.turn(agent, 'some junk')
    const last = adapter.requests[1]?.messages.filter(message => message.role === 'user') ?? []
    expect(last.at(-1)?.content).toEqual([{ type: 'text', text: 'some junk' }, { type: 'text', text: 'kept context' }])

    await h.turn(agent, 'reach past the host')
    const reached = adapter.requests[2]?.messages.filter(message => message.role === 'user') ?? []
    expect(reached.at(-1)?.content).toEqual([
      { type: 'text', text: 'reach past the host' },
      { type: 'text', text: 'prompt-mod: no implementation for model.complete' },
      { type: 'text', text: 'prompt-mod: no implementation for fs.ancestors' },
      { type: 'text', text: 'prompt-mod: no implementation for ui.notice' },
    ])

    // A prompt the mod submitted reaches prompt.submit with the mod as its origin; typed prompts are the composer's.
    const signal = new AbortController().signal
    await h.ctx.commands.execute(agent, '/origins', [], signal)
    await agent.whenIdle()
    const origins = await h.ctx.commands.execute(agent, '/origins', [], signal)
    expect(JSON.parse(String(origins?.result.text).replace(/^prompt-mod: /u, ''))).toEqual([
      { kind: 'composer' }, { kind: 'composer' }, { kind: 'composer' }, { kind: 'composer' }, { kind: 'plugin', name: 'prompt-mod' },
    ])
  })
})

describe('tool.call: answers and rewrites', () => {
  it('answers a built-in tool by its output schema, keeps a rewritten result through post-execute, and skips a hook that rewrote arguments', async () => {
    const mod = writeMod('answer-mod', `
      export function register(on) {
        on('tool.call', { tool: 'greet' }, async ($, e) => ({ result: 'hello from answer-mod' }))
        on('tool.call', { tool: 'echo' }, async ($, e, next) => {
          if (e.command === 'skip') return { result: 'Skipped by answer-mod' }
          if (e.command === 'greet') return { result: 'hello from answer-mod' }
          if (e.command === 'redact') {
            const r = await next({ ...e, command: 'rewritten' })
            return { ...r, result: String(r.result).replace('ran', 'RAN') }
          }
          if (e.command === 'fail') {
            const r = await next(e)
            return { ...r, result: 'marked failed', isError: true }
          }
          if (e.command === 'tweak') {
            const r = await next(e)
            return { ...r, result: 'tweaked' }
          }
          if (e.command === 'empty') return {}
          if (e.command === 'error') return { result: 'refused outright', isError: true }
          return next(e)
        })
      }
    `)
    // A second mod, so its first skip report is the reroute (a hook's reports are one per failure kind).
    const rerouter = writeMod('reroute-mod', `
      export function register(on) {
        on('tool.call', { tool: 'echo' }, ($, e, next) => e.command === 'reroute' ? next({ ...e, tool: 'Read', file_path: 'x' }) : next(e))
      }
    `)
    const ran: string[] = []
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'skip' }), textResponse('one'),
      toolCallResponse('c5', 'greet', {}), textResponse('hi'),
      toolCallResponse('c2', 'echo', { command: 'redact' }), textResponse('two'),
      toolCallResponse('c3', 'echo', { command: 'redact' }), textResponse('three'),
      toolCallResponse('c4', 'echo', { command: 'fail' }), textResponse('four'),
      toolCallResponse('c6', 'echo', { command: 'tweak' }), textResponse('five'),
      toolCallResponse('c7', 'echo', { command: 'empty' }), textResponse('six'),
      toolCallResponse('c8', 'echo', { command: 'error' }), textResponse('seven'),
      toolCallResponse('c9', 'echo', { command: 'reroute' }), textResponse('eight'),
    ])
    const h = await harness([mod, rerouter], adapter)
    h.ctx.tools.register(echoTool('echo', ran))
    // A tool whose output schema admits a string: a mod's string answer is its ordinary result.
    h.ctx.tools.register({
      name: 'greet', description: 'greets', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: `rendered ${value as string}` }] },
      execute: () => Promise.resolve('never runs'),
    })
    const agent = await h.agent()
    await h.turn(agent, 'skip it')
    expect(ran).toEqual([])
    // The echo fixture's output schema does not admit a bare string, so the answer is error-shaped.
    expect(toolResult(agent)).toEqual({ isError: true, text: 'Skipped by answer-mod' })
    const first = events(agent).find(e => e.type === 'tool/result')
    expect(first?.type === 'tool/result' && JSON.stringify(first.data)).toContain('MOD_ANSWERED')

    await h.turn(agent, 'greet')
    await h.turn(agent, 'redact it')
    await h.turn(agent, 'redact again')
    await h.turn(agent, 'fail it')
    await h.turn(agent, 'tweak it')
    await h.turn(agent, 'empty answer')
    await h.turn(agent, 'error answer')
    await h.turn(agent, 'reroute it')
    // The rewrite is refused: the hook is skipped once per kind and the call runs with its logged arguments.
    expect(ran).toEqual(['redact', 'redact', 'fail', 'tweak', 'reroute'])
    const results = events(agent).filter(e => e.type === 'tool/result')
      .map(e => e.type === 'tool/result' && [e.data.message.isError === true, e.data.message.content[0]])
    expect(results.slice(1)).toEqual([
      [false, { type: 'text', text: 'rendered hello from answer-mod' }],
      [false, { type: 'text', text: 'ran redact' }],
      [false, { type: 'text', text: 'ran redact' }],
      [true, { type: 'text', text: 'marked failed' }],
      [false, { type: 'text', text: 'tweaked' }],
      [true, { type: 'text', text: '' }],
      [true, { type: 'text', text: 'refused outright' }],
      [false, { type: 'text', text: 'ran reroute' }],
    ])
    expect(h.warn).toHaveBeenCalledWith(
      'claude-code-mods: reroute-mod: tool.call hook skipped: rerouted the call from echo to Read; the logged call runs the tool it named',
    )
    // A call without an agent (a host-side execute) is answered by the same schema rule.
    const direct = await h.ctx.tools.execute({ callId: ToolCallIdOf('direct'), name: 'greet', arguments: {}, signal: new AbortController().signal })
    expect(direct.isError).toBe(false)
    expect(direct.content).toEqual([{ type: 'text', text: 'rendered hello from answer-mod' }])
    const refusals = h.warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('rewrote the arguments of echo'))
    expect(refusals).toEqual([
      'claude-code-mods: answer-mod: tool.call hook skipped: rewrote the arguments of echo; argument rewrites need the pre-tool input rewrite mechanism (.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)',
    ])
  })

  it('leaves tools alone when no mod hooks tool.call', async () => {
    const mod = writeMod('quiet-mod', 'export function register(on) { on("turn.start", ($, e, next) => next(e)) }')
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { command: 'ls' }), textResponse('ok')])
    const h = await harness([mod], adapter)
    h.ctx.tools.register(echoTool('echo', ran))
    const agent = await h.agent()
    await h.turn(agent, 'go')
    expect(ran).toEqual(['ls'])
    expect(toolResult(agent)).toEqual({ isError: false, text: 'ran ls' })
  })
})

describe('the mods API over harness services', () => {
  it('serves files, processes, session facts, the store, env, http, commands, and tools', async () => {
    const mod = writeMod('api-mod', `
      export function register(on) {
        on('command.run', { command: 'probe' }, async ($, e) => {
          const out = {}
          await $.fs.write('notes.md', '# Notes')
          out.read = await $.fs.read('notes.md')
          out.exists = [await $.fs.exists('notes.md'), await $.fs.exists('missing.md')]
          out.list = (await $.fs.list()).map(entry => entry.name + ':' + entry.kind)
          out.stat = (await $.fs.stat('notes.md')).kind
          await $.fs.stat('missing.md').catch(error => { out.statError = error.message })
          out.run = await $.process.run(['node', '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'])
          await $.process.run(['node', '-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 }).catch(error => { out.timeout = error.message })
          out.session = {
            id: await $.session.id(), cwd: await $.session.cwd(), root: await $.session.root(), model: await $.session.model(),
            turns: await $.session.turns(), version: await $.session.version(), usage: await $.session.usage(),
            messages: await $.session.messages(),
          }
          await $.store.set('count', 7)
          await $.store.set('name', 'x')
          await $.store.delete('name')
          await $.store.delete('never')
          out.store = { count: await $.store.get('count'), keys: await $.store.keys() }
          await $.env.set('CC_MODS_PROBE', 'yes')
          out.env = await $.env.get('CC_MODS_PROBE')
          await $.env.set('CC_MODS_PROBE', undefined)
          out.envGone = await $.env.get('CC_MODS_PROBE')
          const response = await $.http.fetch(e.args, { method: 'POST', headers: { 'x-mod': 'api-mod' }, body: 'ping', timeoutMs: 2000 })
          out.http = { status: response.status, ok: response.ok, text: response.text, echoed: response.headers['x-echo'] }
          out.get = (await $.http.fetch(e.args)).headers['x-echo']
          out.httpBig = await $.http.fetch(e.args + 'big').then(() => 'read', error => error.message)
          out.httpNone = await $.http.fetch(e.args + 'none')
          out.commands = (await $.command.list()).map(command => command.name + '/' + command.source)
          out.tools = (await $.tool.list()).map(tool => tool.name)
          out.call = await $.tool.call({ tool: 'echo', command: 'from mod' })
          out.toasts = [$.ui.toast('hi'), $.ui.status('busy'), $.ui.status(undefined), $.ui.log('debug line', { to: 'debug' })]
          out.open = await $.ui.open({ id: 'pane' })
          out.close = await $.ui.close({ id: 'pane' })
          out.panes = await $.ui.panes()
          out.state = await $.state.get({ plugin: 'api-mod', key: 'missing' })
          return { text: JSON.stringify(out) }
        })
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'probe', description: 'Probe the mods API', argumentHint: '<url>' })
          await $.command.register({ name: 'Bad Name!', description: 'x' }).catch(() => {})
          return next(e)
        })
      }
    `)
    const server = createServer((request, response) => {
      if (request.url === '/big') {
        response.end(Buffer.alloc(4 * 1024 * 1024 + 1, 120))
        return
      }
      if (request.url === '/none') {
        response.statusCode = 204
        response.end()
        return
      }
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        response.setHeader('x-echo', `${request.method} ${request.headers['x-mod']} ${body}`)
        response.end('pong')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const adapter = new MockAdapter([textResponse('ok')])
      const h = await harness([mod], adapter, {
        services: async (ctx, workspace) => {
          await ctx.plugin(LocalFileSystem, { cwd: workspace })
          await ctx.plugin(LocalSubprocessRuntime)
          await ctx.plugin(Storage)
          await ctx.plugin(StorageJson, { root: join(workspace, '.storage') })
          await ctx.plugin(StorageDomain, { backend: 'json' })
        },
      })
      h.ctx.tools.register(echoTool('echo'))
      const agent = await h.agent()
      await h.turn(agent, 'hello')
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      const run = await h.ctx.commands.execute(agent, `/probe ${url}`, [], new AbortController().signal)
      expect(run?.result.kind).toBe('success')
      const out = JSON.parse(String(run?.result.text).replace(/^api-mod: /, '')) as Record<string, unknown>
      expect(out.read).toBe('# Notes')
      expect(readFileSync(join(h.workspace, 'notes.md'), 'utf8')).toBe('# Notes')
      expect(out.exists).toEqual([true, false])
      expect(out.list).toContain('notes.md:file')
      expect(out.stat).toBe('file')
      expect(out.statError).toMatch(/missing\.md does not exist/)
      expect(out.run).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' })
      expect(out.timeout).toMatch(/did not exit within 200 ms/)
      expect(out.session).toEqual({
        id: 'a1', cwd: h.workspace, root: h.workspace, model: 'mock', turns: 1,
        version: MODS_API_VERSION,
        usage: { startedAt: agent.session.header.createdAt, context: { window: 0 }, rateLimits: [] },
        messages: [
          { role: 'user', text: 'hello', toolUses: [] },
          { role: 'user', text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: ${JSON.stringify(h.workspace)}.`, toolUses: [] },
          { role: 'assistant', text: 'ok', toolUses: [] },
        ],
      })
      expect(out.store).toEqual({ count: 7, keys: ['count'] })
      expect(out.env).toBe('yes')
      expect(out.envGone).toBeUndefined()
      expect(out.http).toEqual({ status: 200, ok: true, text: 'pong', echoed: 'POST api-mod ping' })
      expect(out.get).toBe('GET undefined ')
      expect(out.httpBig).toMatch(/larger than 4194304 bytes/)
      expect(out.httpNone).toMatchObject({ status: 204, ok: true, text: '' })
      expect(out.commands).toEqual(['probe/plugin'])
      expect(out.tools).toContain('echo')
      expect(out.call).toEqual({ result: 'ran from mod' })
      expect(out.toasts).toEqual([null, null, null, null])
      expect(out.open).toMatchObject({ isPlaced: false })
      expect((out.open as { reason: string }).reason).toMatch(/places no panes/)
      expect(out.close).toBeUndefined()
      expect(out.panes).toEqual([])
      expect(out.state).toEqual({})
      expect(h.info).toHaveBeenCalledWith('api-mod (toast): hi')
      expect(h.info).toHaveBeenCalledWith('api-mod (status): busy')
      expect(h.info).toHaveBeenCalledWith('api-mod (status): (cleared)')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})

describe('$.ui.ask through the user-questions answerer', () => {
  function askMod(): Promise<ModPlugin> {
    return writeMod('ask-mod', `
      export function register(on) {
        on('tool.call', { tool: 'echo' }, async ($, e, next) => {
          let answer
          if (e.command === 'plain') answer = await $.ui.ask('Run it?')
          else if (e.command === 'multi') answer = await $.ui.ask('Pick', { options: ['a', 'b', 'c'], header: 'Choices', multiSelect: true })
          else answer = await $.ui.ask('Run ' + e.command + '?', ['Run it', 'Refuse'])
          if (answer === 'Run it' || answer === 'typed yes' || answer === 'a, c') return next(e)
          return { deny: 'The user declined: ' + answer }
        })
      }
    `)
  }

  it('holds the call until the answerer settles and maps selections, typed answers, and dismissals', async () => {
    const ran: string[] = []
    const answers: string[][] = []
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'first' }), textResponse('one'),
      toolCallResponse('c2', 'echo', { command: 'second' }), textResponse('two'),
      toolCallResponse('c3', 'echo', { command: 'plain' }), textResponse('three'),
      toolCallResponse('c4', 'echo', { command: 'multi' }), textResponse('four'),
      toolCallResponse('c5', 'echo', { command: 'dismissed' }), textResponse('five'),
    ])
    const seen: unknown[] = []
    const h = await harness([askMod()], adapter, {
      services: async (ctx) => {
        await ctx.plugin(UserQuestionService)
        ctx.on('user-questions/request', (request) => {
          seen.push(request.questions[0])
          const next = answers.shift() ?? []
          return Promise.resolve({ answers: next.length === 0 && request.questions[0]?.question === 'Run dismissed?' ? [] : [{ id: 'answer', selected: next, ...next.length === 0 ? { custom: 'typed yes' } : {} }] })
        })
      },
    })
    h.ctx.tools.register(echoTool('echo', ran))
    const agent = await h.agent()
    answers.push(['Refuse'], ['Run it'], [], ['a', 'c'], [])
    await h.turn(agent, 'first')
    await h.turn(agent, 'second')
    await h.turn(agent, 'plain')
    await h.turn(agent, 'multi')
    await h.turn(agent, 'dismissed')
    expect(ran).toEqual(['second', 'plain', 'multi', 'dismissed'])
    const results = events(agent).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' && e.data.message.content[0])
    expect(results[0]).toEqual({ type: 'text', text: 'Error: The user declined: Refuse' })
    expect(seen[0]).toEqual({ id: 'answer', question: 'Run first?', options: [{ label: 'Run it' }, { label: 'Refuse' }] })
    expect(seen[2]).toEqual({ id: 'answer', question: 'Run it?' })
    expect(seen[3]).toEqual({ id: 'answer', question: 'Pick', header: 'Choices', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true })
    expect(h.warn).toHaveBeenCalledWith('claude-code-mods: ask-mod: tool.call hook skipped: threw Error: $.ui.ask: the user dismissed the question')
  })
})

describe('commands and prompts raised by a mod', () => {
  it('runs commands, submits prompts framed or as the user, and reports a command the mod forgot to answer', async () => {
    const mod = writeMod('driver-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'nudge', description: 'Submit a prompt from the mod' })
          await $.command.register({ name: 'silent', description: 'Registered without a command.run hook' })
          await $.command.register({ name: 'relay', description: 'Run another command' })
          await $.command.register({ name: 'quiet', description: 'Prints nothing' })
          await $.command.register({ name: 'call-echo', description: 'Call the echo tool from the mod' })
          return next(e)
        })
        on('command.run', { command: 'call-echo' }, async ($, e) => ({ text: JSON.stringify(await $.tool.call({ tool: 'echo', command: e.args })) }))
        on('command.run', { command: 'quiet' }, async ($) => {
          $.ui.log((await $.command.list()).map(c => c.name + '/' + c.source).join(','))
          return {}
        })
        on('command.run', { command: 'nudge' }, async ($, e) => {
          const sent = await $.prompt.submit(e.args === 'user' ? { text: 'as the user', asUser: true } : { text: 'from the mod' })
          return { text: 'sent ' + sent.text.length }
        })
        on('command.run', { command: 'relay' }, async ($, e) => {
          if (e.args === 'missing') return { text: await $.command.run({ command: 'nope' }).catch(error => error.message) }
          if (e.args === 'silent') return { text: await $.command.run({ command: 'silent' }).then(r => r.text) }
          if (e.args === 'fail') return { text: await $.command.run({ command: 'fail' }).catch(error => 'failed: ' + error.message) }
          if (e.args === 'mute') return { text: JSON.stringify(await $.command.run({ command: 'mute' })) }
          return { text: JSON.stringify(await $.command.run({ command: 'nudge', args: 'user' })) }
        })
      }
    `)
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const h = await harness([mod], adapter)
    h.ctx.commands.register({ name: 'fail', description: 'always fails', handler: () => ({ kind: 'error', text: 'nope' }) })
    h.ctx.commands.register({ name: 'mute', description: 'succeeds silently', handler: () => ({ kind: 'success' }) })
    const agent = await h.agent()
    const signal = new AbortController().signal
    const nudged = await h.ctx.commands.execute(agent, '/nudge', [], signal)
    expect(nudged?.result).toEqual({ kind: 'success', text: 'driver-mod: sent 47' })
    await agent.whenIdle()
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Message from the \\"driver-mod\\" mod:\\nfrom the mod')
    // Claude Code submits a mod's prompt as the user's own; the framing in the text names the mod.
    const submitted = events(agent).find(e => e.type === 'user/message')
    expect(submitted?.type === 'user/message' && submitted.data.source).toEqual({ kind: 'user' })

    const relayed = await h.ctx.commands.execute(agent, '/relay', [], signal)
    expect(relayed?.result).toEqual({ kind: 'success', text: 'driver-mod: {"text":"driver-mod: sent 11"}' })
    await agent.whenIdle()
    const last = adapter.requests[1]?.messages.at(-1)
    expect(last?.role === 'user' && last.content).toEqual([{ type: 'text', text: 'as the user' }])

    const silent = await h.ctx.commands.execute(agent, '/relay silent', [], signal)
    expect(silent?.result.text).toBe("driver-mod: driver-mod: driver-mod registered /silent but no command.run hook answered it; add on('command.run', { command: 'silent' }, hook)")
    const missing = await h.ctx.commands.execute(agent, '/relay missing', [], signal)
    expect(missing?.result.text).toBe('driver-mod: /nope is not a command')
    expect((await h.ctx.commands.execute(agent, '/relay fail', [], signal))?.result.text).toBe('driver-mod: failed: nope')
    expect((await h.ctx.commands.execute(agent, '/relay mute', [], signal))?.result.text).toBe('driver-mod: {}')
    expect((await h.ctx.commands.execute(agent, '/quiet', [], signal))?.result).toEqual({ kind: 'success' })
    expect(h.info).toHaveBeenCalledWith('driver-mod: call-echo/plugin,fail/builtin,mute/builtin,nudge/plugin,quiet/plugin,relay/plugin,silent/plugin')

    // Guidance a tool defers to the next request still reaches the model when the mod made the call.
    h.ctx.tools.register(echoTool('echo'))
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const downstream = await next()
      return { ...downstream, additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'deferred guidance' }], source: { kind: 'user' } })] }
    })
    expect((await h.ctx.commands.execute(agent, '/call-echo hi', [], signal))?.result.text).toBe('driver-mod: {"result":"ran hi"}')
    await h.turn(agent, 'next prompt')
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('deferred guidance')
  })
})

describe('mod tools: registration errors and unanswered calls', () => {
  it('fails an invalid registration inside $.tool.register and reports a call no hook answered as a tool error', async () => {
    const mod = writeMod('tools-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.tool.register({ name: 'orphan', description: 'No hook answers this tool' })
          const errors = []
          await $.tool.register({ name: 'bad name', description: 'x' }).catch(error => errors.push(error.message))
          await $.tool.register({ name: 'badschema', description: 'x', inputSchema: { type: 'string' } }).catch(error => errors.push(error.message))
          $.ui.log(errors.join(' | '))
          return next(e)
        })
        on('tool.call', { tool: 'mcp__tools-mod__orphan' }, async ($, e, next) => {
          if (e.mode === 'object') return { result: { structured: true } }
          if (e.mode === 'empty') return { result: undefined }
          return next(e)
        })
      }
    `)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp__tools-mod__orphan', { mode: 'pass' }), textResponse('one'),
      toolCallResponse('c2', 'mcp__tools-mod__orphan', { mode: 'object' }), textResponse('two'),
      toolCallResponse('c3', 'mcp__tools-mod__orphan', { mode: 'empty' }), textResponse('three'),
    ])
    const h = await harness([mod], adapter)
    const agent = await h.agent()
    await waitFor(() => h.info.mock.calls.some(call => String(call[0]).startsWith('tools-mod: tool "bad name" refused')))
    expect(h.info).toHaveBeenCalledWith(expect.stringMatching(/tool "bad name" refused.*\| .*object/))
    await h.turn(agent, 'one')
    await h.turn(agent, 'two')
    await h.turn(agent, 'three')
    const results = events(agent).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' && [e.data.message.isError, e.data.message.content[0]])
    expect(results[0]).toEqual([true, { type: 'text', text: "Error: tools-mod registered mcp__tools-mod__orphan but no tool.call hook answered it; add on('tool.call', { tool: 'mcp__tools-mod__orphan' }, hook)" }])
    expect(results[1]).toEqual([false, { type: 'text', text: '{"structured":true}' }])
    expect(results[2]).toEqual([false, { type: 'text', text: '' }])
  })
})

describe('subagents, programmatic calls, and malformed tool arguments', () => {
  it('marks a child agent\'s events with agentId, skips session.start for it, and reads an unparsable tool input as empty', async () => {
    const mod = writeMod('watch-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => { $.ui.log('session.start ' + await $.session.id()); return next(e) })
        on('session.end', async ($, e, next) => { $.ui.log('session.end ' + e.sessionId); return next(e) })
        on('tool.call', async ($, e, next) => {
          const { value = 0 } = await $.state.get({ plugin: 'watch-mod', key: 'calls' })
          await $.state.set({ plugin: 'watch-mod', key: 'calls' }, value + 1)
          $.ui.log('tool.call ' + e.tool + ' agent=' + (e.agentId ?? 'root') + ' n=' + (value + 1))
          if (e.command === 'direct') {
            const names = (await $.tool.list()).map(tool => tool.name)
            const nested = await $.tool.call({ tool: 'echo', command: 'nested' })
            $.ui.log('direct saw ' + names.join(',') + ' and ' + JSON.stringify(nested))
          }
          return next(e)
        })
        on('turn.start', async ($, e, next) => { $.ui.log('turn.start agent=' + (e.agentId ?? 'root')); return next(e) })
        on('turn.complete', async ($, e, next) => {
          const messages = await $.session.messages()
          $.ui.log('turn.complete agent=' + (e.agentId ?? 'root') + ' inputs=' + JSON.stringify(messages.flatMap(m => m.toolUses.map(t => t.input))))
          return next(e)
        })
      }
    `)
    const malformedCall = [
      { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
      { type: 'tool-call-delta' as const, index: 0, id: ToolCallIdOf('m1'), name: 'echo', argumentsDelta: '{bad json' },
      { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: ToolCallIdOf('m1'), name: 'echo', arguments: '{bad json' } },
      { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
    ]
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'child' }), textResponse('child done'),
      malformedCall, textResponse('root done'),
    ])
    const h = await harness([mod], adapter)
    h.ctx.tools.register(echoTool('echo'))
    const root = await h.agent()
    const child = await h.ctx.agentLoop.createAgent(h.ctx, {
      sessionId: SessionId('child-1'), parentAgent: root, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: h.workspace, origin: 'subagent' },
    })
    await h.turn(child.agent, 'child task')
    await child.dispose()
    await h.turn(root, 'root task')
    const lines = () => h.info.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('watch-mod: '))
    await waitFor(() => lines().length === 7)
    expect(lines()).toEqual([
      'watch-mod: session.start a1',
      'watch-mod: turn.start agent=child-1',
      'watch-mod: tool.call echo agent=child-1 n=1',
      'watch-mod: turn.complete agent=child-1 inputs=[{"command":"child"}]',
      'watch-mod: turn.start agent=root',
      'watch-mod: tool.call echo agent=root n=1',
      'watch-mod: turn.complete agent=root inputs=[{}]',
    ])
    const direct = await h.ctx.tools.execute({ callId: ToolCallIdOf('direct'), name: 'echo', arguments: { command: 'direct' }, signal: new AbortController().signal })
    expect(direct.isError).toBe(false)
    // The nested `$.tool.call` reaches only mods loaded before watch-mod, so its own hook is not re-entered.
    expect(h.info).toHaveBeenCalledWith('watch-mod: direct saw echo and {"result":"ran nested"}')
    expect(h.info.mock.calls.filter(call => String(call[0]).includes('agent=root n='))).toHaveLength(2)
  })
})

describe('turn.complete reasons and sessions the bridge did not follow from the start', () => {
  it('reports aborted and error turns, folds only the open turn, and ignores a session without a live agent', async () => {
    const mod = writeMod('ends-mod', `
      export function register(on) {
        on('turn.complete', async ($, e, next) => {
          $.ui.log('turn.complete ' + e.turnId + ' ' + e.reason + ' aborted=' + e.isAborted + ' answer=' + JSON.stringify(e.answer) + ' usage=' + (e.usage ? e.usage.model : 'none'))
          return next(e)
        })
      }
    `)
    const adapter = new MockAdapter([textResponse('fine'), 'hang'])
    const h = await harness([mod], adapter)
    const agent = await h.agent()
    await h.turn(agent, 'one')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === 2)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await h.turn(agent, 'three')
    const lines = () => h.info.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('ends-mod: '))
    await waitFor(() => lines().length === 3)
    expect(lines()[0]).toBe('ends-mod: turn.complete 1 answer aborted=false answer="fine" usage=mock')
    expect(lines()[1]).toMatch(/^ends-mod: turn.complete 2 aborted aborted=true answer="(partial)?" usage=/)
    expect(lines()[2]).toMatch(/^ends-mod: turn.complete 3 error aborted=false/)

    // A fold for a turn the bridge never saw open, and an event for a session no agent owns.
    agent.session.append('turn/end', { turn: 9, reason: { kind: 'completed' } })
    await waitFor(() => lines().length === 4)
    expect(lines()[3]).toBe('ends-mod: turn.complete 9 answer aborted=false answer="" usage=none')
    const orphan = h.ctx.sessions.create(SessionId('orphan'))
    orphan.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lines()).toHaveLength(4)
  })

  it('forgets a session\'s state and raises session.end when its agent is disposed', async () => {
    const mod = writeMod('end-mod', `
      export function register(on) {
        on('session.end', async ($, e, next) => { $.ui.log('ended ' + e.sessionId + ' ' + e.reason); return next(e) })
      }
    `)
    const h = await harness([mod], new MockAdapter([]))
    const handle = await h.ctx.agentLoop.createAgent(h.ctx, { sessionId: SessionId('ends'), agentOptions: { provider: 'mock', model: 'mock' } })
    // An assistant message outside any turn the bridge follows is left alone.
    handle.agent.session.append('assistant/message', {
      turn: 0, step: 0, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'stray' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    await handle.dispose()
    await waitFor(() => h.info.mock.calls.some(call => call[0] === 'end-mod: ended ends other'))
  })
})

describe('$.session.usage with the token meter', () => {
  it('reports the provider-measured prompt size against the route\'s context window', async () => {
    const mod = writeMod('usage-mod', `
      export function register(on) {
        on('turn.complete', async ($, e, next) => {
          const usage = await $.session.usage()
          $.ui.log('usage ' + JSON.stringify(usage.context))
          return next(e)
        })
      }
    `)
    const adapter = new WindowedAdapter([textResponse('ok')])
    const h = await harness([mod], adapter, { services: async (ctx) => { await ctx.plugin(TokenMeter) } })
    const agent = await h.agent()
    await h.turn(agent, 'measure me')
    await waitFor(() => h.info.mock.calls.some(call => String(call[0]).startsWith('usage-mod: usage ')))
    const line = h.info.mock.calls.map(call => String(call[0])).find(text => text.startsWith('usage-mod: usage ')) ?? ''
    const context = JSON.parse(line.slice('usage-mod: usage '.length)) as { tokens: number; window: number; percent: number }
    expect(context.window).toBe(1000)
    expect(context.tokens).toBeGreaterThan(0)
    expect(context.percent).toBe(Math.round((context.tokens / 1000) * 100))
  })
})

describe('loading diagnostics and configuration', () => {
  it('fails a mod plugin whose register throws, loads the rest, reports unserved events, and refuses a taken name', async () => {
    const quiet = writeMod('quiet-mod', 'export function register() {}')
    const adapter = new MockAdapter([])
    const h = await harness([quiet], adapter, { config: { hookTimeoutMs: 50, catchTimeoutMs: 20, processTimeoutMs: 100 } })
    expect(h.info).toHaveBeenCalledWith('claude-code-mods: hooks module quiet-mod@inline loaded (tier user); events: (none)')

    const broken = await writeMod('broken-mod', "export function register(on) { on('tool.calls', () => ({})) }")
    await expect(h.ctx.claudeCodeMods.add(broken.definition))
      .rejects.toThrow(/broken-mod: hooks module did not load: register threw .*"tool.calls" is not an event/)
    await expect(h.ctx.claudeCodeMods.add({ name: 'bad name!', register: () => {} }))
      .rejects.toThrow(/a plugin name uses letters, digits, _ and - only/)
    await expect(h.ctx.claudeCodeMods.add({ name: 'quiet-mod', register: () => {} }))
      .rejects.toThrow(/another mod of that name is already loaded/)

    // A hook on an event this host never raises registers, and the load reports it.
    const one = await h.ctx.claudeCodeMods.add({ name: 'one-unserved', register: (on) => { on('turn.step', () => ({})) } })
    expect(h.warn).toHaveBeenCalledWith('claude-code-mods: one-unserved: on("turn.step") registered, but this host never raises that event')
    await one()
    const dispose = await h.ctx.claudeCodeMods.add({
      name: 'unserved-mod',
      register: (on) => {
        on('tool.check', () => ({ decision: 'allow' }))
        on('turn.step', () => ({}))
        on('tool.check', { tool: 'Bash' }, () => ({ decision: 'allow' }))
      },
    })
    expect(h.warn).toHaveBeenCalledWith(
      'claude-code-mods: unserved-mod: on("tool.check", "turn.step") registered, but this host never raises those events',
    )
    expect(h.ctx.claudeCodeMods.mods.map(mod => mod.name)).toEqual(['quiet-mod', 'unserved-mod'])
    await dispose()
    expect(h.ctx.claudeCodeMods.mods.map(mod => mod.name)).toEqual(['quiet-mod'])

    const fresh = (): Context => {
      const ctx = new Context()
      fibers.push(ctx.fiber)
      return ctx
    }
    expect(() => new ClaudeCodeMods(fresh(), { hookTimeoutMs: 0 })).toThrow(/hookTimeoutMs must be a positive number/)
    expect(() => new ClaudeCodeMods(fresh(), { catchTimeoutMs: -1 })).toThrow(/catchTimeoutMs must be a positive number/)
    expect(() => new ClaudeCodeMods(fresh(), { processTimeoutMs: Number.NaN })).toThrow(/processTimeoutMs must be a positive number/)
    expect(() => new ClaudeCodeMods(fresh(), { bandColumns: 0 })).toThrow(/bandColumns must be a positive number/)
    expect(() => new ClaudeCodeMods(fresh(), { bandRows: -1 })).toThrow(/bandRows must be a positive number/)
  })

  it('disposes while a timer callback waits inside a $ call: the wait is cancelled and disposal settles', async () => {
    const mod = writeMod('sleeper-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          $.clock.after(1, async () => { await $.clock.sleep(60_000) })
          return next(e)
        })
      }
    `)
    const h = await harness([mod], new MockAdapter([]))
    await h.agent()
    await new Promise(resolve => setTimeout(resolve, 20))
    const started = Date.now()
    await h.mods.dispose()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(h.warn).toHaveBeenCalledWith('claude-code-mods: sleeper-mod: timer callback failed: claude-code-mods disposed')
  })

  it('mounts a mod plugin through the Loader-visible plugin shape and unmounts it with its hooks', async () => {
    const adapter = new MockAdapter([])
    const h = await harness([], adapter)
    const plugin = await writeMod('late-mod', "export function register(on, options) { on('turn.start', ($, e, next) => next(e)); globalThis.lateOptions = options }", { greeting: 'hi' })
    expect(plugin.name).toBe('claude-code-mod-late-mod')
    expect(plugin.inject).toEqual(['claudeCodeMods'])
    const fiber = await h.ctx.plugin(plugin, { greeting: 'hello', extra: 2 })
    await fiber.await()
    expect((globalThis as { lateOptions?: unknown }).lateOptions).toEqual({ greeting: 'hello', extra: 2 })
    expect(h.ctx.claudeCodeMods.mods.map(mod => mod.name)).toEqual(['late-mod'])
    await fiber.dispose()
    expect(h.ctx.claudeCodeMods.mods).toEqual([])
    delete (globalThis as { lateOptions?: unknown }).lateOptions
  })

  it('is a Service plugin the Loader keeps by its default export', () => {
    expect(ClaudeCodeMods.inject).toEqual(['workingDirectory'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped: unknown = loader.unwrapExports({ default: ClaudeCodeMods })
    expect(unwrapped).toBe(ClaudeCodeMods)
  })
})

describe('post-execute interplay and prompt rewrites with images', () => {
  it('keeps a downstream block, carries downstream contexts onto a replaced result, and rewrites only text blocks', async () => {
    const mod = writeMod('rewrite-mod', `
      export function register(on) {
        on('tool.call', { tool: 'echo' }, async ($, e, next) => {
          const r = await next(e)
          return { ...r, result: 'REPLACED' }
        })
        on('prompt.submit', ($, e, next) => next({ ...e, text: 'rewritten: ' + e.text }))
      }
    `)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'a' }), textResponse('one'),
      toolCallResponse('c2', 'echo', { command: 'b' }), textResponse('two'),
      textResponse('three'), textResponse('four'),
    ])
    const h = await harness([mod], adapter)
    h.ctx.tools.register(echoTool('echo'))
    let block = true
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      if (block) return { kind: 'block', feedback: [{ type: 'text', text: 'blocked downstream' }] }
      const downstream = await next()
      return { ...downstream, additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'downstream context' }], source: { kind: 'user' } })] }
    })
    const agent = await h.agent()
    const image = { type: 'image' as const, attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as ImageAttachmentRef }
    // Injected context from another plugin is claimed with the waking prompt; only the human's message is the prompt.
    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'injected by a plugin' }], source: { kind: 'user-question-reply', callId: ToolCallIdOf('q1'), outcome: 'answered' } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const entered = () => events(agent).filter(e => e.type === 'user/message').map(e => e.type === 'user/message' && e.data.content)
    expect(entered()).toContainEqual([{ type: 'text', text: 'injected by a plugin' }])
    expect(entered()).toContainEqual([{ type: 'text', text: 'rewritten: firstsecond' }, image])
    expect(toolResult(agent)).toEqual({ isError: true, text: 'blocked downstream' })

    block = false
    await h.turn(agent, 'again')
    const results = events(agent).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' && e.data.message.content[0])
    expect(results[1]).toEqual({ type: 'text', text: 'REPLACED' })
    expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('downstream context')

    // An image-only prompt gains the rewritten text; a prompt without any human message is left alone.
    agent.followup(createUserMessage({ content: [image], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(entered().at(-1)).toEqual([image, { type: 'text', text: 'rewritten: ' }])
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'from a plugin' }], source: { kind: 'user-question-reply', callId: ToolCallIdOf('q2'), outcome: 'answered' } }))
    await agent.whenIdle()
    expect(entered().at(-1)).toEqual([{ type: 'text', text: 'from a plugin' }])
  })
})

describe('a mod\'s $.tool.call reaches the mods loaded before it', () => {
  it('runs the earlier mod\'s tool.call hook once, attributed to the caller, and never the caller\'s own', async () => {
    const observer = writeMod('observer-mod', `
      export function register(on) {
        on('tool.call', async ($, e, next) => {
          $.ui.log('saw ' + e.tool + ' from ' + next.origin.plugin + '/' + next.origin.tier + ' id=' + (e.tool_use_id.startsWith('mod-') ? 'mod' : 'model'))
          return next(e)
        })
      }
    `)
    const caller = writeMod('caller-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'nest', description: 'Call a tool from the mod' })
          return next(e)
        })
        on('tool.call', async ($, e, next) => {
          $.ui.log('caller saw ' + e.tool)
          return next(e)
        })
        on('command.run', { command: 'nest' }, async ($) => {
          const result = await $.tool.call({ tool: 'echo', command: 'nested' })
          return { text: JSON.stringify(result) }
        })
      }
    `)
    const h = await harness([observer, caller], new MockAdapter([]))
    h.ctx.tools.register(echoTool('echo'))
    const agent = await h.agent()
    const run = await h.ctx.commands.execute(agent, '/nest', [], new AbortController().signal)
    expect(run?.result).toEqual({ kind: 'success', text: 'caller-mod: {"result":"ran nested"}' })
    const lines = h.info.mock.calls.map(call => String(call[0])).filter(line => /^(observer|caller)-mod: /.test(line))
    expect(lines).toEqual(['observer-mod: saw echo from caller-mod/user id=mod'])
  })
})

describe('the band above the prompt', () => {
  it('draws Token Weather from session facts, redraws on the state it read, and resolves a Blast Radius hold by a press', { timeout: 30_000 }, async () => {
    const tokenWeather = (await import('../examples/token-weather/index.ts')).default
    const blastRadius = (await import('../examples/blast-radius/index.ts')).default
    // Loaded outermost: draws a button that throws once armed, to show a failing onPress is reported, not fatal.
    const boom = writeMod('boom-mod', `
      let armed = false
      export function register(on) {
        on('session.start', async ($, e, next) => { await $.command.register({ name: 'arm-boom', description: 'arm' }); return next(e) })
        on('command.run', { command: 'arm-boom' }, async ($) => { armed = true; $.ui.invalidate('ui.render'); return { text: 'armed' } })
        on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
          if (!armed) return next(e)
          const { Button } = $.ui.resolve(e)
          return Button({ label: 'Boom', onPress: () => { armed = false; throw new Error('nope') } })
        })
      }
    `)
    const ran: string[] = []
    const adapter = new WindowedAdapter([
      textResponse('first answer'),
      toolCallResponse('c1', 'bash', { command: 'git reset --hard' }), textResponse('held'),
      toolCallResponse('c2', 'bash', { command: 'git clean -fd' }), textResponse('ran'),
    ])
    // One band instance, consulted in load order: the guard that yields when idle goes before the readout that always draws.
    const h = await harness([boom, blastRadius, tokenWeather], adapter, {
      config: { bandColumns: 100, bandRows: 6 },
      services: async (ctx, workspace) => {
        await ctx.plugin(TokenMeter)
        await ctx.plugin(LocalFileSystem, { cwd: workspace })
        await ctx.plugin(LocalSubprocessRuntime)
      },
    })
    // Windows does not provide the POSIX sleep executable; other subprocesses run normally.
    const spawn = h.ctx.subprocess.spawn.bind(h.ctx.subprocess)
    const withoutSleep = vi.spyOn(h.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv[0] === 'sleep') throw new Error('spawn sleep ENOENT')
      return spawn(spec)
    })
    onTestFinished(() => { withoutSleep.mockRestore() })
    h.ctx.tools.register(echoTool('bash', ran))
    const agent = await h.agent()
    const mods = h.ctx.claudeCodeMods
    const seen: unknown[] = []
    const watching = new AbortController()
    const watcher = (async () => {
      for await (const snapshot of mods.watchBand(agent, watching.signal)) seen.push(snapshot)
    })()
    // Before a turn, Token Weather has no reading and Blast Radius holds nothing: the band is empty.
    await waitFor(() => seen.length === 1)
    expect(seen[0]).toEqual({ generation: 1, tree: null })
    await h.turn(agent, 'hello')
    // turn.complete wrote the reading Token Weather's render reads: the band redraws without an invalidate.
    await waitFor(() => JSON.stringify(seen.at(-1)).includes('of context'))
    expect(h.warn).not.toHaveBeenCalledWith(expect.stringMatching(/ui.render hook skipped/))

    // A risky command holds; the hook polls with real sleeps while the band offers Proceed and Cancel.
    const holding = h.turn(agent, 'reset it')
    await waitFor(() => JSON.stringify(seen.at(-1)).includes('Cancel'))
    const drawn = seen.at(-1) as { generation: number; tree: unknown }
    const buttonId = (tree: unknown, label: string): string | undefined =>
      [...JSON.stringify(tree).matchAll(/"label":"(\w+)","hotkey":"\d"\},"children":\[\],"actionId":"(a\d+)"/gu)]
        .find(match => match[1] === label)?.[2]
    const cancelId = buttonId(drawn.tree, 'Cancel')
    expect(cancelId).toBeDefined()
    await mods.pressBand(agent, drawn.generation, cancelId ?? '')
    await holding
    expect(h.warn).not.toHaveBeenCalledWith(expect.stringMatching(/tool.call hook skipped/))
    expect(ran).toEqual([])
    expect(toolResult(agent)?.text).toMatch(/Blast Radius held this command: the user pressed Cancel/)
    await waitFor(() => !JSON.stringify(seen.at(-1)).includes('Cancel'))

    // Proceed lets the next risky command run.
    const proceeding = h.turn(agent, 'clean it')
    await waitFor(() => JSON.stringify(seen.at(-1)).includes('Proceed'))
    const second = seen.at(-1) as { generation: number; tree: unknown }
    const proceedId = buttonId(second.tree, 'Proceed')
    await mods.pressBand(agent, second.generation, proceedId ?? '')
    await proceeding
    expect(ran).toEqual(['git clean -fd'])
    // A stale press is ignored and reported, not applied.
    await mods.pressBand(agent, second.generation, proceedId ?? '')
    expect(h.warn).toHaveBeenCalledWith(expect.stringMatching(/band press ignored/))

    // A button whose onPress throws is reported and the band redraws.
    await h.ctx.commands.execute(agent, '/arm-boom', [], new AbortController().signal)
    await waitFor(() => JSON.stringify(seen.at(-1)).includes('Boom'))
    const armed = seen.at(-1) as { generation: number; tree: unknown }
    const boomId = [...JSON.stringify(armed.tree).matchAll(/"actionId":"(a\d+)"/gu)][0]?.[1]
    await mods.pressBand(agent, armed.generation, boomId ?? '')
    expect(h.warn).toHaveBeenCalledWith("claude-code-mods: a button's onPress failed: nope")
    await waitFor(() => !JSON.stringify(seen.at(-1)).includes('Boom'))
    watching.abort()
    await watcher
  })
})
