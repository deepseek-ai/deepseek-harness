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
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { createNativeFixture, png } from '../../../../snapshots/session/cua-run-code/native-channel.mjs'
import { CuaConfig, installCua } from '../src/index.ts'
import { COMMON_GUIDANCE } from '../src/guidance.ts'
import { Request } from '../src/protocol.ts'
import { NativeClient } from '../src/native-client.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const programs = [
  'globalThis.visits = 1; var initialCua = cua; var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.getAccessibilityTree(); await win.click("0"); var screenshot = await win.getScreenshot(); inspect(JSON.stringify({ visits, bindings: Object.keys(tools), app: app.appHandle, window: win.windowId, pid: process.pid })); inspect(screenshot)',
  'globalThis.visits++; await win.getAccessibilityTree(); await win.click("0"); await win.getScreenshot(); inspect(JSON.stringify({ visits, sameCua: cua === initialCua, app: app.appHandle, window: win.windowId, tree: await win.getAccessibilityTree(), pid: process.pid }))',
  'await win.click("0")',
]

class ProgramModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  toolName = 'cua_run_code'
  beforeStream?: (index: number, options: GenerateOptions) => Promise<void>
  /** Requests a test holds back until it has finished acting between two model steps. */
  readonly gates = new Map<number, Promise<void>>()
  constructor(private programs: readonly string[]) { super() }
  restart(programs: readonly string[]): void { this.programs = programs; this.requests.length = 0 }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.beforeStream?.(this.requests.length, options)
    await this.gates.get(this.requests.length)
    const code = this.programs[this.requests.length]
    this.requests.push(options)
    if (code !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(`cua-program-${this.requests.length}`),
        name: this.toolName, arguments: JSON.stringify({ code, description: 'Inspect and increment the fixture counter' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture programs finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(programs: readonly string[], platform = 'macos', selectorPid?: number, presetFree = false, heldInputState = false, timeoutMs = 30_000, disposeNative?: (state: { closedChannels: number }) => Promise<void>) {
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
          getGuidance: () => COMMON_GUIDANCE,
          acceptsPidSelector: selectorPid !== undefined, heldInputState,
          ...disposeNative ? { disposeNative: () => disposeNative(native.state) } : {},
          capabilities: { platform, methods: ['getCapabilities', 'listApps', 'getApp', 'getState', 'click', 'screenshot', 'sendKeyEvent', 'toggleMouse'],
            appLevelAccessibility: platform !== 'windows', keyboard: platform === 'windows' ? ['window'] : ['app'], browser: false, coordinateSpace: 'screenshot-pixels' },
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
    ...name === 'cua' ? { config: { timeoutMs, allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } } : {},
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
  const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'cua')
  if (provider?.fiber === undefined) throw new Error('Loader did not activate the CUA fixture provider')
  return { ctx, native, guarded, model, agent, handle, provider: provider.fiber,
    run: () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect and increment the fixture counter.' }], source: { kind: 'user' } }))
      return agent.whenIdle()
    },
  }
}

it('presents the object API, retains raw bindings and CUA objects, and preserves guarded calls and screenshots', async () => {
  const { ctx, native, guarded, model, agent, provider, run } = await setup(programs)
  expect(ctx.ptcRuntime.retainsState).toBe(false)
  expect(ctx.tools.get('cua', agent)).toBeUndefined()
  expect(ctx.tools.get('cua_run_code', agent)).toBeDefined()
  await run()

  expect(model.requests).toHaveLength(4)
  expect(model.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['cua_run_code', 'outside_cua'])
  const description = model.requests[0]?.tools?.find(tool => tool.name === 'cua_run_code')?.description
  expect(description).toContain('The global cua object is ready to use')
  expect(description).toContain('Call other session tools directly outside cua_run_code.')
  expect(description).toContain('Use inspect(...values) to display selected text and images.')
  expect(description).not.toContain('tools.cua')
  const guidance = model.requests[0]!.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
  expect(guidance).toContain('cua.getApp(selector: string)')
  expect(guidance).not.toContain('Raw tools use { method, params }')
  expect(guidance).not.toContain('getAccessibilityTree maps to getState')
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

const holdProgram = 'var app = await cua.getApp("test.fixture"); await app.sendKeyEvent("w", "down")'
const holdWindowProgram = 'var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.sendKeyEvent("w", "down")'

function reminders(agent: { session: { snapshotEvents(): readonly import('@deepseek-ai/dsh-session').SessionEvent[] } },
  kind: 'cua-held-inputs' | 'cua-inputs-released' = 'cua-held-inputs') {
  return agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === kind)
    .flatMap(event => event.type === 'user/message' ? event.data.content.filter(block => block.type === 'text').map(block => block.text) : [])
}

it('reports native held input after programs, keeps it across turns, and stops reminding after explicit up', async () => {
  const f = await setup([holdProgram, 'inspect("still holding")'], 'macos', undefined, true, true)
  await f.run()
  expect(f.native.held.map(press => press.key)).toEqual(['w'])
  expect(f.native.events).toEqual(['w:down'])
  expect(reminders(f.agent)).toHaveLength(2)
  expect(reminders(f.agent)[0]).toContain('Key "w", appHandle "fixture-app"')
  expect(f.model.requests[1]?.messages.some(message => JSON.stringify(message).includes('CUA inputs are still held'))).toBe(true)
  expect(f.native.calls.some(call => call.method === 'releaseHeldInputs')).toBe(false)
  f.model.restart(['await app.sendKeyEvent("w", "up")'])
  await f.run()
  expect(f.native.events).toEqual(['w:down', 'w:up'])
  expect(reminders(f.agent)).toHaveLength(2)
})

it('reports the Windows keyboard window and desktop input mode and supports a later explicit up', async () => {
  const f = await setup([holdWindowProgram], 'windows', undefined, true, true)
  await f.run()
  expect(f.native.events).toEqual(['w:down'])
  expect(reminders(f.agent)[0]).toContain('Key "w", appHandle "fixture-app", windowId "7" (system input)')
  f.model.restart(['await win.sendKeyEvent("w", "up")'])
  await f.run()
  expect(f.native.events).toEqual(['w:down', 'w:up'])
  expect(reminders(f.agent)).toHaveLength(1)
})

it.each([
  ['run_code', 'confirmed'], ['cua_run_code', 'confirmed'], ['cua_run_code', 'refused'],
] as const)('publishes the %s policy error while subsequent CUA waits for cleanup (%s)', async (tool, cleanup) => {
  const program = (code: string) => tool === 'run_code'
    ? `await tools.cua_run_code({ code: ${JSON.stringify(code)}, description: "Use the fixture" })` : code
  const f = await setup([program(holdProgram)], 'macos', undefined, true, true)
  if (tool === 'run_code') await f.agent.ctx.plugin(PtcToolExecutor)
  f.model.toolName = tool
  const removePolicy = f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === tool
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Policy rejected output' }], info: { name: 'HookError', code: 'HOOK_BLOCKED' } }
    : next(), { prepend: true })
  const calls = vi.spyOn(NativeClient.prototype, 'request')
  onTestFinished(() => { calls.mockRestore() })
  let stoppedAtResult: boolean | undefined
  f.ctx.on('tools/result', (exec, result) => {
    if (exec.name === tool && result.isError) {
      stoppedAtResult = calls.mock.calls.find(([name]) => name === 'sendKeyEvent')?.[2].aborted
    }
  })
  const reported: unknown[] = []
  f.ctx.on('agent/error', ({ error }) => { reported.push(error) })
  const notice = nextReleaseNotice(f)
  const release = f.native.controlNext('releaseHeldInputs')
  const running = f.run()
  await release.entered
  let following: Promise<void>
  const before = f.native.calls.length
  try {
    await running
    expect(stoppedAtResult).toBe(true)
    expect(f.native.held.map(input => input.key)).toEqual(['w'])
    const result = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data).toMatchObject({ error: { code: 'HOOK_BLOCKED' }, message: {
      isError: true, content: [{ type: 'text', text: 'Policy rejected output' }],
    } })
    expect(JSON.stringify(f.model.requests[1]?.messages)).not.toContain('CUA inputs were released')
    expect(reminders(f.agent)).toEqual([])
    removePolicy()
    const admitted: PromiseWithResolvers<void> = Promise.withResolvers()
    f.ctx.on('tools/execute', (exec, next) => {
      const result = next()
      if (exec.name === 'cua') admitted.resolve()
      return result
    })
    f.model.restart([program('await app.sendKeyEvent("d", "down")')])
    following = f.run()
    await admitted.promise
    expect(f.native.calls.length).toBe(before)
  } finally {
    release.reply(cleanup === 'refused' ? { code: 'INPUT_CLEANUP_FAILED', message: 'Fixture refused release' } : undefined)
  }
  await following
  if (cleanup === 'confirmed') {
    await notice
    expect(f.native.events).toEqual(['w:down', 'w:up', 'd:down'])
    expect(JSON.stringify(f.model.requests.at(-1)?.messages)).toContain('CUA inputs were released during cleanup')
  } else {
    expect(reported).toEqual([expect.objectContaining({ code: 'INPUT_CLEANUP_FAILED' })])
    expect(f.native.calls.length).toBe(before)
    expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('INPUT_CLEANUP_UNCONFIRMED')
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'cua-inputs-released'))).toBe(false)
  }
})

