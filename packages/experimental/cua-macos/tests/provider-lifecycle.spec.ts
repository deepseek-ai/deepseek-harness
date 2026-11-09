/** Native helper replacement is synchronized with Agent and provider disposal. */
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Hmr from '@deepseek-ai/dsh-hmr'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'
import { CuaConfig, installCua } from '@deepseek-ai/dsh-cua'
import { createConfigProjector } from '@deepseek-ai/dsh-app-boot/src/config-schema/projector.ts'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import UserQuestions, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { LlmAdapter, ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import sharp from 'sharp'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import * as NativeProvider from '../src/index.ts'
import type { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import type { NativeBuildSpec } from '../src/native-build.ts'

const native = vi.hoisted(() => ({
  connect: vi.fn<typeof import('../src/shared-native.ts')['createSharedNativeChannel']>(),
  prepare: vi.fn<(spec: NativeBuildSpec) => Promise<string>>(),
  architecture: vi.fn(() => 'arm64' as const),
  cleanup: vi.fn<NativeClient['requestCleanup']>(),
  request: vi.fn<NativeClient['request']>(), dispose: vi.fn(), instances: [] as Array<{ disposed: boolean }>,
  reportDiagnostic: undefined as ((message: string) => void) | undefined,
}))
vi.mock('../src/shared-native.ts', () => ({ createSharedNativeChannel: native.connect }))
vi.mock('../src/native-build.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/native-build.ts')>(),
  nativeHostArchitecture: native.architecture,
  prepareNativeExecutable: native.prepare,
}))
vi.mock('@deepseek-ai/dsh-cua/native-client', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-cua/native-client')>(),
  NativeClient: class {
    disposed = false
    constructor(...args: ConstructorParameters<typeof NativeClient>) {
      args[2](args[0], args[1])
      native.reportDiagnostic = args[3]
      native.instances.push(this)
    }
    requestCleanup = native.cleanup
    request = native.request
    invalidate() { this.disposed = true }
    async dispose() { this.disposed = true; await native.dispose() }
  },
}))

const config = {
  permissionPollIntervalMs: 1000, requireSystemPointerApproval: true,
  agentPreset: false,
  helperPath: resolve('fixture-helper'), sourceSigning: 'ad-hoc', buildTimeoutMs: 300_000, timeoutMs: 10_000, connectTimeoutMs: 5000, screenshotTimeoutMs: 5000, axTimeoutMs: 3000, maxRequestBytes: 1024, maxResponseBytes: 4096, maxClipboardBytes: 8192, pasteReadTimeoutMs: 1000, maxAppMatches: 20,
  graceMs: 10, textEventIntervalMs: 8, maxClickHoldMs: 7000, maxElements: 64, maxDepth: 8, dragDurationMs: 200, dragSteps: 10,
} satisfies Omit<NativeProvider.Config, 'allowedApps'>

const { helperPath: _helperPath, ...automaticConfig } = config

it('defaults to ad-hoc signing and requires a keychain path for certificate signing', () => {
  expect(NativeProvider.Config({}).sourceSigning).toBe('ad-hoc')
  expect(NativeProvider.Config({}).requireSystemPointerApproval).toBe(true)
  expect(NativeProvider.Config({ sourceSigning: 'ad-hoc' }).sourceSigning).toBe('ad-hoc')
  for (const sourceSigning of [{ identity: 'Apple Development: Example', keychain: '/keychains/custom.keychain-db' }, { identity: 'ABC123', keychain: '/keychains/custom.keychain-db' }]) {
    expect(NativeProvider.Config({ sourceSigning }).sourceSigning).toEqual(sourceSigning)
  }
  for (const sourceSigning of ['local-identity', 'developer-id', {}, { identity: 'Example' }, { identity: '' }, { identity: ' ' }, { identity: 'Example', keychain: 'relative' }, ...['-', '--help', '-Example', ' Example'].map(identity => ({ identity, keychain: '/keychains/custom.keychain-db' }))]) {
    expect(() => NativeProvider.Config({ sourceSigning } as never)).toThrow()
  }
})

it('projects shared controls and macOS signing without adding signing to the shared schema', async () => {
  const project = await createConfigProjector()
  const projected = project(NativeProvider.Config, 'cua-macos')
  for (const field of ['sourceSigning', 'permissionPollIntervalMs', 'agentPreset', 'helperPath']) {
    expect(projected.schema.anyOf?.[0]).toHaveProperty(`properties.${field}`)
  }
  expect(CuaConfig({})).not.toHaveProperty('sourceSigning')
  expect(CuaConfig.dict).not.toHaveProperty('sourceSigning')
  expect(NativeProvider.Config({ sourceSigning: 'ad-hoc', timeoutMs: 1234 })).toMatchObject({
    agentPreset: 'ptc', sourceSigning: 'ad-hoc', permissionPollIntervalMs: 1000, timeoutMs: 1234,
  })
})

it('defaults the explicit click hold limit to five seconds and accepts a configured zero or larger limit', () => {
  expect(NativeProvider.Config({}).maxClickHoldMs).toBe(5000)
  for (const maxClickHoldMs of [0, 7000]) expect(NativeProvider.Config({ maxClickHoldMs }).maxClickHoldMs).toBe(maxClickHoldMs)
  for (const maxClickHoldMs of [-1, 0.5, 2 ** 31]) expect(() => NativeProvider.Config({ maxClickHoldMs })).toThrow()
})

class ImageAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  stream(): AsyncIterable<StreamChunk> { throw new Error('This direct tool test does not request model generation') }
}

const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const imageMetadata = { pixelWidth: 1, pixelHeight: 1, bounds: { x: 2, y: 3, width: 1, height: 1 }, coordinateSpace: 'window-points', windowId: 7 }

async function setup(model?: { provider: string; model: string }, ptc = false) {
  native.connect.mockClear()
  native.cleanup.mockReset().mockResolvedValue({ dispatched: true })
  native.request.mockReset().mockResolvedValue([])
  native.dispose.mockReset()
  native.instances.length = 0
  native.reportDiagnostic = undefined
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, ptc ? { workingDirectory: true, tools: { mode: 'ptc' } } : {})
  await ctx.plugin(ComputerUseRegistry)
  if (ptc) {
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(Sandbox)
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
    await ctx.plugin(NodeRuntime)
  } else await ctx.plugin(Subprocess, [])
  const provider = await ctx.plugin(NativeProvider, config)
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId('native-lifecycle'), meta: { cwd: process.cwd() }, ...model ? { agentOptions: model } : {} })
  let index = 0
  const execute = (method = 'listApps', params: Record<string, unknown> = {}, signal = new AbortController().signal) => executeToolFixture(ctx, {
    agent: handle.agent, signal, callId: ToolCallId(`lifecycle-${++index}`), name: 'cua', arguments: { method, params },
  })
  return { ctx, provider, handle, execute }
}

async function selectApplication(f: Awaited<ReturnType<typeof setup>>) {
  await f.ctx.plugin(UserQuestions)
  f.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] }))
  native.request.mockResolvedValueOnce({ appHandle: 'app-one', name: 'Fixture', running: true,
    authorization: { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: false } })
  expect((await f.execute('getApp', { selector: 'Fixture' })).isError).toBe(false)
}

