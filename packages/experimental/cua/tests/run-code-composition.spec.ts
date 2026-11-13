/** Standard-mode CUA through Loader, the native executor, and real persistent Node programs. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage, LlmAdapter, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { createNativeFixture, png } from '../../../../snapshots/session/cua-run-code/native-channel.mjs'
import { CuaConfig, installCua } from '../src/index.ts'
import { Request } from '../src/protocol.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const programs = [
  'globalThis.visits = 1; var initialCua = cua; var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.getAccessibilityTree(); await win.click("0"); var screenshot = await win.getScreenshot(); inspect(JSON.stringify({ visits, bindings: Object.keys(tools), app: app.appHandle, window: win.windowId, pid: process.pid })); inspect(screenshot)',
  'globalThis.visits++; await win.getAccessibilityTree(); await win.click("0"); await win.getScreenshot(); inspect(JSON.stringify({ visits, sameCua: cua === initialCua, app: app.appHandle, window: win.windowId, tree: await win.getAccessibilityTree(), pid: process.pid }))',
  'await win.click("0")',
]

class ProgramModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** Requests a test holds back until it has finished acting between two model steps. */
  readonly gates = new Map<number, Promise<void>>()
  constructor(private readonly programs: readonly string[]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.gates.get(this.requests.length)
    const code = this.programs[this.requests.length]
    this.requests.push(options)
    if (code !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(`cua-program-${this.requests.length}`),
        name: 'cua_run_code', arguments: JSON.stringify({ code, description: 'Inspect and increment the fixture counter' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture programs finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(programs: readonly string[], platform = 'macos', selectorPid?: number, presetFree = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-run-code-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const native = createNativeFixture(selectorPid)
  const guarded: string[] = []
  const modules = {
    llm: LlmRuntime, sessions: SessionStore, projections: SessionProjectionRegistry, systemPrompt: SystemPrompt,
    tools: ToolRuntime, agents: AgentRegistry, agentLoop: AgentLoop, agentPresets: AgentPresets,
    fs: FileSystem, workingDirectory: WorkingDirectory, subprocess: Subprocess,
    sandbox: Sandbox, sandboxPolicy: SandboxPolicy, sharedRuntime: NodeRuntime,
    attachments: LocalAttachmentStore, computerUse: ComputerUseRegistry, native: NativeToolExecutor,
    standard: {
      inject: ['agentPresets'],
      async * apply(owner: Context) {
        yield await owner.agentPresets.register({ id: 'standard', plugins: [{ name: 'cordis:native' }] })
      },
    },
    outside: {
      inject: ['tools'],
      apply(owner: Context) {
        owner.tools.register(defineTool({ name: 'outside_cua', description: 'A tool outside the CUA program.', parameters: {},
          output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'outside' }))
        owner.tools.guard((execution) => {
          if (execution.name !== 'cua') return
          const operation = Request.parse(execution.arguments)
          guarded.push(execution.callId)
          if (operation.method === 'click' && native.state.count === 2) {
            return { reason: 'The fixture allows two clicks.', info: { name: 'FixtureGuardError', code: 'FIXTURE_CLICK_DENIED' } }
          }
        })
      },
    },
    cua: {
      inject: ['computerUse', 'subprocess', 'tools', 'systemPrompt', 'agents'], Config: CuaConfig,
      apply(owner: Context, config: CuaConfig) {
        installCua(owner, config, { helperPath: process.execPath, createChannel: native.createChannel,
          getGuidance: () => 'Use the CUA object API to inspect and control the selected application.',
          acceptsPidSelector: selectorPid !== undefined,
          capabilities: { platform, methods: ['getCapabilities', 'listApps', 'getApp', 'getState', 'click', 'screenshot'],
            appLevelAccessibility: true, keyboard: ['app'], browser: false, coordinateSpace: 'screenshot-pixels' },
          permissionParameters: (_method, permission, locale) => ({ permission, locale }),
        })
      },
    },
  }
  // The standard preset mounts the native executor in its own scope; a composition without presets mounts it on the Host.
  const hosted = (name: string): boolean => presetFree ? name !== 'agentPresets' && name !== 'standard' : name !== 'native'
  const entries = Object.keys(modules).filter(hosted).map(name => ({
    id: name, name: `cordis:${name}`,
    ...name === 'agentPresets' ? { config: { default: 'standard' } } : {},
    ...name === 'sandboxPolicy' ? { config: { mode: 'danger-full-access', workspaceRoot: directory } } : {},
    ...name === 'sharedRuntime' ? { config: { executionMode: 'per-call' } } : {},
    ...name === 'attachments' ? { config: { dshHome: directory } } : {},
    ...name === 'cua' ? { config: { allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } } : {},
  }))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(entries, null, 2) + '\n')
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, modules, { include: Include })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const model = new ProgramModel(programs)
  ctx.llm.registerAdapter(['cua-fixture'], model)
  const handle = await ctx.agents.create({ sessionId: brandString<SessionId>('cua-standard-composition'), meta: { cwd: directory },
    agentOptions: { provider: 'cua-fixture', model: 'vision' },
    ...presetFree ? {} : { setup: async (owner: Context) => { await ctx.agentPresets.mount(owner, 'standard') } },
  })
  const agent = handle.agent
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') idle.resolve() })
  const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'cua')
  if (provider?.fiber === undefined) throw new Error('Loader did not activate the CUA fixture provider')
  return { ctx, native, guarded, model, agent, provider: provider.fiber,
    run: () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect and increment the fixture counter.' }], source: { kind: 'user' } }))
      return idle.promise
    },
  }
}