it('cleans up a rejected nested program even when its enclosing run_code handles the failure', async () => {
  const f = await setup([`try { await tools.cua_run_code({ code: ${JSON.stringify(holdProgram)}, description: "Hold W" }) } catch { inspect("handled") }`],
    'macos', undefined, true, true)
  await f.agent.ctx.plugin(PtcToolExecutor)
  f.model.toolName = 'run_code'
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'cua_run_code' && exec.parent
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Nested policy refusal' }] } : next())
  await f.run()
  expect(f.native.events).toEqual(['w:down', 'w:up'])
  expect(f.agent.session.snapshotEvents().find(event => event.type === 'tool/result')?.data.message.isError).toBe(false)
})

it('a late policy refusal closes only the owner captured by that execution', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish: PromiseWithResolvers<void> = Promise.withResolvers()
  f.ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.callId !== 'cua-program-1') return next()
    entered.resolve()
    await finish.promise
    return { kind: 'block', feedback: [{ type: 'text', text: 'Late refusal' }] }
  })
  const running = f.run()
  await entered.promise
  const openedChannels = f.native.state.openedChannels
  const execute = (id: string, code: string) => f.ctx.agents.withInitiator(f.agent, () => f.ctx.tools.execute({
    agent: f.agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: brandString<ToolCallId>(id), name: 'cua_run_code', arguments: JSON.stringify({ code, description: id }) }],
  }))
  try {
    await f.ctx.cuaPrograms.releaseInputs(f.agent)
    expect((await execute('hold-d', 'await app.sendKeyEvent("d", "down")')).results[0]?.result.isError).toBe(false)
    f.ctx.on('tools/pre-execute', async (exec, next) => exec.callId === 'denied'
      ? { kind: 'deny', reason: 'Not admitted' } : next())
    expect((await execute('denied', 'inspect("unused")')).results[0]?.result.isError).toBe(true)
  } finally { finish.resolve(); await running }
  expect((await execute('release-d', 'await app.sendKeyEvent("d", "up")')).results[0]?.result.isError).toBe(false)
  expect(f.native.events).toEqual(['w:down', 'w:up', 'd:down', 'd:up'])
  expect(f.native.state.openedChannels).toBe(openedChannels)
  expect(f.native.calls.filter(call => call.method === 'releaseHeldInputs')).toHaveLength(1)
})