it('requires an enclosing run_code before sending a directional key', async () => {
  const f = await setup()
  await selectApplication(f)
  native.request.mockClear()
  const result = await f.execute('sendKeyEvent', { appHandle: 'app-one', key: 'w', direction: 'down' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('active run_code')
  expect(native.request).not.toHaveBeenCalled()
})

it('finishes a shortcut-only run_code without requesting held-key cleanup', async () => {
  const f = await setup(undefined, true)
  await selectApplication(f)
  native.request.mockClear().mockResolvedValue({ dispatched: true })
  const result = await executeModelToolFixture(f.ctx, { agent: f.handle.agent, callId: ToolCallId('shortcut-run'),
    name: 'run_code', signal: new AbortController().signal, arguments: {
      code: "return await tools.cua({ method: 'pressKey', params: { appHandle: 'app-one', key: 'a', modifiers: ['command'] } });",
      description: 'Press Command+A',
    } })
  expect(result.isError).toBe(false)
  expect(native.request.mock.calls.map(([method]) => method)).toEqual(['pressKey'])
  expect(native.cleanup).not.toHaveBeenCalled()
})

it.each(['return', 'throw', 'pause', 'pause with cleanup error'])('cleans up only the held W when run_code ends by %s', async (ending) => {
  const f = await setup(undefined, true)
  await selectApplication(f)
  const held = new Set<string>()
  const events: string[] = []
  const controller = new AbortController()
  const runIds = new Set<unknown>()
  native.request.mockImplementation(async (method, params) => {
    expect(method).toBe('sendKeyEvent')
    runIds.add(params.runId)
    const { key, direction } = params
    if (typeof key !== 'string' || (direction !== 'down' && direction !== 'up')) throw new Error('Invalid directional event')
    if (direction === 'down') held.add(key)
    else held.delete(key)
    events.push(`${key}:${direction}`)
    return { dispatched: true }
  })
  native.cleanup.mockImplementation(async (method, params) => {
    expect(method).toBe('releaseHeldKeys')
    expect(runIds).toEqual(new Set([params.runId]))
    if (ending === 'pause with cleanup error') throw new Error('release acknowledgement failed')
    for (const key of held) events.push(`${key}:up`)
    held.clear()
    return { dispatched: true }
  })
  f.ctx.tools.register({
    name: 'check_held_keys', description: 'Observe the keys held by the test receiver.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [] },
    async execute() {
      const keys = [...held]
      if (ending.startsWith('pause') && keys.length === 1) {
        controller.abort()
        await setImmediate()
        expect(held.size).toBe(ending === 'pause' ? 0 : 1)
      }
      return keys
    },
  })
  const code = [
    "const key = (key, direction) => tools.cua({ method: 'sendKeyEvent', params: { appHandle: 'app-one', key, direction } });",
    "await key('w', 'down'); await key('d', 'down');",
    "if ((await tools.check_held_keys({})).join(',') !== 'w,d') throw Error('lost held keys');",
    "await key('d', 'up');",
    "if ((await tools.check_held_keys({})).join(',') !== 'w') throw Error('lost W');",
    ending === 'throw' ? "throw Error('program failed');" : "return 'done';",
  ].join('\n')
  const result = await executeModelToolFixture(f.ctx, { agent: f.handle.agent, callId: ToolCallId('keyboard-run'),
    name: 'run_code', arguments: { code, description: 'Exercise held keys' }, signal: controller.signal })
  expect(events, JSON.stringify(result.content)).toEqual(['w:down', 'd:down', 'd:up', ...ending === 'pause with cleanup error' ? [] : ['w:up']])
  expect(native.cleanup).toHaveBeenCalledTimes(1)
  expect(result.isError).toBe(ending !== 'return')
  if (ending === 'throw') expect(JSON.stringify(result.content)).toContain('program failed')
})

it('rejects a relative helper path before publishing computer-use operations', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await expect(NativeProvider.apply(ctx, { ...config, allowedApps: [], helperPath: 'relative-helper' })).rejects.toThrow('helperPath must be absolute')
})

it.each(['Allow for this session', 'Deny'])('obtains %s before a stopped application can launch', async (choice) => {
  const f = await setup()
  await f.ctx.plugin(UserQuestions)
  const asked: PromiseWithResolvers<void> = Promise.withResolvers()
  const answer = Promise.withResolvers<{ answers: Array<{ id: string; selected: string[] }> }>()
  onTestFinished(() => { answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] }) })
  f.ctx.on('user-questions/request', async () => { asked.resolve(); return answer.promise })
  native.request.mockImplementation(async (method: string) => method === 'getApp'
    ? { appHandle: 'pending-app', name: 'Fixture', running: false, authorization: {
      id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: false,
    } }
    : { appHandle: 'pending-app', name: 'Fixture', running: true })
  const pending = f.execute('getApp', { selector: 'Fixture' })
  await asked.promise
  expect(native.request.mock.calls.map(call => call[0])).toEqual(['getApp'])
  answer.resolve({ answers: [{ id: 'cua-app-access', selected: [choice] }] })
  const result = await pending
  expect(result.isError).toBe(choice === 'Deny')
  expect(native.request.mock.calls.map(call => call[0])).toEqual(choice === 'Deny' ? ['getApp'] : ['getApp', 'launchApp'])
  if (choice !== 'Deny') expect(result.value).toMatchObject({ appHandle: 'pending-app', running: true })
})

it('rejects a launch result that changes the approved handle', async () => {
  const f = await setup()
  await f.ctx.plugin(UserQuestions)
  f.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] }))
  native.request.mockResolvedValueOnce({ appHandle: 'pending-app', name: 'Fixture', running: false, authorization: {
    id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: false,
  } }).mockResolvedValueOnce({ appHandle: 'another-app', name: 'Fixture', running: true })
  const result = await f.execute('getApp', { selector: 'Fixture' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('another handle')
})

it('rejects a model attempt to call the private launch operation', async () => {
  const f = await setup()
  expect((await f.execute('launchApp', { appHandle: 'unapproved' })).isError).toBe(true)
  expect(native.request).not.toHaveBeenCalled()
})

it('correlates a native request with its logged tool invocation', async () => {
  const f = await setup()
  expect((await f.execute()).isError).toBe(false)
  expect(native.request).toHaveBeenCalledExactlyOnceWith('listApps', {}, expect.any(AbortSignal), ToolCallId('lifecycle-1'))
})

it('merges startup capabilities into runtime native fields', async () => {
  const f = await setup()
  const runtime = { permissions: { accessibility: true, screenRecording: false }, sessionLocked: false }
  native.request.mockResolvedValueOnce(runtime)
  const result = await f.execute('getCapabilities')
  expect(result.isError).toBe(false)
  expect(result.value).toEqual({ ...runtime, platform: 'macos', systemPointer: true, appLevelAccessibility: true, keyboard: ['app'], browser: false,
    coordinateSpace: 'screenshot-pixels', methods: [
      'activate', 'click', 'drag', 'findApps', 'getApp', 'getCapabilities', 'getState', 'invoke',
      'listActions', 'listApps', 'listWindows', 'mouseMove', 'paste', 'performAction', 'pressKey', 'screenshot', 'scroll',
      'selectText', 'sendKeyEvent', 'setValue', 'show', 'typeText',
    ] })
  expect(native.request).toHaveBeenCalledExactlyOnceWith('getCapabilities', {}, expect.any(AbortSignal), ToolCallId('lifecycle-1'))
})

