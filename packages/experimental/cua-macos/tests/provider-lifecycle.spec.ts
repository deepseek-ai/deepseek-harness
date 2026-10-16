/** Native helper replacement is synchronized with Agent and provider disposal. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import Hmr from '@deepseek-ai/dsh-hmr'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { LlmAdapter, ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import sharp from 'sharp'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import * as NativeProvider from '../src/index.ts'
import type { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import type { NativeBuildSpec } from '../src/native-build.ts'

const native = vi.hoisted(() => ({
  prepare: vi.fn<(spec: NativeBuildSpec) => Promise<string>>(),
  architecture: vi.fn(() => 'arm64' as const),
  request: vi.fn<NativeClient['request']>(), dispose: vi.fn(), instances: [] as Array<{ disposed: boolean }>,
  reportDiagnostic: undefined as ((message: string) => void) | undefined,
}))
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
      native.reportDiagnostic = args[3]
      native.instances.push(this)
    }
    request = native.request
    invalidate() { this.disposed = true }
    async dispose() { this.disposed = true; await native.dispose() }
  },
}))

const config = {
  helperPath: resolve('fixture-helper'), buildTimeoutMs: 300_000, timeoutMs: 10_000, connectTimeoutMs: 5000, screenshotTimeoutMs: 5000, axTimeoutMs: 3000, maxRequestBytes: 1024, maxResponseBytes: 4096, maxClipboardBytes: 8192, pasteReadTimeoutMs: 1000, maxAppMatches: 20,
  graceMs: 10, textEventIntervalMs: 8, maxElements: 64, maxDepth: 8, dragDurationMs: 200, dragSteps: 10,
} satisfies Omit<NativeProvider.Config, 'allowedApps'>

const { helperPath: _helperPath, ...automaticConfig } = config

class ImageAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  stream(): AsyncIterable<StreamChunk> { throw new Error('This direct tool test does not request model generation') }
}

const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const imageMetadata = { pixelWidth: 1, pixelHeight: 1, bounds: { x: 2, y: 3, width: 1, height: 1 }, coordinateSpace: 'window-points', windowId: 7 }

async function setup(model?: { provider: string; model: string }) {
  native.request.mockReset().mockResolvedValue([])
  native.dispose.mockReset()
  native.instances.length = 0
  native.reportDiagnostic = undefined
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(Subprocess, [])
  const provider = await ctx.plugin(NativeProvider, config)
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId('native-lifecycle'), ...model ? { agentOptions: model } : {} })
  let index = 0
  const execute = (method = 'listApps', params: Record<string, unknown> = {}, signal = new AbortController().signal) => ctx.tools.execute({
    agent: handle.agent, signal, callId: ToolCallId(`lifecycle-${++index}`), name: 'cua', arguments: { method, params },
  })
  return { ctx, provider, handle, execute }
}

async function selectApplication(f: Awaited<ReturnType<typeof setup>>) {
  await f.ctx.plugin(UserQuestions)
  f.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] }))
  native.request.mockResolvedValueOnce({ appHandle: 'app-one', pid: 17, name: 'Fixture',
    authorization: { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: true } })
  expect((await f.execute('getApp', { selector: 'Fixture' })).isError).toBe(false)
}

it('rejects a relative helper path before publishing computer-use operations', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await expect(NativeProvider.apply(ctx, { ...config, allowedApps: { get: () => [] }, helperPath: 'relative-helper' })).rejects.toThrow('helperPath must be absolute')
})

it.each(['Allow for this task', 'Deny'])('obtains %s before a stopped application can launch', async (choice) => {
  const f = await setup()
  await f.ctx.plugin(UserQuestions)
  const asked: PromiseWithResolvers<void> = Promise.withResolvers()
  const answer = Promise.withResolvers<{ answers: Array<{ id: string; selected: string[] }> }>()
  onTestFinished(() => { answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] }) })
  f.ctx.on('user-questions/request', async () => { asked.resolve(); return answer.promise })
  native.request.mockImplementation(async (method: string) => method === 'getApp'
    ? { appHandle: 'pending-app', pid: null, name: 'Fixture', authorization: {
      id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: false,
    } }
    : { appHandle: 'pending-app', pid: 17, name: 'Fixture' })
  const pending = f.execute('getApp', { selector: 'Fixture' })
  await asked.promise
  expect(native.request.mock.calls.map(call => call[0])).toEqual(['getApp'])
  answer.resolve({ answers: [{ id: 'cua-app-access', selected: [choice] }] })
  const result = await pending
  expect(result.isError).toBe(choice === 'Deny')
  expect(native.request.mock.calls.map(call => call[0])).toEqual(choice === 'Deny' ? ['getApp'] : ['getApp', 'launchApp'])
  if (choice !== 'Deny') expect(result.value).toMatchObject({ appHandle: 'pending-app', pid: 17 })
})

it('rejects a launch result that changes the approved handle', async () => {
  const f = await setup()
  await f.ctx.plugin(UserQuestions)
  f.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] }))
  native.request.mockResolvedValueOnce({ appHandle: 'pending-app', pid: null, name: 'Fixture', authorization: {
    id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: false,
  } }).mockResolvedValueOnce({ appHandle: 'another-app', pid: 17, name: 'Fixture' })
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

it('reports screenshot pixel coordinates while preserving native capabilities', async () => {
  const f = await setup()
  const capabilities = { platform: 'macos', coordinateSpace: 'window-points', permissions: { accessibility: true, screenCapture: false } }
  native.request.mockResolvedValueOnce(capabilities)
  const result = await f.execute('getCapabilities')
  expect(result.isError).toBe(false)
  expect(result.value).toEqual({ ...capabilities, coordinateSpace: 'screenshot-pixels' })
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
  await f.ctx.tools.execute({
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
  const unowned = await f.ctx.tools.execute({
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
  native.request.mockResolvedValueOnce({ appHandle: 'app-one', pid: 17, windowId: null, snapshotId: 's', tree: 'Window', truncated: false,
    windows: [{ windowId: 7, pid: 17, appName: 'Fixture', title: 'Window', bounds: imageMetadata.bounds, isOnScreen: true, onCurrentSpace: true }] })
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
  const visible = { appHandle: 'app-one', pid: 17, windowId: null, focusedWindowId: null,
    snapshotId: 'state-one', tree: '- [0] AXButton "Save"', windows: [], truncated: false }
  native.request.mockResolvedValue({ ...visible, elements: [{ index: 0, role: 'AXButton', bounds: [10, 20, 30, 40] }] })
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
  const windows = [{ windowId: 7, pid: 17, appName: 'Fixture', title: 'Window',
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
  native.request.mockResolvedValue({ dispatched: true, verified: false })
  expect((await f.execute('click', { appHandle: 'app-one', windowId: 7, x: 5, y: 2.5 })).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('click', { appHandle: 'app-one', windowId: 7, x: 200, y: 100 }, expect.any(AbortSignal), expect.any(String))
  expect((await f.execute('click', { appHandle: 'app-one', windowId: 7, x: 500, y: 500, relative: true })).isError).toBe(false)
  expect(native.request).toHaveBeenLastCalledWith('click', { appHandle: 'app-one', windowId: 7, x: 200, y: 100 }, expect.any(AbortSignal), expect.any(String))
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
})

it.each([
  { owner: 'provider', stage: 'admission' },
  { owner: 'provider', stage: 'storage' },
  { owner: 'agent', stage: 'admission' },
  { owner: 'agent', stage: 'storage' },
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
    closing = (owner === 'provider' ? f.provider.dispose() : f.handle.dispose()).then(() => { closed = true })
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
  await NativeProvider.apply(f.ctx, { ...automaticConfig, allowedApps: { get: () => [] } })
  expect(native.prepare).toHaveBeenCalledTimes(1)
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
  const starting = Promise.resolve(NativeProvider.apply(f.ctx, { ...automaticConfig, allowedApps: { get: () => [] } }))
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
  await expect(NativeProvider.apply(f.ctx, { ...automaticConfig, allowedApps: { get: () => [] } })).rejects.toThrow('unsupported host')
  expect(native.prepare).not.toHaveBeenCalled()
})


it('stores signed application consent in the current profile and refuses unavailable settings', async () => {
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
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'cua', name: 'cordis:cua', config }] }]))
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
  await mountRootInclude(f.ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await f.ctx.loader.await()
  await f.ctx.plugin(UserQuestions)
  const answer = vi.fn(async () => ({ answers: [{ id: 'cua-app-access', selected: ['Allow for this task'] }] }))
  f.ctx.on('user-questions/request', answer)
  native.request.mockResolvedValue({ appHandle: 'task-app', pid: 17, name: 'Fixture',
    authorization: { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: true } })
  expect((await f.execute('getApp', { selector: 'Fixture' })).isError).toBe(false)
  await f.ctx.plugin(Settings)
  await f.ctx.plugin(Timer)
  await f.ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await f.ctx.hmr.runExclusive(async () => {})
  expect(f.ctx.settings.describe().find(row => row.ns === 'cua')?.autoGenerate).toBe(false)
  answer.mockResolvedValue({ answers: [{ id: 'cua-app-access', selected: ['Always allow'] }] })
  const authorization = { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: true }
  native.request.mockResolvedValue({ appHandle: 'signed-app', pid: 17, name: 'Fixture', authorization })
  expect((await f.execute('getApp', { selector: 'Fixture' })).isError).toBe(false)
  expect(await readFile(profile.patchPath, 'utf8')).toContain(authorization.id)
  const settings = f.ctx.settings.describe().find(row => row.ns === 'cua')!
  await f.ctx.settings.mutate('cua', [{ op: 'set', path: ['allowedApps'], value: [] }], settings.revision)
  expect(await readFile(profile.patchPath, 'utf8')).toContain('allowedApps: []')
  const revoked = await f.execute('getState', { appHandle: 'signed-app' })
  expect(revoked.isError).toBe(true)
  expect(JSON.stringify(revoked.content)).toContain('APP_ACCESS_REVOKED')
  vi.spyOn(f.ctx.settings, 'describe').mockReturnValue([])
  native.request.mockResolvedValue({ appHandle: 'different-app', pid: 18, name: 'Other fixture', authorization: { ...authorization, id: 'b'.repeat(64) } })
  const unavailable = await f.execute('getApp', { selector: 'Fixture' })
  expect(unavailable.isError).toBe(true)
  expect(JSON.stringify(unavailable.content)).toContain('APP_ACCESS_DENIED')
})

it('rejects an application handle before any helper or consent has been acquired', async () => {
  const f = await setup()
  const result = await f.execute('getState', { appHandle: 'unselected-app' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('APP_ACCESS_REQUIRED')
  expect(native.instances).toHaveLength(0)
  expect(native.request).not.toHaveBeenCalled()
})

it('uses configured signed application grants without requesting a human answer', async () => {
  const f = await setup()
  await f.provider.dispose()
  const grant = { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }
  await f.ctx.plugin(NativeProvider, { ...config, allowedApps: [grant] })
  native.request.mockResolvedValueOnce({ appHandle: 'saved-app', pid: 17, name: 'Fixture', authorization: { ...grant, persistable: true } })
  expect((await f.execute('getApp', { selector: 'Fixture' })).isError).toBe(false)
  native.request.mockResolvedValue({ dispatched: true, verified: false })
  expect((await f.execute('activate', { appHandle: 'saved-app' })).isError).toBe(false)
  expect(native.instances).toHaveLength(1)
  expect(native.request).toHaveBeenCalledTimes(2)
})
