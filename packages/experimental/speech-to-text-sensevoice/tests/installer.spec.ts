/** ONNX preparation reuses verified files and honors explicit offline deployments. */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { inspectRuntime, prepareRuntime, type Asset } from '../src/runtime.ts'
import { Config } from '../src/config.ts'
import * as Provider from '../src/index.ts'

const bytes = Buffer.from('pinned ONNX fixture')
const asset = (name: string): Asset => ({ name, url: `https://huggingface.co/owner/model/resolve/revision/${name}`,
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
const fake = vi.hoisted(() => ({ lock: {} }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, access: vi.fn(actual.access), rename: vi.fn(actual.rename) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] instanceof URL && args[0].pathname.endsWith('/runtime/assets.json')) return JSON.stringify(fake.lock)
    return actual.readFileSync(...args)
  } }
})
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('restores verified cached models on every provider activation without downloads or a worker', async () => {
  const { root, fetcher } = await fixture(), config = Config({ dataRoot: root })
  await prepareRuntime(new Context(), config, new AbortController().signal)
  fetcher.mockClear()
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(SpeechToText, { defaultProvider: 'sensevoice-local', language: 'auto' })
    const spawn = vi.spyOn(ctx.get('subprocess')!, 'spawn'), speech = ctx.get('speechToText')!
    for (let activation = 0; activation < 2; activation++) {
      const fiber = ctx.plugin(Provider, config)
      await fiber
      await vi.waitFor(() => { expect(speech.snapshot().providers[0]?.preparation.phase).toBe('standby') })
      expect(speech.snapshot().providers[0]?.preparation.steps?.map(({ kind, status }) => [kind, status])).toEqual([
        ['check', 'complete'], ['model', 'complete'], ['vad', 'complete'], ['verify', 'complete'], ['load', 'pending'],
      ])
      expect(fetcher).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      await fiber.dispose()
      expect(speech.snapshot().providers).toEqual([])
    }
  } finally { await ctx.fiber.dispose() }
})

it.each(['model', 'tokens', 'vad'] as const)('requires preparation for a missing or corrupted cached %s', async (file) => {
  const { root, fetcher } = await fixture(), config = Config({ dataRoot: root }), signal = new AbortController().signal
  const paths = await prepareRuntime(new Context(), config, signal)
  fetcher.mockClear()
  expect(await inspectRuntime(config, signal)).toEqual(paths)
  await writeFile(paths[file], Buffer.alloc(bytes.length))
  expect(await inspectRuntime(config, signal)).toBeUndefined()
  await rm(paths[file])
  expect(await inspectRuntime(config, signal)).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
})