it('releases keyboard and mouse in mixed reverse order on program failure', async () => {
  const f = await setup([holdProgram,
    'await app.sendKeyEvent("shift", "down"); var win = await app.getWindow("7"); await win.toggleMouse("left", "down"); await app.sendKeyEvent("d", "down"); throw Error("program failed")', 'inspect("recovered")'],
  'macos', undefined, true, true)
  await f.run()
  expect(f.native.events).toEqual(['w:down', 'shift:down', 'left:down', 'd:down', 'd:up', 'left:up', 'shift:up', 'w:up'])
  expect(f.native.held).toEqual([])
  expect(reminders(f.agent)).toHaveLength(1)
  expect(f.native.calls.filter(call => call.method === 'releaseHeldInputs')).toHaveLength(1)
  const results = f.agent.session.deriveMessages().filter(message => message.role === 'tool')
  expect(results.map(result => result.isError)).toEqual([false, true, false])
})

it('releases a previous hold when downstream execution throws before producing a result', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  await f.run()
  f.model.restart(['inspect("unreachable")'])
  f.ctx.on('tools/execute', (execution, next) => {
    if (execution.name === 'cua_run_code') throw new Error('Executor middleware failed')
    return next()
  })
  await f.run()
  expect(f.native.events).toEqual(['w:down', 'w:up'])
  expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('Executor middleware failed')
})