it('sends native diagnostics to the Host logger without changing the tool result', async () => {
  const f = await setup()
  const messages: string[] = []
  const debug = vi.spyOn(f.provider.ctx.logger, 'debug').mockImplementation((message: unknown) => { messages.push(String(message)) })
  onTestFinished(() => { debug.mockRestore() })
  const result = await f.execute()
  native.reportDiagnostic?.('fixture screenshot phase')
  expect(messages).toEqual(['fixture screenshot phase'])
  expect(JSON.stringify(result)).not.toContain('fixture screenshot phase')
})

it('rejects helper acquisition when Agent disposal begins during replacement cleanup', async () => {
  const f = await setup()
  await f.execute()
  const previous = native.instances[0]
  if (!previous) throw new Error('No helper was acquired')
  previous.disposed = true
  const acquisition: PromiseWithResolvers<void> = Promise.withResolvers()
  const disposal: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  let calls = 0
  native.dispose.mockImplementation(async () => {
    if (++calls === 1) acquisition.resolve()
    else disposal.resolve()
    await release.promise
  })
  onTestFinished(() => { release.resolve() })
  const reacquiring = f.execute()
  await acquisition.promise
  const disposing = f.handle.dispose()
  try {
    await disposal.promise
    release.resolve()
    expect((await reacquiring).isError).toBe(true)
    await disposing
    expect(native.instances).toHaveLength(1)
    expect(native.request).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); await disposing; await reacquiring }
})