it('inspects an empty cache without creating it and respects precision and offline paths', async () => {
  const { root, fetcher } = await fixture(), signal = new AbortController().signal
  const missingRoot = join(root, 'absent')
  expect(await inspectRuntime(Config({ dataRoot: missingRoot }), signal)).toBeUndefined()
  await expect(readFile(missingRoot)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
  const config = Config({ dataRoot: root }), paths = await prepareRuntime(new Context(), config, signal)
  expect(await inspectRuntime(Config(Object.assign({}, config, { precision: 'fp32' })), signal)).toBeUndefined()
  expect(await inspectRuntime(Config(Object.assign({}, config, { modelDirectory: join(root, 'models', 'sensevoice-onnx'), vadModelPath: paths.vad })), signal)).toEqual(paths)
})

it('reports filesystem access errors instead of treating unreadable caches as absent', async () => {
  const { root, fetcher } = await fixture()
  const failure = Object.assign(new Error('cache is not readable'), { code: 'EACCES' })
  vi.mocked(access).mockRejectedValueOnce(failure)
  await expect(inspectRuntime(Config({ dataRoot: root }), new AbortController().signal)).rejects.toBe(failure)
  expect(fetcher).not.toHaveBeenCalled()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-onnx-')); roots.push(root)
  fake.lock = { models: { int8: asset('model.int8.onnx'), fp32: asset('model.onnx') }, tokens: asset('tokens.txt'), vad: asset('silero_vad.onnx') }
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(bytes)); vi.stubGlobal('fetch', fetcher)
  return { root, fetcher }
}
it.each(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])('prepares only model files on %s', async (target) => {
  const { root, fetcher } = await fixture(), [platform, arch] = target.split('-')
  vi.stubGlobal('process', { ...process, platform, arch })
  const report = vi.fn<(state: SpeechPreparationState) => void>()
  const config = Config({ dataRoot: root, modelOrigin: 'https://mirror.example' })
  const runtime = await prepareRuntime(new Context(), config, new AbortController().signal, report)
  expect(await readFile(runtime.model)).toEqual(bytes)
  expect(runtime.tokens).toContain('tokens.txt')
  expect(runtime.vad).toContain('silero_vad.onnx')
  expect(report.mock.calls.map(([state]) => state.step)).toEqual(expect.arrayContaining(['model', 'vad', 'verify']))
  expect(report.mock.calls.map(([state]) => state.phase)).not.toContain('installing')
  expect(fetcher.mock.calls.every(args => args[0].startsWith('https://mirror.example/'))).toBe(true)
  await prepareRuntime(new Context(), config, new AbortController().signal)
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it('selects FP32 explicitly and skips downloads for existing model paths', async () => {
  const { root, fetcher } = await fixture()
  const config = Config({ dataRoot: root, precision: 'fp32' })
  const runtime = await prepareRuntime(new Context(), config, new AbortController().signal)
  expect(runtime.model).toMatch(/model\.onnx$/)
  fetcher.mockClear()
  const offline = await prepareRuntime(new Context(), Config(Object.assign({}, config, { modelDirectory: join(root, 'models', 'sensevoice-onnx'),
    vadModelPath: runtime.vad })), new AbortController().signal)
  expect(offline).toEqual(runtime)
  expect(fetcher).not.toHaveBeenCalled()
  await rm(runtime.model)
  const missing = Config(Object.assign({}, config, { modelDirectory: root, vadModelPath: runtime.vad }))
  await expect(prepareRuntime(new Context(), missing, new AbortController().signal)).rejects.toThrow()
})
it('rejects unsupported platforms, invalid model paths and cancelled preparation', async () => {
  const { root } = await fixture()
  const config = Config({ dataRoot: root })
  vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'arm64' })
  await expect(prepareRuntime(new Context(), config, new AbortController().signal)).rejects.toThrow('unavailable')
  vi.unstubAllGlobals()
  await mkdir(join(root, 'models', 'sensevoice-onnx', 'model.int8.onnx'), { recursive: true })
  await expect(prepareRuntime(new Context(), config, new AbortController().signal)).rejects.toThrow()
  await writeFile(join(root, 'model.int8.onnx'), bytes); await writeFile(join(root, 'tokens.txt'), bytes)
  await expect(prepareRuntime(new Context(), Config({ dataRoot: root, modelDirectory: root, vadModelPath: join(root, 'tokens.txt') }),
    AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
})

it('rejects cached files changed before the final verification stage', async () => {
  const { root } = await fixture()
  await expect(prepareRuntime(new Context(), Config({ dataRoot: root }), new AbortController().signal, (state) => {
    if (state.step === 'verify') writeFileSync(join(root, 'models', 'sensevoice-onnx', 'model.int8.onnx'), 'changed')
  })).rejects.toThrow('verification failed')
})

it('downloads missing assets from the first responsive mirror and reuses verified files without probes', async () => {
  const { root, fetcher } = await fixture()
  fetcher.mockImplementation(async (url, init) => init?.method === 'HEAD'
    ? new Response(null, { status: url.startsWith('https://hf-mirror.com/') ? 200 : 503 }) : new Response(bytes))
  const config = Config({ dataRoot: root })
  await prepareRuntime(new Context(), config, new AbortController().signal)
  const downloads = fetcher.mock.calls.filter(([, init]) => init?.method !== 'HEAD').map(([url]) => url)
  expect(downloads).toEqual(['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']
    .map(name => `https://hf-mirror.com/owner/model/resolve/revision/${name}`))
  fetcher.mockClear()
  await prepareRuntime(new Context(), config, new AbortController().signal)
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['http', 'network', 'integrity'] as const)('falls back after a %s failure without accepting unverified bytes', async (reason) => {
  const { root, fetcher } = await fixture()
  fetcher.mockImplementation(async (url, init) => {
    const mirror = url.startsWith('https://hf-mirror.com/')
    if (init?.method === 'HEAD') return new Response(null, { status: mirror ? 200 : 503 })
    if (!mirror) return new Response(bytes)
    if (reason === 'network') throw new TypeError('fetch failed')
    return reason === 'http' ? new Response('unavailable', { status: 503 }) : new Response('corrupt')
  })
  const paths = await prepareRuntime(new Context(), Config({ dataRoot: root }), new AbortController().signal)
  expect(await readFile(paths.model)).toEqual(bytes)
  const downloads = fetcher.mock.calls.filter(([, init]) => init?.method !== 'HEAD').map(([url]) => new URL(url).origin)
  expect(downloads).toEqual(['https://hf-mirror.com', 'https://huggingface.co',
    'https://hf-mirror.com', 'https://huggingface.co', 'https://hf-mirror.com', 'https://huggingface.co'])
})

it.each(['EACCES', 'unclassified'])('does not switch sources for a local publication failure (%s)', async (code) => {
  const { root, fetcher } = await fixture()
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cannot publish'), { code }))
  await expect(prepareRuntime(new Context(), Config({ dataRoot: root }), new AbortController().signal)).rejects.toMatchObject({
    download: { reason: code === 'EACCES' ? 'storage' : 'unknown' },
  })
  expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'HEAD')).toHaveLength(1)
})

it('does not switch sources after cancellation during a download', async () => {
  const { root, fetcher } = await fixture(), abort = new AbortController(), reason = new Error('cancelled')
  fetcher.mockImplementation(async (_url, init) => {
    if (init?.method === 'HEAD') return new Response(null)
    abort.abort(reason); throw reason
  })
  await expect(prepareRuntime(new Context(), Config({ dataRoot: root }), abort.signal)).rejects.toBe(reason)
  expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'HEAD')).toHaveLength(1)
})

it('reports the final source when every download fails', async () => {
  const { root, fetcher } = await fixture()
  fetcher.mockResolvedValue(new Response(null, { status: 503 }))
  await expect(prepareRuntime(new Context(), Config({ dataRoot: root }), new AbortController().signal)).rejects.toMatchObject({
    download: { source: 'https://hf-mirror.com', reason: 'http', status: 503 },
  })
  expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'HEAD')).toHaveLength(2)
})
