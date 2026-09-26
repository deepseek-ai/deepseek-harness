/** Local provider queueing, cancellation and process cleanup with real managed subprocesses. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { SenseVoiceWorker } from '../src/recognizer.ts'
import { inspectRuntime, prepareRuntime } from '../src/runtime.ts'
import { SpeechDownloadError } from '../src/download-error.ts'

vi.mock('../src/runtime.ts', () => ({ inspectRuntime: vi.fn(), prepareRuntime: vi.fn() }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks() })

async function fixture(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-test-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalSubprocess)
  const spawn = vi.spyOn(ctx.get('subprocess')!, 'spawn')
  const config = Config({ dataRoot: root, idleTimeoutMs: 0, ...overrides })
  vi.mocked(prepareRuntime).mockImplementation(async () => ({ tokens: root,
    worker: fileURLToPath(new URL('./worker.fixture.mjs', import.meta.url)), model: root, vad: root }))
  const worker = new SenseVoiceWorker(ctx, config)
  cleanup.push(async () => { await worker.dispose() })
  return { root, worker, spawn, ctx }
}

async function prepare(worker: SenseVoiceWorker): Promise<void> {
  const ready = Promise.withResolvers<undefined>()
  const unsubscribe = worker.subscribe(() => {
    const state = worker.snapshot()
    if (state.phase === 'ready') ready.resolve(undefined)
    if (state.phase === 'failed') ready.reject(new Error(state.message))
  })
  try { worker.prepare(); await ready.promise } finally { unsubscribe() }
}

const audio = new Uint8Array([1, 2])
const signal = (): AbortSignal => new AbortController().signal
async function requests(root: string): Promise<string> {
  try { return await readFile(join(root, 'requests'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return ''
  }
}

it('keeps one worker warm across recordings and joins its exit on disposal', async () => {
  const { worker, spawn } = await fixture()
  expect(spawn).not.toHaveBeenCalled()
  await prepare(worker)
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
  expect((await worker.transcribe({ audio, language: 'en' }, signal())).text).toBe('en')
  expect(spawn).toHaveBeenCalledOnce()
  const handle = spawn.mock.results[0]!.value as SubprocessHandle
  await worker.dispose()
  expect(await handle.waitForExit()).toBe(true)
  await expect(worker.transcribe({ audio, language: 'en' }, signal())).rejects.toThrow('disposed')
})

it('pins a manual source to one preparation without changing deployment defaults', async () => {
  const { worker } = await fixture()
  expect(worker.downloadSources).toEqual(['https://huggingface.co', 'https://hf-mirror.com'])
  worker.prepare({ downloadSource: 'https://hf-mirror.com' })
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') })
  expect(prepareRuntime).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ modelOrigin: 'https://hf-mirror.com' }),
    expect.any(AbortSignal), expect.any(Function))
})

it('rejects unadvertised sources and preserves private and offline deployments', async () => {
  const { worker } = await fixture({ modelOrigin: 'https://private.example/' })
  expect(worker.downloadSources).toEqual(['https://private.example'])
  expect(() => { worker.prepare({ downloadSource: 'https://hf-mirror.com' }) }).toThrow('unavailable')
  expect(prepareRuntime).not.toHaveBeenCalled()
  const offline = await fixture({ modelDirectory: process.cwd(), vadModelPath: process.cwd() })
  expect(offline.worker.downloadSources).toEqual([])
  expect(() => { offline.worker.prepare({ downloadSource: 'https://huggingface.co' }) }).toThrow('unavailable')
})

it('joins matching requests and refuses to change the source of active preparation', async () => {
  const { worker } = await fixture(), entered = Promise.withResolvers<undefined>()
  vi.mocked(prepareRuntime).mockImplementation(async (_ctx, _config, signal) => {
    entered.resolve(undefined)
    await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('preparation cancelled')) }, { once: true }) })
    throw new Error('unreachable')
  })
  worker.prepare({ downloadSource: 'https://hf-mirror.com' })
  await entered.promise
  worker.prepare({ downloadSource: 'https://hf-mirror.com' })
  expect(() => { worker.prepare({ downloadSource: 'https://huggingface.co' }) }).toThrow('Cancel preparation')
  expect(prepareRuntime).toHaveBeenCalledOnce()
  await worker.cancel()
  expect(worker.snapshot().phase).toBe('cancelled')
})

it('wakes verified caches on the first recording without preparing them again', async () => {
  const { worker, spawn, root } = await fixture()
  const paths = { tokens: root, model: root, vad: root, worker: fileURLToPath(new URL('./worker.fixture.mjs', import.meta.url)) }
  vi.mocked(inspectRuntime).mockResolvedValueOnce(paths)
  const phases: string[] = []
  worker.subscribe(() => { phases.push(worker.snapshot().phase) })
  worker.inspect(); worker.inspect()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('standby') })
  expect(inspectRuntime).toHaveBeenCalledOnce()
  expect(spawn).not.toHaveBeenCalled()
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
  expect(phases).toContain('waking')
  expect(phases).not.toContain('loading')
  expect(prepareRuntime).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledOnce()
})

it('keeps absent caches unprepared and reports unreadable caches as retryable failures', async () => {
  const { worker, spawn } = await fixture()
  vi.mocked(inspectRuntime).mockResolvedValueOnce(undefined)
  worker.inspect()
  await vi.waitFor(() => { expect(worker.snapshot().steps?.[0]?.status).toBe('complete') })
  expect(worker.snapshot().phase).toBe('unprepared')
  expect(spawn).not.toHaveBeenCalled()
  expect(prepareRuntime).not.toHaveBeenCalled()
  vi.mocked(inspectRuntime).mockRejectedValueOnce(new Error('cache unreadable'))
  worker.inspect()
  await vi.waitFor(() => { expect(worker.snapshot()).toMatchObject({ phase: 'failed', message: 'cache unreadable' }) })
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 10000 })
  expect(prepareRuntime).toHaveBeenCalledOnce()
})

it('cancels cache inspection and joins it without late notifications when the provider unloads', async () => {
  const { worker } = await fixture(), entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
  vi.mocked(inspectRuntime).mockImplementationOnce(async (_config, signal) => {
    entered.resolve(undefined)
    await released.promise
    signal.throwIfAborted()
    return undefined
  })
  const changed = vi.fn()
  worker.subscribe(changed)
  worker.inspect(); await entered.promise
  const cancelled = worker.cancel()
  expect(worker.snapshot().phase).toBe('cancelling')
  let settled = false
  const disposed = worker.dispose().then(() => { settled = true })
  const notifications = changed.mock.calls.length
  await Promise.resolve()
  expect(settled).toBe(false)
  released.resolve(undefined)
  await cancelled; await disposed
  expect(changed).toHaveBeenCalledTimes(notifications)
  expect(prepareRuntime).not.toHaveBeenCalled()
})

it('cancels active inference before the next recording can acquire a fresh worker', async () => {
  const { worker, root, spawn } = await fixture()
  await prepare(worker)
  const cancel = new AbortController()
  const first = worker.transcribe({ audio, language: 'hold' }, cancel.signal)
  const rejected = expect(first).rejects.toThrow()
  await vi.waitFor(async () => { expect(await requests(root)).toContain('hold') }, { timeout: 10000 })
  const next = worker.transcribe({ audio, language: 'en' }, signal())
  cancel.abort(new Error('cancel'))
  await rejected
  expect((await next).text).toBe('en')
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(await (spawn.mock.results[0]!.value as SubprocessHandle).waitForExit()).toBe(true)
})

it('bounds the queue and never executes a cancelled waiting recording', async () => {
  const { worker, root } = await fixture({ maxPending: 2 })
  await prepare(worker)
  const active = new AbortController(), waiting = new AbortController()
  const first = worker.transcribe({ audio, language: 'hold' }, active.signal)
  const firstFailure = expect(first).rejects.toThrow()
  await vi.waitFor(async () => { expect(await requests(root)).toContain('hold') }, { timeout: 10000 })
  const second = worker.transcribe({ audio, language: 'discard' }, waiting.signal)
  const secondFailure = expect(second).rejects.toThrow('waiting cancelled')
  await expect(worker.transcribe({ audio, language: 'full' }, signal())).rejects.toThrow('queue is full')
  waiting.abort(new Error('waiting cancelled')); active.abort()
  await firstFailure; await secondFailure
  expect(await requests(root)).toBe('hold\n')
})

it('joins running and waiting requests when its provider is disposed', async () => {
  const { worker, root } = await fixture()
  await prepare(worker)
  const first = worker.transcribe({ audio, language: 'hold' }, signal())
  const firstFailure = expect(first).rejects.toThrow()
  await vi.waitFor(async () => { expect(await requests(root)).toContain('hold') }, { timeout: 10000 })
  const second = worker.transcribe({ audio, language: 'discard' }, signal())
  const secondFailure = expect(second).rejects.toThrow('disposed')
  await worker.dispose(); await firstFailure; await secondFailure
  expect(await requests(root)).toBe('hold\n')
})

it('stops an idle worker and reloads it on demand', async () => {
  const { worker, spawn } = await fixture({ idleTimeoutMs: 25 })
  await prepare(worker)
  await worker.transcribe({ audio, language: 'en' }, signal())
  const first = spawn.mock.results[0]!.value as SubprocessHandle
  await first.done
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(prepareRuntime).toHaveBeenCalledOnce()
})

it('owns one preparation task across repeated requests and reports warm standby', async () => {
  const { worker, spawn } = await fixture({ idleTimeoutMs: 100 })
  const phases: string[] = []
  const stopObserving = worker.subscribe(() => { phases.push(worker.snapshot().phase) })
  expect(worker.snapshot()).toMatchObject({ phase: 'unprepared' })
  worker.prepare(); worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 10000 })
  worker.prepare()
  expect(spawn).toHaveBeenCalledOnce()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('standby') }, { timeout: 10000 })
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 10000 })
  expect(phases).toContain('waking')
  expect(prepareRuntime).toHaveBeenCalledOnce()
  stopObserving()
})

it('cancels Host preparation, retains retry admission, and exposes preparation failure', async () => {
  const { worker } = await fixture()
  vi.mocked(prepareRuntime).mockImplementationOnce(async (_ctx, _config, signal) => {
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    })
    throw new Error('unreachable')
  })
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('checking') })
  await worker.cancel()
  expect(worker.snapshot().phase).toBe('cancelled')
  await worker.cancel()
  vi.mocked(prepareRuntime).mockRejectedValueOnce(new Error('download unavailable'))
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot()).toMatchObject({ phase: 'failed', message: 'download unavailable' }) })
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 10000 })
})

it('recovers after a provider error or unexpected worker exit', async () => {
  const { worker } = await fixture()
  await prepare(worker)
  await expect(worker.transcribe({ audio, language: 'error' }, signal())).rejects.toThrow('provider failed')
  await expect(worker.transcribe({ audio, language: 'crash' }, signal())).rejects.toThrow()
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
})

it('publishes safe download diagnostics and clears them after a successful retry', async () => {
  const { worker } = await fixture()
  const download = { resource: 'model.int8.onnx', source: 'https://mirror.example', reason: 'dns' as const, code: 'ENOTFOUND' }
  vi.mocked(prepareRuntime).mockRejectedValueOnce(new SpeechDownloadError(download, { cause: new Error('private details') }))
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot()).toMatchObject({ phase: 'failed', download }) })
  expect(JSON.stringify(worker.snapshot())).not.toContain('private details')
  await prepare(worker)
  expect(worker.snapshot()).toMatchObject({ phase: 'ready' })
  expect(worker.snapshot()).not.toHaveProperty('download')
})

it('applies inference deadlines and reports runtime preparation failure', async () => {
  const { worker } = await fixture({ inferenceTimeoutMs: 100 })
  await prepare(worker)
  await expect(worker.transcribe({ audio, language: 'hold' }, signal())).rejects.toThrow()
  const fresh = await fixture()
  vi.mocked(prepareRuntime).mockRejectedValueOnce(new Error('runtime missing'))
  fresh.worker.prepare()
  await vi.waitFor(() => { expect(fresh.worker.snapshot()).toMatchObject({ phase: 'failed', message: 'runtime missing' }) })
  await fresh.worker.cancel()
  expect(fresh.worker.snapshot().phase).toBe('failed')
  await expect(fresh.worker.transcribe({ audio, language: 'zh' }, signal())).rejects.toThrow('Prepare')
})

it('retains complete download snapshots while throttling only intermediate notifications', async () => {
  const { worker } = await fixture({ progressIntervalMs: 100 })
  const now = vi.spyOn(performance, 'now').mockReturnValue(0)
  const runtime = vi.mocked(prepareRuntime).getMockImplementation()!
  const updates: unknown[] = []
  worker.subscribe(() => { updates.push(worker.snapshot()) })
  vi.mocked(prepareRuntime).mockImplementationOnce(async (ctx, config, signal, report) => {
    report!({ phase: 'downloading', resource: 'model', completedBytes: 0, totalBytes: 10 })
    report!({ phase: 'downloading', resource: 'model', completedBytes: 2, totalBytes: 10 })
    expect(worker.snapshot()).toMatchObject({ phase: 'downloading', resource: 'model', completedBytes: 2, totalBytes: 10 })
    expect(updates).not.toContainEqual(worker.snapshot())
    now.mockReturnValue(101)
    report!({ phase: 'downloading', resource: 'model', completedBytes: 5, totalBytes: 10 })
    report!({ phase: 'downloading', resource: 'model', completedBytes: 10, totalBytes: 10 })
    report!({ phase: 'downloading', resource: 'vad', completedBytes: 0, totalBytes: 10 })
    return await runtime(ctx, config, signal, report)
  })
  try {
    worker.prepare()
    await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 10000 })
    expect(updates).toContainEqual(expect.objectContaining({ phase: 'downloading', resource: 'model', completedBytes: 10, totalBytes: 10 }))
    expect(updates).toContainEqual(expect.objectContaining({ phase: 'downloading', resource: 'vad', completedBytes: 0, totalBytes: 10 }))
  } finally { now.mockRestore() }
})

it('joins a worker that exits before readiness and exposes retryable preparation errors', async () => {
  const { worker, spawn, root } = await fixture()
  vi.mocked(prepareRuntime).mockResolvedValueOnce({ tokens: root, worker: join(root, 'missing.mjs'), model: root, vad: root })
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('failed') }, { timeout: 10000 })
  expect(await (spawn.mock.results[0]!.value as SubprocessHandle).waitForExit()).toBe(true)
  const next = await fixture()
  vi.mocked(prepareRuntime).mockRejectedValueOnce('download interrupted')
  next.worker.prepare()
  await vi.waitFor(() => { expect(next.worker.snapshot()).toMatchObject({ phase: 'failed', message: 'download interrupted' }) })
})

it('reclaims the process range after an unexpected idle exit before replacing the worker', async () => {
  const { worker, spawn } = await fixture()
  await prepare(worker)
  await worker.transcribe({ audio, language: 'en' }, signal())
  const handle = spawn.mock.results[0]!.value as SubprocessHandle
  handle.terminate()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('standby') }, { timeout: 10000 })
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
  expect(await handle.waitForExit()).toBe(true)
  expect(spawn).toHaveBeenCalledTimes(2)
})

it('retains a worker whose idle cleanup cannot observe exit until that range is joined', async () => {
  const { worker, spawn, ctx } = await fixture({ idleTimeoutMs: 100 })
  await prepare(worker)
  await worker.transcribe({ audio, language: 'en' }, signal())
  const handle = spawn.mock.results[0]!.value as SubprocessHandle
  const failure = new Error('range observation failed')
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const joined = vi.spyOn(handle, 'waitForExit').mockRejectedValueOnce(failure)
  try {
    // Subprocess ownership also calls waitForExit after the direct process exits.
    await handle.done
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('Speech worker idle cleanup failed', failure)
    }, { timeout: 10000 })
    await expect(worker.transcribe({ audio, language: 'zh' }, signal())).rejects.toBe(failure)
    expect(spawn).toHaveBeenCalledOnce()
    expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
    expect(await joined.mock.results.at(-1)!.value).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
  } finally {
    joined.mockRestore()
    warn.mockRestore()
  }
})

it('retains completed preparation steps when cancellation settles the active step', async () => {
  const { worker } = await fixture(), entered = Promise.withResolvers<undefined>()
  vi.mocked(prepareRuntime).mockImplementationOnce(async (_ctx, _config, signal, report) => {
    for (const step of ['model', 'vad'] as const) report!({ phase: 'downloading', step, resource: step, completedBytes: 1, totalBytes: 1 })
    report!({ phase: 'checking', step: 'verify', startedAt: Date.now() })
    const before = worker.snapshot().steps?.find(step => step.kind === 'verify')?.startedAt
    report!({ phase: 'checking', step: 'verify', startedAt: Date.now() })
    expect(worker.snapshot().steps?.find(step => step.kind === 'verify')?.startedAt).toBe(before)
    entered.resolve(undefined)
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('setup cancelled')) }, { once: true })
    })
  })
  worker.prepare(); await entered.promise
  expect(worker.snapshot().steps?.map(step => [step.kind, step.status])).toEqual([
    ['check', 'complete'], ['model', 'complete'], ['vad', 'complete'], ['verify', 'running'], ['load', 'pending'],
  ])
  await worker.cancel()
  expect(worker.snapshot().steps?.find(step => step.kind === 'verify')?.status).toBe('cancelled')
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 10000 })
  expect(worker.snapshot().steps?.every(step => step.status === 'complete')).toBe(true)
})

it('omits preparation steps supplied by explicit deployment paths', async () => {
  const { worker } = await fixture({ modelDirectory: process.cwd(), vadModelPath: process.cwd() })
  expect(worker.snapshot().steps?.map(step => step.kind)).toEqual(['check', 'verify', 'load'])
  worker.prepare()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 10000 })
})

it('returns prepared resources to standby when the user cancels an idle wake-up', async () => {
  const { worker } = await fixture({ idleTimeoutMs: 100 })
  await prepare(worker)
  await worker.transcribe({ audio, language: 'en' }, signal())
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('standby') }, { timeout: 10000 })
  const cancel = new AbortController()
  const unsubscribe = worker.subscribe(() => {
    if (worker.snapshot().phase === 'waking') cancel.abort(new Error('recording cancelled'))
  })
  await expect(worker.transcribe({ audio, language: 'zh' }, cancel.signal)).rejects.toThrow('recording cancelled')
  expect(worker.snapshot().phase).toBe('standby')
  expect(worker.snapshot().steps?.find(step => step.kind === 'load')?.status).toBe('cancelled')
  unsubscribe()
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
})

it('launches source workers through the repository ESM loader', async () => {
  const { worker, spawn, root } = await fixture()
  vi.mocked(prepareRuntime).mockResolvedValueOnce({ tokens: root, worker: fileURLToPath(new URL('./worker-source.fixture.ts', import.meta.url)), model: root, vad: root })
  await prepare(worker)
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
  expect(spawn.mock.calls[0]?.[0].argv).toContain('--import')
})

it('requires explicit preparation before direct transcription without starting downloads', async () => {
  const { worker, spawn } = await fixture()
  await expect(worker.transcribe({ audio, language: 'zh' }, signal())).rejects.toThrow('Prepare')
  expect(worker.snapshot().phase).toBe('unprepared')
  expect(prepareRuntime).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it('rechecks readiness after a queued cache inspection without implicitly downloading missing resources', async () => {
  const { worker, root, spawn } = await fixture()
  vi.mocked(inspectRuntime).mockResolvedValueOnce({ tokens: root, model: root, vad: root,
    worker: fileURLToPath(new URL('./worker.fixture.mjs', import.meta.url)) })
  worker.inspect()
  await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('standby') })
  vi.mocked(inspectRuntime).mockResolvedValueOnce(undefined)
  worker.inspect()
  await expect(worker.transcribe({ audio, language: 'zh' }, signal())).rejects.toThrow('Prepare')
  expect(worker.snapshot().phase).toBe('unprepared')
  expect(prepareRuntime).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it.each(['ready', 'standby', 'unprepared', 'failed'] as const)('joins cancellation at committed %s without replacing its result', async (phase) => {
  const { worker, root, spawn } = await fixture()
  const cancellation = Promise.withResolvers<Promise<void>>()
  const unsubscribe = worker.subscribe(() => {
    if (worker.snapshot().phase === phase) cancellation.resolve(worker.cancel())
  })
  try {
    if (phase === 'ready') worker.prepare()
    else {
      if (phase === 'failed') vi.mocked(inspectRuntime).mockRejectedValueOnce(new Error('cache unavailable'))
      else vi.mocked(inspectRuntime).mockResolvedValueOnce(phase === 'standby'
        ? { tokens: root, model: root, vad: root, worker: fileURLToPath(new URL('./worker.fixture.mjs', import.meta.url)) }
        : undefined)
      worker.inspect()
    }
    await cancellation.promise
    expect(worker.snapshot().phase).toBe(phase)
    if (phase === 'ready' || phase === 'standby') {
      expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
      expect(spawn).toHaveBeenCalledOnce()
    } else {
      await expect(worker.transcribe({ audio, language: 'zh' }, signal())).rejects.toThrow('Prepare')
      expect(spawn).not.toHaveBeenCalled()
      await prepare(worker)
      expect(worker.snapshot().phase).toBe('ready')
    }
  } finally { unsubscribe() }
})

it('cancels a queued preparation before any resources are acquired', async () => {
  const { worker, spawn } = await fixture()
  worker.prepare()
  await worker.cancel()
  expect(worker.snapshot().phase).toBe('cancelled')
  expect(prepareRuntime).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it('reuses a loaded worker only after explicitly classified input rejection', async () => {
  const { worker, spawn } = await fixture()
  await prepare(worker)
  await expect(worker.transcribe({ audio, language: 'invalid-input' }, signal())).rejects.toThrow('invalid input')
  expect(worker.snapshot().phase).toBe('ready')
  expect((await worker.transcribe({ audio, language: 'en' }, signal())).text).toBe('en')
  expect(spawn).toHaveBeenCalledOnce()
  await expect(worker.transcribe({ audio, language: 'error' }, signal())).rejects.toThrow('provider failed')
  expect(worker.snapshot().phase).toBe('standby')
  expect((await worker.transcribe({ audio, language: 'zh' }, signal())).text).toBe('zh')
  expect(spawn).toHaveBeenCalledTimes(2)
})