it('retains CUA objects, guards and logs hidden subcalls, forwards screenshots, and releases the optional provider', async () => {
  const { ctx, native, guarded, model, agent, provider, run } = await setup(programs)
  expect(ctx.ptcRuntime.retainsState).toBe(false)
  expect(ctx.tools.get('cua', agent)).toBeUndefined()
  expect(ctx.tools.get('cua_run_code', agent)).toBeDefined()
  await run()

  expect(model.requests).toHaveLength(4)
  expect(model.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['cua_run_code', 'outside_cua'])
  const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
  expect(results.map(result => result.isError), JSON.stringify(results)).toEqual([false, false, true])
  const first = z.object({ visits: z.number(), bindings: z.array(z.string()), app: z.string(), window: z.string(), pid: z.number() })
    .parse(JSON.parse(results[0]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')))
  expect(first).toMatchObject({ visits: 1, bindings: ['cua'], app: 'fixture-app', window: '7' })
  expect(first.pid).not.toBe(process.pid)
  expect(JSON.parse(results[1]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')))
    .toEqual({ visits: 2, sameCua: true, app: 'fixture-app', window: '7',
      tree: '- [0] AXButton "Increment"\n- AXStaticText "Count: 2"', pid: first.pid })
  expect(native.state.count).toBe(2)
  const dispatches = agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
  expect(dispatches.map(event => event.data.subCallId)).toEqual(guarded)
  expect(dispatches.every(event => event.data.name === 'cua')).toBe(true)
  expect(dispatches.filter(event => event.data.rootCallId === 'cua-program-2')
    .map(event => Request.parse(event.data.arguments).method)).toEqual(['getState', 'click', 'screenshot', 'getState'])
  expect(dispatches.at(-1)?.data).toMatchObject({ rootCallId: 'cua-program-3', isError: true,
    error: { name: 'FixtureGuardError', code: 'FIXTURE_CLICK_DENIED' } })
  expect(native.calls.map(call => call.id)).toEqual(guarded.slice(0, -1))
  const images = model.requests[1]!.messages.flatMap(message => message.content.filter(block => block.type === 'image'))
  expect(images).toHaveLength(1)
  expect(model.requests[2]!.messages.flatMap(message => message.content.filter(block => block.type === 'image'))).toHaveLength(1)
  const image = images[0]!
  expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
  expect(Buffer.from((await ctx.attachments.readImage(image.attachment)).data).toString('base64')).toBe(png)
  expect(JSON.stringify(agent.session.deriveMessages())).not.toContain(png)

  await provider.dispose()
  expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['outside_cua'])
  expect((await ctx.systemPrompt.assemble({ scope: agent })).sections.some(section => section.name === 'computer-use:dsh-cua')).toBe(false)
  expect(native.state).toEqual({ count: 2, openedChannels: 1, closedChannels: 1 })
  expect(() => process.kill(first.pid, 0)).toThrow()
  expect(ctx.ptcRuntime.retainsState).toBe(false)
})

it('runs cua_run_code programs for an Agent in a composition without presets', async () => {
  const { ctx, native, model, agent, run } = await setup(programs.slice(0, 2), 'macos', undefined, true)
  expect(ctx.get('agentPresets')).toBeUndefined()
  expect(ctx.tools.get('cua', agent)).toBeUndefined()
  await run()
  expect(model.requests).toHaveLength(3)
  expect(model.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['cua_run_code', 'outside_cua'])
  const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
  expect(results.map(result => result.isError), JSON.stringify(results)).toEqual([false, false])
  expect(JSON.parse(results[1]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')))
    .toMatchObject({ visits: 2, sameCua: true, app: 'fixture-app', window: '7' })
  expect(native.state.count).toBe(2)
  expect(agent.session.snapshotEvents().some(event => event.type === 'agent-preset/selected')).toBe(false)
})

it('releases one Agent program environment through ctx.cuaPrograms while keeping its application access', async () => {
  const { ctx, native, model, agent, run } = await setup([
    'globalThis.visits = 1; var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); inspect(process.pid)',
    'inspect(JSON.stringify(typeof win === "undefined" ? { fresh: true, visits: globalThis.visits ?? null, pid: process.pid } : { fresh: false, pid: process.pid }))',
  ])
  const programs = ctx.get('cuaPrograms')
  if (programs === undefined) throw new Error('CUA provider did not publish ctx.cuaPrograms')
  // The caller holds the next program back until the release has settled: the second model request waits for it.
  const firstSettled: PromiseWithResolvers<void> = Promise.withResolvers()
  const released: PromiseWithResolvers<void> = Promise.withResolvers()
  model.gates.set(1, released.promise)
  ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'tool/result' && event.data.message.toolCallId === 'cua-program-1') firstSettled.resolve()
  })
  const completed = run()
  await firstSettled.promise
  await programs.release(agent)
  released.resolve()
  await completed
  const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
  expect(results.map(result => result.isError)).toEqual([false, false])
  const text = (index: number) => JSON.parse(results[index]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')) as Record<string, unknown>
  const firstPid = z.number().int().positive().parse(text(0))
  const second = text(1)
  expect(second).toMatchObject({ fresh: true, visits: null })
  expect(second.pid).not.toBe(firstPid)
  expect(() => process.kill(firstPid, 0)).toThrow()
  // The native connection and its application grant survive; only the program process was replaced.
  expect(native.state).toMatchObject({ openedChannels: 1, closedChannels: 0 })
  await expect(programs.release(agent)).resolves.toBeUndefined()
})

it('fails a running program as aborted when its environment is released and starts the next program fresh', async () => {
  const { ctx, native, model, agent, run } = await setup([
    'globalThis.visits = 1; var app = await cua.getApp("test.fixture"); await new Promise(() => {})',
    'inspect(JSON.stringify({ visits: globalThis.visits ?? null, hasApp: typeof app !== "undefined" }))',
  ])
  const programs = ctx.get('cuaPrograms')
  if (programs === undefined) throw new Error('CUA provider did not publish ctx.cuaPrograms')
  const released: PromiseWithResolvers<void> = Promise.withResolvers()
  model.gates.set(1, released.promise)
  // The first program is running inside its environment once its application selection has settled.
  const selected: PromiseWithResolvers<void> = Promise.withResolvers()
  ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'tool/ptc-dispatch' && event.data.rootCallId === 'cua-program-1') selected.resolve()
  })
  const completed = run()
  await selected.promise
  await programs.release(agent)
  released.resolve()
  await completed
  const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
  const text = (index: number) => results[index]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(results.map(result => result.isError)).toEqual([true, false])
  expect(text(0)).toContain('code run failed (abort)')
  expect(JSON.parse(text(1))).toEqual({ visits: null, hasApp: false })
  expect(native.state).toMatchObject({ openedChannels: 1, closedChannels: 0 })
})