it('reminders name the actual mouse target and omit explicitly released inputs', async () => {
  const f = await setup([holdProgram, 'await app.sendKeyEvent("w", "up"); var win = await app.getWindow("7"); await win.toggleMouse("left", "down")'],
    'macos', undefined, true, true)
  await f.run()
  expect(reminders(f.agent)[1]).toContain('Mouse left, appHandle "fixture-app", windowId "7" (window input)')
  expect(reminders(f.agent)[1]).not.toContain('Key "w"')
  await f.handle.dispose()
  expect(f.native.held).toEqual([])
})

function nextReleaseNotice(f: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const recorded: PromiseWithResolvers<void> = Promise.withResolvers()
  f.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === f.agent && message.source.kind === 'cua-inputs-released') recorded.resolve()
  })
  return recorded.promise
}

it.each([
  ['model failure', 'confirmed'],
  ['thinking stop', 'confirmed'],
  ['thinking stop', 'refused'],
] as const)('returns to idle after %s while new CUA input waits for cleanup (%s)', async (ending, outcome) => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const thinking: PromiseWithResolvers<void> = Promise.withResolvers()
  if (ending === 'model failure') {
    await f.run()
    f.model.restart([])
  }
  f.model.beforeStream = async (index, options) => {
    if (ending === 'model failure') throw new Error('Model failed with W held from an earlier turn')
    if (index !== 1) return
    thinking.resolve()
    const signal = options.signal!
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }
  const release = f.native.controlNext('releaseHeldInputs')
  const notice = nextReleaseNotice(f).then(() => [...f.native.events])
  const reported: PromiseWithResolvers<unknown> = Promise.withResolvers()
  f.ctx.on('agent/error', ({ error }) => {
    if (error instanceof Error && error.message.includes('Release refused after idle')) reported.resolve(error)
  })
  const idle = f.run()
  if (ending === 'thinking stop') { await thinking.promise; f.agent.cancel({ kind: 'user' }, { keepInbox: true }) }
  await release.entered
  let following: Promise<void>
  const before = f.native.calls.length
  try {
    await idle
    expect(f.native.held.map(press => press.key)).toEqual(['w'])
    expect(f.agent.inbox.nextStep.some(message => message.source.kind === 'cua-inputs-released')).toBe(false)
    const terminal = f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(terminal?.data.reason.kind).toBe(ending === 'thinking stop' ? 'aborted' : 'error')

    const admitted: PromiseWithResolvers<void> = Promise.withResolvers()
    f.ctx.on('tools/execute', (execution, next) => {
      const result = next()
      if (execution.name === 'cua') admitted.resolve()
      return result
    })
    delete f.model.beforeStream
    f.model.restart(['await app.sendKeyEvent("d", "down")'])
    following = f.run()
    await admitted.promise
    expect(f.native.calls).toHaveLength(before)
  } finally {
    release.reply(outcome === 'refused' ? { code: 'INPUT_CLEANUP_FAILED', message: 'Release refused after idle' } : undefined)
  }
  await following
  if (outcome === 'confirmed') {
    expect(await notice).toEqual(['w:down', 'w:up'])
    expect(f.native.events).toEqual(['w:down', 'w:up', 'd:down'])
  } else {
    expect(await reported.promise).toMatchObject({ code: 'INPUT_CLEANUP_FAILED' })
    expect(f.native.calls).toHaveLength(before)
    expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('INPUT_CLEANUP_UNCONFIRMED')
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'cua-inputs-released'))).toBe(false)
  }
})

it('cancels an in-flight down before releasing input and allows later programs after confirmed cleanup', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const down = f.native.controlNext('sendKeyEvent', { afterDispatch: true, waitForCancellation: true })
  let finished = false
  const running = f.run().then(() => { finished = true })
  await down.entered
  f.agent.cancel({ kind: 'user' })
  await down.cancelled
  expect(f.native.held.map(press => press.key)).toEqual(['w'])
  expect(f.native.calls.some(call => call.method === 'releaseHeldInputs')).toBe(false)
  const release = f.native.controlNext('releaseHeldInputs')
  down.reply({ code: 'NATIVE_CANCELLED', message: 'Stopped after dispatch' })
  await release.entered
  try { expect(finished).toBe(false) } finally { release.reply() }
  await running
  expect(f.native.held).toEqual([])
  f.model.requests.length = 0
  await f.run()
  expect(f.native.held.map(press => press.key)).toEqual(['w'])
  expect(f.native.events.filter(event => event === 'w:up')).toHaveLength(1)
})