it('aborts pending replacement before provider disposal can finish', async () => {
  const f = await setup()
  await f.execute()
  const previous = native.instances[0]
  if (!previous) throw new Error('No helper was acquired')
  previous.disposed = true
  const acquisition: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementation(async () => { acquisition.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  const reacquiring = f.execute()
  await acquisition.promise
  let disposed = false
  const disposing = f.provider.dispose().then(() => { disposed = true })
  try {
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    expect((await reacquiring).isError).toBe(true)
    await disposing
    expect(native.instances).toHaveLength(1)
    expect(f.ctx.tools.schemas()).toEqual([])
  } finally { release.resolve(); await disposing; await reacquiring }
})

it('replaces a failed helper before dispatching the next operation', async () => {
  const f = await setup()
  await f.execute()
  const previous = native.instances[0]
  if (!previous) throw new Error('No helper was acquired')
  previous.disposed = true
  expect((await f.execute()).isError).toBe(false)
  expect(native.dispose).toHaveBeenCalledTimes(1)
  expect(native.instances).toHaveLength(2)
})

it('keeps Agent disposal pending until its helper cleanup completes', async () => {
  const f = await setup()
  await f.execute()
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementation(async () => { started.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  let disposed = false
  const disposing = f.handle.dispose().then(() => { disposed = true })
  try {
    await started.promise
    // Drain this turn's promise continuations while cleanup remains held by the explicit barrier.
    await setImmediate()
    expect(disposed).toBe(false)
    release.resolve()
    await disposing
    expect(disposed).toBe(true)
  } finally { release.resolve(); await disposing }
})

it('retains the computer-use registration until permission helper cleanup settles', async () => {
  const f = await setup()
  native.request.mockResolvedValue({ platform: 'darwin' as const, accessibility: false, screenRecording: false, helper: { pid: 9 }, parent: { pid: 8 } })
  await f.ctx.cuaAccess.systemStatus()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  native.dispose.mockImplementation(async () => { entered.resolve(undefined); await release.promise })
  onTestFinished(() => { release.resolve(undefined) })
  const registry = f.ctx.computerUse
  const closing = f.provider.dispose()
  try {
    await entered.promise
    expect(registry.providerName).toBe('dsh-cua')
    release.resolve(undefined)
    await closing
    expect(registry.providerName).toBeUndefined()
  } finally { release.resolve(undefined); await closing }
})

it('joins helper cleanup already started by Agent disposal when the provider unloads', async () => {
  const f = await setup()
  await f.execute()
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementation(async () => { started.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  const agentClosing = f.handle.dispose()
  await started.promise
  let providerClosed = false
  const providerClosing = f.provider.dispose().then(() => { providerClosed = true })
  try {
    await setImmediate()
    expect(providerClosed).toBe(false)
    release.resolve()
    await Promise.all([agentClosing, providerClosing])
    expect(native.dispose).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); await Promise.all([agentClosing, providerClosing]) }
})

it('reports failed cleanup after waiting for other owners and releasing their Agent effects', async () => {
  const f = await setup()
  await f.execute()
  const other = await f.ctx.agents.create({ sessionId: SessionId('native-lifecycle-other') })
  await executeToolFixture(f.ctx, {
    agent: other.agent, signal: new AbortController().signal, callId: ToolCallId('other-owner'),
    name: 'cua', arguments: { method: 'listApps', params: {} },
  })
  const failure = new Error('native range observation failed')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementationOnce(async () => { throw failure })
    .mockImplementationOnce(async () => { started.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  const reported: unknown[] = []
  const errors = vi.spyOn(f.provider.ctx.logger, 'error').mockImplementation((error: unknown) => { reported.push(error) })
  onTestFinished(() => { errors.mockRestore() })
  let closed = false
  const closing = f.provider.dispose().then(() => { closed = true })
  try {
    await started.promise
    await setImmediate()
    expect(closed).toBe(false)
    expect(errors).not.toHaveBeenCalled()
    release.resolve()
    await closing
    expect(native.dispose).toHaveBeenCalledTimes(2)
    const aggregate = reported.find(error => error instanceof AggregateError)
    expect(aggregate?.errors).toContain(failure)
    const errorsBeforeAgentDisposal = errors.mock.calls.length
    await Promise.all([f.handle.dispose(), other.dispose()])
    expect(native.dispose).toHaveBeenCalledTimes(2)
    expect(errors).toHaveBeenCalledTimes(errorsBeforeAgentDisposal)
    expect(f.ctx.tools.schemas()).toEqual([])
  } finally { release.resolve(); await closing }
})

it('rejects malformed and unowned operations before acquiring a helper', async () => {
  const f = await setup()
  expect((await f.execute('screenshot', { pid: 9, windowId: 7 })).isError).toBe(true)
  const unowned = await executeToolFixture(f.ctx, {
    signal: new AbortController().signal, callId: ToolCallId('unowned'), name: 'cua', arguments: { method: 'listApps', params: {} },
  })
  expect(unowned.isError).toBe(true)
  expect(native.instances).toEqual([])
  expect(native.request).not.toHaveBeenCalled()
})

it.each([false, true])('rejects an ended Agent with prior helper acquisition %s', async (acquired) => {
  const f = await setup()
  if (acquired) await f.execute()
  await f.handle.dispose()
  const requests = native.request.mock.calls.length
  const result = await f.execute()
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('agent has been disposed')
  expect(native.instances).toHaveLength(acquired ? 1 : 0)
  expect(native.request).toHaveBeenCalledTimes(requests)
})

it('supplies configured resource bounds and clears registrations on unload', async () => {
  const f = await setup()
  await selectApplication(f)
  native.request.mockResolvedValueOnce({ appHandle: 'app-one', windowId: null, snapshotId: 's', tree: 'Window', truncated: false,
    windows: [{ windowId: 7, appName: 'Fixture', title: 'Window', bounds: imageMetadata.bounds, isOnScreen: true, onCurrentSpace: true }] })
  await f.execute('getState', { appHandle: 'app-one' })
  expect(native.request).toHaveBeenLastCalledWith('getState', { appHandle: 'app-one', maxElements: 64, maxDepth: 8 }, expect.any(AbortSignal), ToolCallId('lifecycle-2'))
  await f.execute('drag', { appHandle: 'app-one', windowId: 7, fromX: 1, fromY: 2, toX: 3, toY: 4, relative: true })
  expect(native.request).toHaveBeenLastCalledWith('drag', expect.objectContaining({ durationMs: 200, steps: 10 }), expect.any(AbortSignal), ToolCallId('lifecycle-3'))
  await f.execute('paste', { appHandle: 'app-one', text: 'hello', format: 'text' })
  expect(native.request).toHaveBeenLastCalledWith('paste', expect.objectContaining({ maxClipboardBytes: 8192, pasteReadTimeoutMs: 1000, maxElements: 64, maxDepth: 8 }), expect.any(AbortSignal), ToolCallId('lifecycle-4'))
  await f.execute('findApps', { query: 'Fixture' })
  expect(native.request).toHaveBeenLastCalledWith('findApps', { query: 'Fixture', maxAppMatches: 20 }, expect.any(AbortSignal), ToolCallId('lifecycle-5'))
  await f.provider.dispose()
  expect(f.ctx.tools.schemas()).toEqual([])
  expect(native.dispose).toHaveBeenCalledTimes(1)
})

it('keeps native element diagnostics out of model-visible state and structured tool values', async () => {
  const f = await setup()
  await selectApplication(f)
  const visible = { appHandle: 'app-one', windowId: null, focusedWindowId: null,
    snapshotId: 'state-one', tree: '- [0] AXButton "Save"', windows: [], truncated: false }
  native.request.mockResolvedValue({ ...visible, elements: [{ elementId: '0', role: 'AXButton', bounds: [10, 20, 30, 40] }] })
  const result = await f.execute('getState', { appHandle: 'app-one' })
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject(visible)
  expect(result.value).not.toHaveProperty('elements')
  const content = result.content.find(block => block.type === 'text')
  if (content?.type !== 'text') throw new Error('State text was not projected')
  expect(JSON.parse(content.text)).toEqual(visible)
})

it('preserves screenshot attachments and invalidates pixel coordinates when window listings observe a resize', async () => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  f.ctx.llm.registerAdapter(['image-fixture'], new ImageAdapter())
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-image-'))
  onTestFinished(async () => { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const data = imageData
  const metadata = imageMetadata
  native.request.mockResolvedValue({ ...metadata, mimeType: 'image/png', data })
  const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  expect(result.isError).toBe(false)
  const text = result.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Screenshot coordinates were not returned')
  expect(JSON.parse(text.text)).toEqual({ ...metadata, coordinateSpace: 'screenshot-pixels' })
  const image = result.content.find(block => block.type === 'image')
  if (image?.type !== 'image') throw new Error('Screenshot attachment was not admitted')
  const stored = await f.ctx.attachments.readImage(image.attachment)
  expect(Buffer.from(stored.data).toString('base64')).toBe(data)
  expect(result.value).toMatchObject({ ...metadata, coordinateSpace: 'screenshot-pixels', mimeType: 'image/png', data })
  const windows = [{ windowId: 7, appName: 'Fixture', title: 'Window',
    bounds: { ...metadata.bounds, width: 2 }, isOnScreen: true, onCurrentSpace: true }]
  native.request.mockResolvedValueOnce(windows)
  const listed = await f.execute('listWindows', { appHandle: 'app-one' })
  expect(listed.isError).toBe(false)
  expect(listed.value).toEqual(windows)
  native.request.mockClear()
  const click = await f.execute('click', { appHandle: 'app-one', windowId: 7, x: 0, y: 0 })
  expect(click.isError).toBe(true)
  expect(JSON.stringify(click.content)).toContain('SCREENSHOT_REQUIRED')
  expect(native.request).not.toHaveBeenCalled()
})

it('maps the actual model-request image pixels back to native points without storing the screenshot twice', async () => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  class ResizingAdapter extends ImageAdapter {
    override imageRequestTarget(_provider: string, _model: string, _image: ImageAttachmentRef) {
      return { width: 10, height: 5, maxBytes: 100_000 }
    }
  }
  f.ctx.llm.registerAdapter(['image-fixture'], new ResizingAdapter())
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-coordinate-image-'))
  onTestFinished(async () => { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const save = vi.spyOn(f.ctx.attachments, 'saveImages')
  const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#4488cc' } }).png().toBuffer()
  native.request.mockResolvedValue({ ...imageMetadata, bounds: { x: 10, y: 20, width: 400, height: 200 },
    pixelWidth: 40, pixelHeight: 20, mimeType: 'image/png', data: image.toString('base64') })
  const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ pixelWidth: 10, pixelHeight: 5, coordinateSpace: 'screenshot-pixels' })
  const value = result.value as { data: string }
  expect(await sharp(Buffer.from(value.data, 'base64')).metadata()).toMatchObject({ width: 10, height: 5 })
  expect(save).toHaveBeenCalledTimes(1)
  native.request.mockResolvedValue({ dispatched: true })
  expect((await f.execute('click', { appHandle: 'app-one', windowId: 7, x: 5, y: 2.5 })).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('click', { appHandle: 'app-one', windowId: 7, x: 200, y: 100 }, expect.any(AbortSignal), expect.any(String))
  expect((await f.execute('click', { appHandle: 'app-one', windowId: 7, x: 999, y: 999, relative: true })).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('click', { appHandle: 'app-one', windowId: 7, x: 399, y: 199 }, expect.any(AbortSignal), expect.any(String))
})

it.each([{ appHandle: 'foreign', windowId: 7 }, { appHandle: 'app-one', windowId: null }])(
  'rejects a helper observation for the wrong target before releasing its contents: %j', async (identity) => {
    const f = await setup()
    await selectApplication(f)
    native.request.mockResolvedValueOnce({ ...identity, snapshotId: 'other', tree: 'foreign content', truncated: false, windows: [] })
    const result = await f.execute('getState', { appHandle: 'app-one', windowId: 7 })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('NATIVE_PROTOCOL')
    expect(JSON.stringify(result.content)).not.toContain('foreign content')
  },
)

it('rejects a screenshot from another window before attachment admission', async () => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  f.ctx.llm.registerAdapter(['image-fixture'], new ImageAdapter())
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-wrong-window-'))
  onTestFinished(async () => { try { await f.ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const save = vi.spyOn(f.ctx.attachments, 'saveImages')
  native.request.mockResolvedValueOnce({ ...imageMetadata, windowId: 8, mimeType: 'image/png', data: imageData })
  const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('NATIVE_PROTOCOL')
  expect(save).not.toHaveBeenCalled()
})

it.each([{ pixelWidth: 2 }, { pixelHeight: 2 }])('rejects native screenshot dimensions that disagree with decoded bytes: %j', async (invalid) => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  f.ctx.llm.registerAdapter(['image-fixture'], new ImageAdapter())
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-image-metadata-'))
  onTestFinished(async () => { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  native.request.mockResolvedValue({ ...imageMetadata, ...invalid, mimeType: 'image/png', data: imageData })
  const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('dimensions disagree')
  expect(result.content.some(block => block.type === 'image')).toBe(false)
})

it('refuses screenshot capture when no attachment store is mounted', async () => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  native.request.mockClear()
  const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('require an attachment store')
  expect(native.request).not.toHaveBeenCalled()
})

it.each(['unresolved', 'unknown', 'text-only', 'provider-error'] as const)(
  'refuses screenshot capture and storage for a %s model route', async (route) => {
    const f = await setup(route === 'unresolved' ? undefined : { provider: 'image-fixture', model: 'vision' })
    await selectApplication(f)
    const root = await mkdtemp(join(tmpdir(), 'dsh-cua-image-route-'))
    onTestFinished(async () => { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
    const saved = vi.spyOn(f.ctx.attachments, 'saveImages')
    const resolve = vi.spyOn(f.ctx.llm, 'resolveModelInfo')
    if (route === 'provider-error') resolve.mockRejectedValue(new Error('model lookup failed'))
    else resolve.mockResolvedValue({ provider: 'image-fixture', id: 'vision', name: 'Vision',
      ...route === 'text-only' ? { inputModalities: ['text'] } : {},
    })
    native.request.mockClear()
    const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(route === 'unresolved' ? 'model route could not be resolved'
      : route === 'provider-error' ? 'model lookup failed' : 'declare image input')
    expect(native.request).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
  },
)

it.each([
  { failure: 'opaque failure', summary: 'Image processing failed' },
  { failure: new Error('image target unavailable'), summary: 'image target unavailable' },
])('reports an unclassified model image preparation failure: $summary', async ({ failure, summary }) => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  f.ctx.llm.registerAdapter(['image-fixture'], new ImageAdapter())
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-image-preparation-'))
  onTestFinished(async () => { try { await f.ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  vi.spyOn(f.ctx.attachments, 'readImageRequest').mockRejectedValue(failure)
  native.request.mockResolvedValue({ ...imageMetadata, mimeType: 'image/png', data: imageData })
  const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  const content = JSON.stringify(result.content)
  expect(result.isError).toBe(true)
  expect(content).toContain('SCREENSHOT_IMAGE_FAILED: Screenshot model image preparation failed for window 7')
  expect(content).toContain(summary)
  expect(content).not.toContain(imageData)
})

it('returns an image-admission failure without emitting a successful screenshot', async () => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  f.ctx.llm.registerAdapter(['image-fixture'], new ImageAdapter())
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-image-invalid-'))
  onTestFinished(async () => { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  native.request.mockResolvedValue({ ...imageMetadata, mimeType: 'image/png', data: 'AQ==' })
  const result = await f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'image')).toBe(false)
  expect(JSON.stringify(result.content)).toContain('INVALID_IMAGE: Screenshot image admission failed for window 7')
})

it.each([
  { owner: 'provider', stage: 'admission' },
  { owner: 'provider', stage: 'storage' },
  { owner: 'agent', stage: 'admission' },
  { owner: 'agent', stage: 'storage' },
  { owner: 'revocation', stage: 'admission' },
  { owner: 'revocation', stage: 'storage' },
])('waits for screenshot $stage and cancels its result during $owner disposal', async ({ owner, stage }) => {
  const f = await setup({ provider: 'image-fixture', model: 'vision' })
  await selectApplication(f)
  f.ctx.llm.registerAdapter(['image-fixture'], new ImageAdapter())
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-image-disposal-'))
  onTestFinished(async () => { try { await f.ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await f.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  native.request.mockResolvedValue({ ...imageMetadata, mimeType: 'image/png', data: imageData })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { release.resolve() })
  let admissionSignal: AbortSignal | undefined
  const resolveModel = f.ctx.llm.resolveModelInfo.bind(f.ctx.llm)
  const admission = vi.spyOn(f.ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, model, signal) => {
    admissionSignal = signal
    if (stage === 'admission') { entered.resolve(); await release.promise }
    return resolveModel(provider, model, signal)
  })
  const saveImages = f.ctx.attachments.saveImages.bind(f.ctx.attachments)
  const storage = vi.spyOn(f.ctx.attachments, 'saveImages').mockImplementation(async (images) => {
    if (stage === 'storage') { entered.resolve(); await release.promise }
    return saveImages(images)
  })
  const pending = f.execute('screenshot', { appHandle: 'app-one', windowId: 7 })
  let closing: Promise<void> | undefined
  try {
    const reached = await Promise.race([entered.promise.then(() => true), pending.then(() => false)])
    expect(reached).toBe(true)
    let closed = false
    closing = (owner === 'provider' ? f.provider.dispose()
      : owner === 'agent' ? f.handle.dispose()
        : f.ctx.cuaAccess.revoke('a'.repeat(64) as import('@deepseek-ai/dsh-cua/types').CuaApplicationId)).then(() => { closed = true })
    await setImmediate()
    expect(admissionSignal?.aborted).toBe(true)
    expect(closed).toBe(false)
    release.resolve()
    expect((await pending).isError).toBe(true)
    await closing
    expect(closed).toBe(true)
    expect(storage).toHaveBeenCalledTimes(stage === 'storage' ? 1 : 0)
  } finally {
    release.resolve()
    await Promise.allSettled([pending, closing])
    admission.mockRestore()
    storage.mockRestore()
  }
})

it('prepares the selected native component before registering CUA and creates no helper until a tool call', async () => {
  const f = await setup()
  await f.provider.dispose()
  native.prepare.mockReset().mockResolvedValue(resolve('prepared-helper'))
  await NativeProvider.apply(f.ctx, { ...automaticConfig, allowedApps: [] })
  expect(native.prepare).toHaveBeenCalledTimes(1)
  expect(native.prepare.mock.calls[0]![0].sourceSigning).toBe('ad-hoc')
  expect(native.instances).toHaveLength(0)
  await f.execute()
  expect(native.instances).toHaveLength(1)
  const signal = native.prepare.mock.calls[0]![0].signal
  await f.ctx.fiber.dispose()
  expect(signal.aborted).toBe(true)
})

it('adds an installation-owned bridge URL when persistent PTC is available', async () => {
  const f = await setup()
  const text = async () => (await f.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'computer-use:dsh-cua')?.text
  expect(await text()).not.toContain('Persistent PTC initialization:')
  await f.ctx.plugin(FileSystem)
  await f.ctx.plugin(Sandbox)
  await f.ctx.plugin(SandboxPolicy)
  await f.ctx.plugin(NodeRuntime, { executionMode: 'persistent-in-memory' })
  expect(await text()).toContain(new URL('../../cua/lib/bridge.js', import.meta.url).href)
})

it('keeps Cordis loading until preparation succeeds and reports preparation failure through the fiber', async () => {
  const f = await setup()
  await f.provider.dispose()
  const ready: PromiseWithResolvers<string> = Promise.withResolvers()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { ready.resolve(resolve('prepared-helper')) })
  native.prepare.mockReset().mockImplementation(() => { entered.resolve(); return ready.promise })
  await f.ctx.plugin(Loader)
  f.ctx.loader.builtins.cua = NativeProvider
  const entry = f.ctx.loader.resolve(await f.ctx.loader.create({ name: 'cordis:cua', config: automaticConfig }))
  const provider = entry.fiber!
  await entered.promise
  expect(provider.state).toBe(FiberState.LOADING)
  expect(f.ctx.tools.schemas().some(tool => tool.name === 'cua')).toBe(false)
  const failed = expect(provider.await()).rejects.toThrow('compiler unavailable')
  ready.reject(new Error('compiler unavailable'))
  await failed
  expect(provider.state).toBe(FiberState.FAILED)
  expect(f.ctx.tools.schemas().some(tool => tool.name === 'cua')).toBe(false)
  expect(native.instances).toHaveLength(0)
})

it('waits for canceled preparation and never publishes its late success', async () => {
  const f = await setup()
  await f.provider.dispose()
  const ready = Promise.withResolvers<string>()
  onTestFinished(() => { ready.resolve(resolve('late-helper')) })
  native.prepare.mockReset().mockReturnValue(ready.promise)
  const starting = Promise.resolve(NativeProvider.apply(f.ctx, { ...automaticConfig, allowedApps: [] }))
  const failed = expect(starting).rejects.toThrow()
  const signal = native.prepare.mock.calls[0]![0].signal
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  let closed = false
  const closing = f.ctx.fiber.dispose().then(() => { closed = true })
  try {
    await aborted
    expect(closed).toBe(false)
  } finally {
    ready.resolve(resolve('late-helper'))
    await Promise.all([closing, failed])
  }
  expect(native.instances).toHaveLength(0)
})

it('rejects an unsupported native host before starting preparation', async () => {
  const f = await setup()
  await f.provider.dispose()
  native.architecture.mockImplementationOnce(() => { throw new Error('unsupported host') })
  native.prepare.mockReset()
  await expect(NativeProvider.apply(f.ctx, { ...automaticConfig, allowedApps: [] })).rejects.toThrow('unsupported host')
  expect(native.prepare).not.toHaveBeenCalled()
})


async function permissionProfile(allowedApps: Array<{ id: string; name: string; executablePath?: string }> = []) {
  const f = await setup()
  await f.provider.dispose()
  const home = await mkdtemp(join(tmpdir(), 'cua-grant-profile-')), dir = join(home, 'profile')
  onTestFinished(async () => { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  initProfile(dir, ['permission-fixture-bundle'])
  const bundle = join(dir, 'node_modules', 'permission-fixture-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'permission-fixture-bundle', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'cua', name: 'cordis:cua', config: { ...config, allowedApps } }] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['permission-fixture-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined }
  f.ctx.baseUrl = pathToFileURL(home).href + '/'
  f.ctx.provide('profileContext', profile)
  f.ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
  await f.ctx.plugin(Loader)
  f.ctx.loader.builtins.cua = NativeProvider
  await f.ctx.plugin(ConfigEditor)
  await f.ctx.plugin(Storage)
  await f.ctx.plugin(StorageJson, { root: join(home, 'storages') })
  await f.ctx.plugin(StorageDomain, { backend: 'json' })
  await mountRootInclude(f.ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await f.ctx.loader.await()
  native.request.mockImplementation(async (method: string) => method === 'applicationIcons' ? {}
    : { platform: 'darwin' as const, accessibility: true, screenRecording: true, helper: { pid: 2 }, parent: { pid: 1 } })
  expect((await f.ctx.cuaAccess.applications()).persistentAvailable).toBe(true)
  await f.ctx.plugin(Settings)
  await f.ctx.plugin(Timer)
  await f.ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await f.ctx.hmr.runExclusive(async () => {})
  return { ...f, profile }
}

it('stores revocation without entering the HMR configuration queue', async () => {
  const grant = { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }
  const f = await permissionProfile([grant])
  const before = await readFile(f.profile.patchPath, 'utf8')
  const acquired = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const blocked = f.ctx.hmr.runExclusive(async () => { acquired.resolve(undefined); await release.promise })
  await acquired.promise
  await f.ctx.cuaAccess.revoke(grant.id as import('@deepseek-ai/dsh-cua/types').CuaApplicationId)
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toEqual([])
  expect(await readFile(f.profile.patchPath, 'utf8')).toBe(before)
  release.resolve(undefined)
  await blocked
})

it.each([true, false])('stores persistable application consent separately from configuration (path present: %s)', async (hasPath) => {
  const f = await permissionProfile(), { profile } = f
  expect(f.ctx.settings.describe().find(row => row.ns === 'cua')).toBeUndefined()
  await f.ctx.plugin(UserQuestions)
  f.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'cua-app-access', selected: ['Always allow'] }] }))
  const authorization = { id: 'a'.repeat(64), name: 'Fixture', ...(hasPath ? { executablePath: '/fixture/app' } : {}), persistable: true }
  native.request.mockResolvedValue({ appHandle: 'signed-app', running: true, name: 'Fixture', authorization })
  expect((await f.execute('getApp', { selector: 'Fixture' })).isError).toBe(false)
  expect(await readFile(profile.patchPath, 'utf8')).not.toContain(authorization.id)
  const files = await readdir(join(profile.home, 'storages'))
  const stored = files.find(file => file.startsWith('cua_permissions_'))!
  expect(await readFile(join(profile.home, 'storages', stored), 'utf8')).toContain(authorization.id)
  native.request.mockImplementation(async (method: string) => method === 'applicationIcons' ? {}
    : { platform: 'darwin' as const, accessibility: true, screenRecording: true, helper: { pid: 2 }, parent: { pid: 1 } })
  const permission = await f.ctx.cuaAccess.applications()
  expect(permission.allowedApps).toHaveLength(1)
  await f.ctx.cuaAccess.revoke(permission.allowedApps[0]!.id)
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toEqual([])
  await f.ctx.cuaAccess.retryApproval(permission.allowedApps[0]!.id)

})

it('rejects an application handle before any helper or consent has been acquired', async () => {
  const f = await setup()
  const result = await f.execute('getState', { appHandle: 'unselected-app' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('APP_ACCESS_REQUIRED')
  expect(native.instances).toHaveLength(0)
  expect(native.request).not.toHaveBeenCalled()
})

it.each([true, false])('uses configured grants without requesting a human answer (path present: %s)', async (hasPath) => {
  const f = await setup()
  await f.provider.dispose()
  const grant = { id: 'a'.repeat(64), name: 'Fixture', ...(hasPath ? { executablePath: '/fixture/app' } : {}) }
  await f.ctx.plugin(NativeProvider, { ...config, allowedApps: [grant] })
  native.request.mockResolvedValueOnce({ appHandle: 'saved-app', name: 'Fixture', running: true, authorization: { ...grant, persistable: true } })
  expect((await f.execute('getApp', { selector: 'Fixture' })).isError).toBe(false)
  native.request.mockResolvedValue({ dispatched: true })
  expect((await f.execute('activate', { appHandle: 'saved-app' })).isError).toBe(false)
  expect(native.instances).toHaveLength(1)
  expect(native.request).toHaveBeenCalledTimes(2)
})

it('retires failed cleanup without replaying an operation or retaining old handles', async () => {
  const f = await setup()
  await selectApplication(f)
  const previous = native.instances[0]!
  previous.disposed = true
  const bothWaiting: PromiseWithResolvers<void> = Promise.withResolvers()
  const cleanup: PromiseWithResolvers<void> = Promise.withResolvers()
  let waiters = 0
  native.dispose.mockImplementation(() => {
    if (++waiters === 2) bothWaiting.resolve()
    return cleanup.promise
  })
  const requests = Promise.all([f.execute('listApps'), f.execute('listApps')])
  try { await bothWaiting.promise } finally { cleanup.reject(new Error('cleanup acknowledgement missing')) }
  for (const failed of await requests) {
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain('cleanup acknowledgement missing')
  }
  native.dispose.mockReset()
  expect(native.instances).toHaveLength(1)
  expect((await f.execute('getState', { appHandle: 'app-one' })).isError).toBe(true)
  expect(native.instances).toHaveLength(1)
  native.request.mockResolvedValueOnce([])
  expect((await f.execute()).isError).toBe(false)
  expect(native.instances).toHaveLength(2)
})

it('routes permission actions through the macOS provider with the Client language and configured interval', async () => {
  const f = await setup()
  native.request.mockResolvedValueOnce({ platform: 'darwin', accessibility: false, screenRecording: false, helper: { pid: 9 }, parent: { pid: 8 } })
  await f.ctx.cuaAccess.requestPermission('accessibility', 'zh')
  expect(native.request).toHaveBeenLastCalledWith('requestPermission', {
    permission: 'accessibility', pollIntervalMs: 1000,
    instruction: '将 {application} 拖入上方列表以允许辅助功能', backLabel: '返回', finderLabel: '在 Finder 中显示',
    unavailableMessage: '找不到此应用。请重新启用 Computer Use 后重试',
    settingsMessage: '请手动打开系统设置 > 隐私与安全性 > 辅助功能',
  }, expect.any(AbortSignal))
  native.request.mockResolvedValueOnce({ opened: true })
  await f.ctx.cuaAccess.openSettings('screenRecording', 'en')
  expect(native.request).toHaveBeenLastCalledWith('openPermissionSettings', {
    permission: 'screenRecording', settingsMessage: 'Open System Settings > Privacy & Security > Screen Recording manually.',
  }, expect.any(AbortSignal))
})

const hoverTarget = { appHandle: 'app-one', snapshotId: 'snapshot', elementId: '0' }
const physicalHover = { ...hoverTarget, useSystemPointer: true }

async function hoverFixture(requireApproval = true) {
  const f = await setup()
  if (!requireApproval) {
    await f.provider.dispose()
    await f.ctx.plugin(NativeProvider, { ...config, requireSystemPointerApproval: false })
  }
  const questions = await f.ctx.plugin(UserQuestions)
  const questionId = 'cua-mouse-control'
  const approved = { answers: [{ id: questionId, selected: ['Allow for this session'] }] }
  const ask = vi.fn(async () => approved)
  f.ctx.on('user-questions/request', async ({ questions }) => questions[0]!.id === questionId ? ask()
    : { answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
  let index = 0
  const call = (agent: typeof f.handle.agent, method: string, params: Record<string, unknown>) => executeToolFixture(f.ctx, {
    agent, signal: new AbortController().signal, callId: ToolCallId(`hover-${++index}`), name: 'cua', arguments: { method, params },
  })
  const select = async (agent = f.handle.agent) => {
    native.request.mockResolvedValueOnce({ appHandle: 'app-one', name: 'Fixture', running: true,
      authorization: { id: 'a'.repeat(64), name: 'Fixture', persistable: false } })
    expect((await call(agent, 'getApp', { selector: 'Fixture' })).isError).toBe(false)
  }
  await select()
  native.request.mockClear()
  return { ...f, ask, approved, call, select, questions }
}

it('requires an explicit system-pointer request on every move and asks only once per session', async () => {
  const f = await hoverFixture()
  native.request.mockRejectedValueOnce(new Error('HOVER_UNAVAILABLE'))
  expect(JSON.stringify((await f.execute('mouseMove', hoverTarget)).content)).toContain('HOVER_UNAVAILABLE')
  expect(f.ask).not.toHaveBeenCalled()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const answer = Promise.withResolvers<typeof f.approved>()
  f.ask.mockImplementationOnce(() => { entered.resolve(); return answer.promise })
  onTestFinished(() => { answer.resolve(f.approved) })
  const pending = f.execute('mouseMove', physicalHover)
  await entered.promise
  expect(native.request).toHaveBeenCalledTimes(1)
  expect(JSON.stringify((await f.execute('mouseMove', physicalHover)).content)).toContain('MOUSE_CONTROL_PENDING')
  answer.resolve(f.approved)
  expect((await pending).isError).toBe(false)
  for (const [params, physical] of [
    [hoverTarget, false], [{ ...hoverTarget, useSystemPointer: false }, false], [physicalHover, true],
  ] as const) {
    expect((await f.execute('mouseMove', params)).isError).toBe(false)
    expect(native.request).toHaveBeenLastCalledWith('mouseMove', { ...hoverTarget, useSystemPointer: physical }, expect.any(AbortSignal), expect.any(String))
  }
  expect(native.request.mock.calls[1]?.[1]).toEqual(physicalHover)
  expect(f.ask).toHaveBeenCalledTimes(1)
})

it('keeps refusals and grants separate and forgets a closed session on reopen', async () => {
  const f = await hoverFixture()
  expect((await f.execute('mouseMove', physicalHover)).isError).toBe(false)
  const { agent } = await f.ctx.agents.create({ sessionId: SessionId('other-mouse-session') })
  expect(JSON.stringify((await f.call(agent, 'mouseMove', physicalHover)).content)).toContain('APP_ACCESS_REQUIRED')
  await f.select(agent)
  f.ask.mockResolvedValueOnce({ answers: [{ id: 'cua-mouse-control', selected: ['Deny'] }] })
  native.request.mockClear()
  for (let i = 0; i < 2; i++) expect(JSON.stringify((await f.call(agent, 'mouseMove', physicalHover)).content)).toContain('MOUSE_CONTROL_DENIED')
  expect(native.request).not.toHaveBeenCalled()
  expect((await f.call(agent, 'mouseMove', hoverTarget)).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('mouseMove', { ...hoverTarget, useSystemPointer: false }, expect.any(AbortSignal), expect.any(String))
  expect((await f.execute('mouseMove', physicalHover)).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('mouseMove', physicalHover, expect.any(AbortSignal), expect.any(String))
  const sessionId = f.handle.agent.id
  await f.handle.dispose()
  const reopened = await f.ctx.agents.create({ sessionId })
  await f.select(reopened.agent)
  expect((await f.call(reopened.agent, 'mouseMove', hoverTarget)).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('mouseMove', { ...hoverTarget, useSystemPointer: false }, expect.any(AbortSignal), expect.any(String))
  expect((await f.call(reopened.agent, 'mouseMove', physicalHover)).isError).toBe(false)
  expect(f.ask).toHaveBeenCalledTimes(3)
})

it('rechecks the selection after a pending approval and does not dispatch revoked or stale input', async () => {
  const f = await hoverFixture()
  f.ask.mockImplementationOnce(async () => {
    await f.ctx.cuaAccess.revoke('a'.repeat(64) as Parameters<typeof f.ctx.cuaAccess.revoke>[0])
    return f.approved
  })
  expect((await f.execute('mouseMove', physicalHover)).isError).toBe(true)
  expect(native.request).not.toHaveBeenCalled()
})

it('revalidates window coordinates after the user answers', async () => {
  const f = await hoverFixture()
  native.request.mockResolvedValueOnce([{ windowId: 7, appName: 'Fixture', title: 'Window', bounds: { x: 0, y: 0, width: 100, height: 100 },
    isOnScreen: true, onCurrentSpace: true }])
  await f.execute('listWindows', { appHandle: 'app-one' })
  f.ask.mockImplementationOnce(async () => {
    native.request.mockResolvedValueOnce([])
    await f.execute('listWindows', { appHandle: 'app-one' })
    return f.approved
  })
  const result = await f.execute('mouseMove', { appHandle: 'app-one', windowId: 7, x: 500, y: 500, relative: true, useSystemPointer: true })
  expect(JSON.stringify(result.content)).toContain('STALE_SNAPSHOT')
  expect(native.request.mock.calls.map(([name]) => name)).toEqual(['listWindows', 'listWindows'])
})

it('drops dismissal, aborted answers and missing human answerers without allowing input', async () => {
  const f = await hoverFixture()
  f.ask.mockRejectedValueOnce(new UserQuestionError('dismissed', 'ASK_CANCELLED'))
  expect(JSON.stringify((await f.execute('mouseMove', physicalHover)).content)).toContain('MOUSE_APPROVAL_CANCELLED')
  f.ask.mockRejectedValueOnce(new UserQuestionError('The answer channel disconnected', 'ASK_ABORTED'))
  expect(JSON.stringify((await f.execute('mouseMove', physicalHover)).content)).toContain('The answer channel disconnected')
  const controller = new AbortController()
  f.ask.mockImplementationOnce(async () => { controller.abort(); return f.approved })
  await Promise.allSettled([f.execute('mouseMove', physicalHover, controller.signal)])
  expect(native.request).not.toHaveBeenCalled()
  expect((await f.execute('mouseMove', physicalHover)).isError).toBe(false)
  expect(f.ask).toHaveBeenCalledTimes(4)
  await f.provider.dispose()
  await f.ctx.plugin(NativeProvider, config)
  await f.select()
  await f.questions.dispose()
  expect(JSON.stringify((await f.execute('mouseMove', physicalHover)).content)).toContain('MOUSE_APPROVAL_UNAVAILABLE')
})

it('allows only the explicitly requested physical move when approval is disabled', async () => {
  const f = await hoverFixture(false)
  for (const [target, expected] of [[hoverTarget, false], [physicalHover, true], [hoverTarget, false]] as const) {
    expect((await f.execute('mouseMove', target)).isError).toBe(false)
    expect(native.request).toHaveBeenLastCalledWith('mouseMove', { ...hoverTarget, useSystemPointer: expected }, expect.any(AbortSignal), expect.any(String))
  }
  expect(f.ask).not.toHaveBeenCalled()
})

it.each([true, false])('rejects a delegated pointer move before asking or dispatching with approval=%s', async (approval) => {
  const f = await hoverFixture(approval)
  const { agent } = await f.ctx.agents.create({ sessionId: SessionId('delegated-mouse-session'),
    meta: { origin: 'subagent', parentSession: f.handle.agent.id } })
  // This case starts with application access already granted to the child.
  const selectAnswer = vi.spyOn(f.ctx.userQuestions, 'ask')
    .mockResolvedValueOnce({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
  await f.select(agent)
  selectAnswer.mockClear()
  native.request.mockClear()
  const refused = await f.call(agent, 'mouseMove', physicalHover)
  expect(JSON.stringify(refused.content)).toContain('MOUSE_CONTROL_UNAVAILABLE')
  expect(selectAnswer).not.toHaveBeenCalled()
  expect(f.ask).not.toHaveBeenCalled()
  expect(native.request).not.toHaveBeenCalled()
})

it.each([true, false])('uses the declared systemPointer capability for a non-macOS provider (%s)', async (systemPointer) => {
  const f = await setup()
  await f.provider.dispose()
  await f.ctx.plugin({ name: 'fixture-window-provider', inject: NativeProvider.inject, apply(ctx: Context) {
    installCua(ctx, CuaConfig(config), {
      helperPath: config.helperPath, createChannel: native.connect, guidance: COMMON_GUIDANCE,
      permissionParameters: () => ({}),
      capabilities: { platform: 'fixture', methods: ['getApp', 'getCapabilities', 'mouseMove'], systemPointer,
        appLevelAccessibility: true, keyboard: ['app'], coordinateSpace: 'screenshot-pixels', browser: false },
    })
  } })
  native.request.mockResolvedValueOnce({ systemPointer: !systemPointer })
  expect((await f.execute('getCapabilities')).value).toMatchObject({ platform: 'fixture', systemPointer })
  const sections = (await f.ctx.systemPrompt.assemble({ scope: f.handle.agent })).sections
  const guidance = sections.find(section => section.name === 'computer-use:dsh-cua')!.text
  expect(guidance.includes('relative?: boolean, useSystemPointer?: boolean')).toBe(systemPointer)
  expect(guidance.includes('The question interrupts the user')).toBe(systemPointer)
  expect(JSON.stringify(f.ctx.tools.get('cua', f.handle.agent)!.parameters).includes('useSystemPointer')).toBe(systemPointer)
  await selectApplication(f)
  native.request.mockClear()
  const answer = vi.spyOn(f.ctx.userQuestions, 'ask').mockResolvedValue({
    answers: [{ id: 'cua-mouse-control', selected: ['Allow for this session'] }],
  })
  const physical = await f.execute('mouseMove', physicalHover)
  expect(physical.isError).toBe(!systemPointer)
  expect(answer).toHaveBeenCalledTimes(systemPointer ? 1 : 0)
  if (systemPointer) expect(native.request).toHaveBeenLastCalledWith('mouseMove', physicalHover, expect.any(AbortSignal), expect.any(String))
  else expect(native.request).not.toHaveBeenCalled()
  expect((await f.execute('mouseMove', hoverTarget)).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('mouseMove', systemPointer ? { ...hoverTarget, useSystemPointer: false } : hoverTarget,
    expect.any(AbortSignal), expect.any(String))
})