it('recreates the automatic facade when its environment is rebuilt', async () => {
  const { agent, run } = await setup([
    'var previousCua = cua; inspect("created")',
    'process.exit(0)',
    'inspect(JSON.stringify({ ready: typeof cua.getApp === "function", previous: typeof previousCua }))',
  ])
  await run()
  const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
  expect(results.map(result => result.isError), JSON.stringify(results)).toEqual([false, true, false])
  expect(JSON.parse(results[2]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')))
    .toEqual({ ready: true, previous: 'undefined' })
})

it('settles an in-flight native call before releasing the provider connection and program process', async () => {
  const { ctx, native, agent, provider, run } = await setup([
    'var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.getAccessibilityTree(); inspect(process.pid)',
    'await win.click("0")',
  ])
  const started = native.holdNextClick()
  let nestedSignalAborted: boolean | undefined
  ctx.on('tools/result', (execution) => {
    if (execution.agent === agent && execution.name === 'cua' && execution.rootCallId === 'cua-program-2') {
      nestedSignalAborted = execution.signal.aborted
    }
  })
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'tool/ptc-dispatch' && event.data.rootCallId === 'cua-program-2') native.events.push('subcall-settled')
  })
  const completed = run()
  await Promise.race([
    started,
    completed.then(() => {
      const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
      throw new Error(`CUA turn ended before the held native click: ${JSON.stringify(results)}`)
    }),
  ])
  const first = agent.session.deriveMessages().find(message => message.role === 'tool')
  const pid = z.number().int().positive().parse(JSON.parse(first!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')))
  expect(() => process.kill(pid, 0)).not.toThrow()
  expect(native.state.count).toBe(0)
  await provider.dispose()
  await completed

  expect(native.events).toEqual(['native-cancelled', 'subcall-settled', 'native-close'])
  expect(native.state).toEqual({ count: 0, openedChannels: 1, closedChannels: 1 })
  const events = agent.session.snapshotEvents()
  const starts = events.filter(event => event.type === 'tool/ptc-dispatch-start')
    .filter(event => event.data.rootCallId === 'cua-program-2')
  const ends = events.filter(event => event.type === 'tool/ptc-dispatch')
    .filter(event => event.data.rootCallId === 'cua-program-2')
  expect(starts).toHaveLength(1)
  expect(ends).toHaveLength(1)
  // NativeClient owns cancellation diagnostics rather than throwing the signal's AbortError.
  expect(ends[0]?.data).toMatchObject({ subCallId: starts[0]?.data.subCallId, isError: true,
    content: [{ type: 'text', text: 'Error: NATIVE_CANCELLED: Operation cancelled; inspect fresh state before retrying input' }] })
  expect(nestedSignalAborted).toBe(true)
  const outer = events.filter(event => event.type === 'tool/result')
    .find(event => event.data.message.toolCallId === 'cua-program-2')
  expect(outer?.data).toMatchObject({ message: { isError: true },
    error: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' } })
  expect(agent.session.deriveMessages().filter(message => message.role === 'tool').map(message => message.isError)).toEqual([false, true])
  expect(() => process.kill(pid, 0)).toThrow()
  expect(ctx.tools.get('cua_run_code', agent)).toBeUndefined()
})

it.each([
  { platform: 'windows', selectorPid: undefined, expectedProcess: {}, selector: 'test.fixture' },
  { platform: 'fixture', selectorPid: 101, expectedProcess: { pid: 101 }, selector: '101' },
])('returns only usable application selectors for $platform', async ({ platform, selectorPid, expectedProcess, selector }) => {
  const { agent, run, native } = await setup([
    'var apps = await cua.listApps(); inspect(JSON.stringify(apps)); await cua.getApp(String(apps[0].pid ?? apps[0].id))',
  ], platform, selectorPid)
  await run()
  const result = agent.session.deriveMessages().find(message => message.role === 'tool')
  expect(result?.isError).toBe(false)
  expect(JSON.parse(result!.content.filter(block => block.type === 'text').map(block => block.text).join('')))
    .toEqual([{ id: 'test.fixture', displayName: 'Fixture', isRunning: true, ...expectedProcess }])
  expect(native.calls.filter(call => call.method === 'getApp').map(call => call.params.selector)).toEqual([selector])
})

it('forwards per-read accessibility limits to the Windows backend', async () => {
  const { run, native } = await setup([
    'var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.getAccessibilityTree({ maxElements: 30, maxDepth: 3 })',
  ], 'windows')
  await run()
  expect(native.calls.find(call => call.method === 'getState')?.params)
    .toMatchObject({ maxElements: 30, maxDepth: 3 })
})