it.each(['refusal', 'disconnect', 'timeout'] as const)('reports cleanup %s and disables further CUA operations', async (failure) => {
  const f = await setup([holdProgram + '; throw Error("program failed")'], 'macos', undefined, true, true, failure === 'timeout' ? 200 : 30_000)
  const errors: unknown[] = []
  f.ctx.on('agent/error', (event) => { errors.push(event.error) })
  const release = f.native.controlNext('releaseHeldInputs')
  const running = f.run()
  await release.entered
  if (failure === 'refusal') release.reply({ code: 'INPUT_CLEANUP_FAILED', message: 'Release rejected' })
  if (failure === 'disconnect') release.disconnect()
  await running
  expect(errors).toHaveLength(1)
  const count = f.native.calls.length
  f.model.requests.length = 0
  await f.run()
  expect(f.native.calls).toHaveLength(count)
  expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('INPUT_CLEANUP_UNCONFIRMED')
})

it('reports failed native state inspection and releases held input instead of claiming it is empty', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const query = f.native.controlNext('getHeldInputs')
  const running = f.run()
  await query.entered
  query.reply({ code: 'NATIVE_ERROR', message: 'Held state unavailable' })
  await running
  expect(reminders(f.agent)).toEqual([])
  expect(f.native.held).toEqual([])
  expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('Held state unavailable')
})

it.each(['closes', 'fails to close'] as const)('waits for Agent release before the Windows helper runtime %s', async (outcome) => {
  const failure = new Error('Windows helper lease could not close')
  const disposed = vi.fn(async (state: { closedChannels: number }) => {
    expect(state.closedChannels).toBe(1)
    if (outcome === 'fails to close') throw failure
  })
  const f = await setup([holdWindowProgram], 'windows', undefined, true, true, undefined, disposed)
  const report = vi.spyOn(f.provider.ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { report.mockRestore() })
  await f.run()
  const release = f.native.controlNext('releaseHeldInputs')
  const closing = f.provider.dispose()
  await release.entered
  try { expect(disposed).not.toHaveBeenCalled() } finally { release.reply() }
  await closing
  expect(disposed).toHaveBeenCalledOnce()
  expect(f.native.held).toEqual([])
  if (outcome === 'fails to close') expect(report).toHaveBeenCalledWith(expect.objectContaining({ errors: [failure] }))
  else expect(report).not.toHaveBeenCalled()
})

it.each([
  ['model error', 'confirmed'], ['model error', 'refused'], ['post-policy error', 'confirmed'], ['post-policy error', 'refused'],
] as const)('joins background cleanup on concurrent provider disposal (%s, %s)', async (ending, outcome) => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  if (ending === 'model error') f.model.beforeStream = async (index) => { if (index === 1) throw new Error('Model failed') }
  else f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'cua_run_code'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Policy rejected output' }] } : next())
  const errors: unknown[] = []
  f.ctx.on('agent/error', ({ error }) => { errors.push(error) })
  const registered = vi.spyOn(NativeClient.prototype, 'registerCleanup')
  onTestFinished(() => { registered.mockRestore() })
  const release = f.native.controlNext('releaseHeldInputs')
  const idle = f.run()
  await release.entered
  await idle

  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const [client] = registered.mock.contexts
  if (!(client instanceof NativeClient)) throw new Error('Expected a native connection with a registered input owner')
  client.registerCleanup(async () => { entered.resolve() })
  let disposed = false
  const closing = f.provider.dispose().then(() => { disposed = true })
  try {
    await entered.promise
    expect(disposed).toBe(false)
    expect(f.native.state.closedChannels).toBe(0)
  } finally {
    release.reply(outcome === 'refused' ? { code: 'INPUT_CLEANUP_FAILED', message: 'Release refused during disposal' } : undefined)
    await closing
  }
  expect(f.native.calls.filter(call => call.method === 'releaseHeldInputs')).toHaveLength(1)
  expect(f.native.state.closedChannels).toBe(1)
  if (outcome === 'confirmed') expect(f.native.events).toEqual(['w:down', 'w:up', 'native-close'])
  else {
    expect(errors).toContainEqual(expect.objectContaining({ code: 'INPUT_CLEANUP_FAILED' }))
    expect(f.agent.inbox.nextStep.some(message => message.source.kind === 'cua-inputs-released')).toBe(false)
  }
})

it.each(['agent', 'provider', 'context'] as const)('awaits native release when the %s is disposed after a completed turn', async (owner) => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  await f.run()
  expect(f.native.held).toHaveLength(1)
  const release = f.native.controlNext('releaseHeldInputs')
  let disposed = false
  const closing = (owner === 'agent' ? f.handle.dispose() : owner === 'provider' ? f.provider.dispose() : f.ctx.fiber.dispose()).then(() => { disposed = true })
  await release.entered
  expect(disposed).toBe(false)
  expect(f.native.state.closedChannels).toBe(0)
  release.reply()
  await closing
  expect(f.native.held).toEqual([])
  expect(f.native.state.closedChannels).toBe(1)
})

it('leaves providers without held-input state support on their existing protocol', async () => {
  const f = await setup([holdWindowProgram, 'await win.sendKeyEvent("w", "up")'], 'windows', undefined, true)
  await f.run()
  for (const call of f.native.calls.filter(call => call.method === 'sendKeyEvent')) expect(call.params).not.toHaveProperty('taskId')
  expect(f.native.calls.some(call => ['getHeldInputs', 'releaseHeldInputs'].includes(call.method))).toBe(false)
  expect(reminders(f.agent)).toEqual([])
})

it('reports and releases only the owning task inputs', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const peerModel = new ProgramModel([holdProgram.replace('"w"', '"d"')])
  f.ctx.llm.registerAdapter(['peer-fixture'], peerModel)
  const peer = await f.ctx.agents.create({ sessionId: brandString<SessionId>('peer-held-input'), meta: { cwd: process.cwd() },
    agentOptions: { provider: 'peer-fixture', model: 'vision' } })
  await f.run()
  peer.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hold D' }], source: { kind: 'user' } }))
  await peer.agent.whenIdle()
  expect(reminders(f.agent).join('')).not.toContain('Key "d"')
  expect(reminders(peer.agent).join('')).not.toContain('Key "w"')
  await f.handle.dispose()
  expect(f.native.held.map(press => press.key)).toEqual(['d'])
  await peer.dispose()
  expect(f.native.held).toEqual([])
})

it('reports native connection loss after a dispatched down and rejects further input', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const down = f.native.controlNext('sendKeyEvent', { afterDispatch: true })
  const running = f.run()
  await down.entered
  down.disconnect()
  await running
  expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('INPUT_CLEANUP_UNCONFIRMED')
  const calls = f.native.calls.length
  f.model.restart([holdProgram])
  await f.run()
  expect(f.native.calls).toHaveLength(calls)
})

it('waits and reports cleanup refusal when user stop arrives as the program returns', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  f.ctx.on('tools/execute', async (execution, next) => {
    const result = await next()
    if (execution.name === 'cua_run_code' && execution.parent === undefined) f.agent.cancel({ kind: 'user' })
    return result
  })
  const release = f.native.controlNext('releaseHeldInputs')
  const running = f.run()
  await release.entered
  release.reply({ code: 'INPUT_CLEANUP_FAILED', message: 'Release refused during stop' })
  await running
  expect(JSON.stringify(f.agent.session.deriveMessages())).toContain('Release refused during stop')
})

it('emits only the final outer reminder for a nested CUA program', async () => {
  const f = await setup([`await tools.cua_run_code({ code: ${JSON.stringify(holdProgram)}, description: "Hold W" })`], 'macos', undefined, true, true)
  await f.agent.ctx.plugin(PtcToolExecutor)
  f.model.toolName = 'run_code'
  await f.run()
  expect(reminders(f.agent)).toHaveLength(1)
  expect(f.native.calls.filter(call => call.method === 'getHeldInputs')).toHaveLength(1)
  expect(f.native.held.map(press => press.key)).toEqual(['w'])
})

it('ignores turn endings from Sessions without an Agent', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  await f.run()
  const session = f.ctx.sessions.create(brandString<SessionId>('unattached-input-session'))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Unrelated failure' } } })
  expect(f.native.held.map(press => press.key)).toEqual(['w'])
})

it('records release after a thinking pause so the resumed model sees the new input state', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const thinking: PromiseWithResolvers<void> = Promise.withResolvers()
  f.model.beforeStream = async (index, options) => {
    if (index !== 1) return
    thinking.resolve()
    await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
  }
  const release = f.native.controlNext('releaseHeldInputs')
  const notice = nextReleaseNotice(f)
  const running = f.run()
  await thinking.promise
  f.agent.cancel({ kind: 'user' })
  await release.entered
  release.reply()
  await Promise.all([running, notice])
  expect(f.native.held).toEqual([])
  expect(f.agent.inbox.nextStep.some(message => message.source.kind === 'cua-inputs-released')).toBe(true)
  delete f.model.beforeStream
  f.model.restart(['inspect("resumed")'])
  await f.run()
  expect(reminders(f.agent, 'cua-inputs-released')).toHaveLength(1)
  expect(JSON.stringify(f.model.requests[0]?.messages)).toContain('CUA inputs were released during cleanup')
})

it('removes a pending held reminder when a pause preserves the inbox', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const inserted: PromiseWithResolvers<void> = Promise.withResolvers()
  f.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent !== f.agent || message.source.kind !== 'cua-held-inputs') return
    inserted.resolve()
    agent.cancel({ kind: 'user' }, { keepInbox: true })
  })
  const release = f.native.controlNext('releaseHeldInputs')
  const notice = nextReleaseNotice(f)
  const running = f.run()
  await inserted.promise
  await release.entered
  f.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Keep this pending instruction' }], source: { kind: 'user' } }))
  release.reply()
  await Promise.all([running, notice])
  expect(f.agent.inbox.nextStep.map(message => message.source.kind)).toContain('cua-inputs-released')
  expect(f.agent.inbox.nextStep.map(message => message.source.kind)).not.toContain('cua-held-inputs')
  f.model.restart(['inspect("resumed")'])
  await f.run()
  const resumed = JSON.stringify(f.model.requests[0]?.messages)
  expect(resumed).toContain('Keep this pending instruction')
  expect(resumed).toContain('CUA inputs were released during cleanup')
  expect(resumed).not.toContain('CUA inputs are still held')
})

it('drops a delayed held-state reminder after cancellation has already released the input', async () => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const post: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish: PromiseWithResolvers<void> = Promise.withResolvers()
  const released: PromiseWithResolvers<void> = Promise.withResolvers()
  f.ctx.on('tools/post-execute', async (execution, _result, next) => {
    const decision = await next()
    if (execution.name === 'cua_run_code' && execution.parent === undefined) { post.resolve(); await finish.promise }
    return decision
  })
  f.ctx.on('session/event', (_session, event) => {
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'cua-inputs-released')) released.resolve()
  })
  const running = f.run()
  await post.promise
  try {
    f.agent.cancel({ kind: 'user' })
    await released.promise
    expect(f.native.held).toEqual([])
  } finally { finish.resolve(); await running }
  expect(f.agent.inbox.nextStep.some(message => message.source.kind === 'cua-held-inputs')).toBe(false)
  f.model.restart(['inspect("resumed")'])
  await f.run()
  expect(reminders(f.agent)).toEqual([])
  expect(reminders(f.agent, 'cua-inputs-released')).toHaveLength(1)
})

it.each(['reply before stop', 'stop before reply'] as const)('does not report held input on %s', async (order) => {
  const f = await setup([holdProgram], 'macos', undefined, true, true)
  const query = f.native.controlNext('getHeldInputs', { afterDispatch: true, waitForCancellation: order === 'stop before reply' })
  const running = f.run()
  await query.entered
  if (order === 'reply before stop') query.reply()
  f.agent.cancel({ kind: 'user' })
  if (order === 'stop before reply') {
    await query.cancelled
    query.reply({ code: 'NATIVE_CANCELLED', message: 'Held-state query cancelled' })
  }
  await running
  expect(f.native.held).toEqual([])
  expect(f.agent.inbox.nextStep.some(message => message.source.kind === 'cua-held-inputs')).toBe(false)
})

it('reports notice-write failure without treating confirmed native release as unknown', async () => {
  const f = await setup([holdProgram + '; throw Error("failed program")'], 'macos', undefined, true, true)
  const errors: unknown[] = []
  f.ctx.on('agent/error', (event) => { errors.push(event.error) })
  const inject = vi.spyOn(f.agent, 'inject').mockImplementationOnce(() => { throw new Error('Notice write failed') })
  onTestFinished(() => { inject.mockRestore() })
  await f.run()
  expect(errors).toEqual([expect.objectContaining({ code: 'INPUT_NOTICE_FAILED' })])
  expect(f.native.held).toEqual([])
  f.model.restart([holdProgram])
  await f.run()
  expect(f.native.held.map(press => press.key)).toEqual(['w'])
})
