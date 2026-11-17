/** Disk output, resource bounds, and cancellation around the external kit. */
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeKit, { Config, type OfficeSourceKey, type OfficeKitRequest } from '../src/index.ts'
import { resolveKitModule, type KitModuleResolution } from '../src/locate.ts'
import { expectDefaultOutputsUntouched } from './default-outputs.ts'

const home = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  return mkdtemp(`${tmpdir()}/dsh-office-kit-home-`)
})
vi.mock('@deepseek-ai/dsh-home-paths', async (original) => {
  const path = await import('node:path')
  return { ...await original<typeof import('@deepseek-ai/dsh-home-paths')>(), dshHomePath: (...segments: string[]) => path.join(home, ...segments) }
})
expectDefaultOutputsUntouched(home)

vi.mock('../src/locate.ts', async (original) => {
  const actual = await original<typeof import('../src/locate.ts')>()
  return { ...actual, resolveKitModule: vi.fn(actual.resolveKitModule) }
})

const kit = vi.hoisted(() => ({ create: vi.fn<(options?: ConverterOptions) => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))

const absentKit = Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' })
const pdf = Buffer.from('%PDF-1.7\npreview\n%%EOF\n')
const input = new Uint8Array([80, 75, 3, 4])
const request: OfficeKitRequest = { extension: 'docx', priority: 'foreground', source: {
  key: brandString<OfficeSourceKey>('source'), version: 'v1', bytes: input.length,
  read: async () => ({ bytes: input, version: 'v1' }),
} }
function distinct(index: number): OfficeKitRequest {
  return { ...request, source: { ...request.source, key: brandString<OfficeSourceKey>(`source-${index}`),
    read: async () => ({ bytes: new Uint8Array([80, 75, 3, index]), version: 'v1' }) } }
}
let ctx: Context
let render: ReturnType<typeof vi.fn<Converter['render']>>
let dispose: ReturnType<typeof vi.fn<Converter['dispose']>>
let converter: Converter

beforeEach(() => {
  vi.mocked(resolveKitModule).mockClear()
  ctx = new Context()
  render = vi.fn<Converter['render']>().mockImplementation(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: ['Missing Serif'] }
  })
  dispose = vi.fn<Converter['dispose']>().mockResolvedValue(undefined)
  converter = {
    backend: 'native', render, dispose,
    renderImages: vi.fn<Converter['renderImages']>().mockRejectedValue(new Error('Unexpected Converter.renderImages call')),
    convert: vi.fn<Converter['convert']>().mockRejectedValue(new Error('Unexpected Converter.convert call')),
    recalculate: vi.fn<Converter['recalculate']>().mockRejectedValue(new Error('Unexpected Converter.recalculate call')),
  }
  kit.create.mockReset().mockImplementation(async () => ({ ...converter }))
})
afterEach(async () => { await ctx.fiber.dispose() })

async function mount(config: Partial<Config> = {}): Promise<OfficeKit> {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-office-kit-outputs-'))
  // Runs after the afterEach provider disposal, which deletes the provider's own outputs first.
  onTestFinished(() => rm(outputDirectory, { recursive: true, force: true }))
  await ctx.plugin(OfficeKit, { ...config, outputDirectory })
  return ctx.officeKit
}

function resolvedKit(): Extract<KitModuleResolution, { kind: 'available' }> {
  const resolution = vi.mocked(resolveKitModule).mock.results[0]
  if (resolution?.type !== 'return' || resolution.value.kind !== 'available') throw new Error('Expected an available Kit')
  return resolution.value
}

it('loads its own Kit installation and passes the engine resolver anchored there to the converter', async () => {
  const provider = await mount()
  await provider.convert(request)
  expect(vi.mocked(resolveKitModule).mock.calls[0]?.[0]()).toBe(import.meta.resolve('@deepseek-ai/libreoffice-kit'))
  expect(resolvedKit().entry).toBe(import.meta.resolve('@deepseek-ai/libreoffice-kit'))
  expect(kit.create.mock.calls[0]?.[0]?.resolveEnginePackage).toBe(resolvedKit().resolveEnginePackage)
})

it.each([
  ['missing', 'not installed', (): KitModuleResolution => ({ kind: 'missing', error: absentKit })],
  ['unloadable', 'could not be loaded', (): KitModuleResolution => ({
    kind: 'available', entry: new URL('./absent-kit.js', import.meta.url).href, resolveEnginePackage: () => { throw absentKit },
  })],
])('registers the provider with a %s Kit, rejects every conversion as unavailable, and reports the failure once', async (_state, message, resolution) => {
  vi.mocked(resolveKitModule).mockImplementation(resolution)
  onTestFinished(() => { vi.mocked(resolveKitModule).mockReset() })
  const warn = vi.fn()
  ctx.logger.warn = warn
  const provider = await mount()
  expect(resolveKitModule).not.toHaveBeenCalled()
  for (const attempt of [request, distinct(1)]) {
    const failure = await provider.convert(attempt).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'OfficeKitError', code: 'unavailable' })
    expect(String(failure)).toContain(message)
    expect(String(failure)).toContain('This deployment does not provide LibreOffice Kit; install or enable it as this deployment requires, then retry.')
  }
  expect(resolveKitModule).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledOnce()
  expect(kit.create).not.toHaveBeenCalled()
})

it('reports each distinct Kit failure once', async () => {
  const failures: unknown[] = [new Error('first'), 'second', new Error('first'), 'second']
  for (const error of failures) vi.mocked(resolveKitModule).mockReturnValueOnce({ kind: 'missing', error })
  const warn = vi.fn<(error: Error) => void>()
  ctx.logger.warn = warn
  const provider = await mount()
  for (const index of failures.keys()) {
    await expect(provider.convert(distinct(index))).rejects.toMatchObject({ code: 'unavailable' })
  }
  expect(warn.mock.calls.map(([error]) => error.cause)).toEqual([failures[0], failures[1]])
})

it.each([
  ['missing', (): KitModuleResolution => ({ kind: 'missing', error: absentKit })],
  ['unloadable', (): KitModuleResolution => ({
    kind: 'available', entry: new URL('./absent-kit.js', import.meta.url).href, resolveEnginePackage: () => { throw absentKit },
  })],
])('locates Kit again after a %s Kit failure and converts once Kit is available', async (_state, resolution) => {
  vi.mocked(resolveKitModule).mockReturnValueOnce(resolution())
  ctx.logger.warn = vi.fn()
  const provider = await mount()
  await expect(provider.convert(request)).rejects.toMatchObject({ code: 'unavailable' })
  const result = await provider.convert(distinct(1))
  expect(Buffer.from(result.pdf)).toEqual(pdf)
  expect(resolveKitModule).toHaveBeenCalledTimes(2)
  expect(kit.create).toHaveBeenCalledOnce()
  await provider.convert(distinct(2))
  expect(resolveKitModule).toHaveBeenCalledTimes(2)
})

it('preserves the kit font defaults when font configuration is omitted', async () => {
  const provider = await mount()
  await provider.convert(request)
  expect(kit.create.mock.calls[0]![0]).not.toHaveProperty('fontDirectories')
  expect(kit.create.mock.calls[0]![0]).not.toHaveProperty('fontFallbacks')
  expect(Config({ fontDirectories: [] }).fontDirectories).toEqual([])
  expect(Config({ fontFallbacks: [] }).fontFallbacks).toEqual([])
  expect(() => Config({ fontDirectories: [''] })).toThrow()
})

it.each([
  [[]],
  [['sans-serif']],
  [['sans-serif', '']],
  [['sans-serif', ' \t\n ']],
])('rejects invalid font preference groups %j before creating a converter', (...fontFallbacks) => {
  expect(() => Config({ fontFallbacks })).toThrow()
  expect(kit.create).not.toHaveBeenCalled()
})

it('passes configured limits to the kit, reuses the converter, and removes all scratch files', async () => {
  const config = Config({ maxConcurrentConversions: 1, maxInputBytes: 4, maxOutputBytes: pdf.length,
    maxImageResolution: 144, maxArchiveEntries: 32, maxUncompressedBytes: 4096,
    timeoutMs: 321, fontDirectories: [], fontFallbacks: [['sans-serif', 'Arial'], ['serif', 'Times New Roman']],
    maxFontFiles: 12, maxFontFileBytes: 4096, maxLoadedFontBytes: 8192 })
  const provider = await mount(config)
  let scratch = ''
  render.mockImplementation(async ({ inputPath, outputPath }) => {
    scratch = dirname(inputPath)
    expect(await readFile(inputPath)).toEqual(Buffer.from(input))
    if (process.platform !== 'win32') {
      expect((await stat(scratch)).mode & 0o777).toBe(0o700)
      expect((await stat(inputPath)).mode & 0o777).toBe(0o600)
    }
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: ['Missing Serif'] }
  })
  const result = await provider.convert(request)
  expect(result).toMatchObject({ pdf: Uint8Array.from(pdf), missingFonts: ['Missing Serif'] })
  await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
  await provider.convert(request)
  const { maxConcurrentConversions: _count, maxQueuedJobs: _queued, maxReaders: _readers, maxSourceBytes: _source,
    maxBackgroundConversions: _background, maxCachedEntries: _entries, maxCachedBytes: _cached,
    maxSourceEntries: _aliases, outputDirectory: _outputs, outputRetentionMs: _retention, maxOutputStoreBytes: _stored,
    ...options } = config
  expect(kit.create).toHaveBeenCalledExactlyOnceWith({ ...options, resolveEnginePackage: resolvedKit().resolveEnginePackage })
  await ctx.fiber.dispose()
  expect(dispose).toHaveBeenCalledOnce()
  expect(result.pdf).toEqual(Uint8Array.from(pdf))
})

it('refuses an oversized input before allocating a converter', async () => {
  const provider = await mount({ maxInputBytes: 3 })
  await expect(provider.convert(request)).rejects.toMatchObject({ code: 'input-too-large' })
  expect(kit.create).not.toHaveBeenCalled()
})

it.each(['missing', 'directory', 'not-pdf', 'incomplete', 'too-large'] as const)('rejects %s kit output and removes its directory', async (kind) => {
  const provider = await mount({ maxOutputBytes: pdf.length })
  let scratch = ''
  render.mockImplementation(async ({ inputPath, outputPath }) => {
    scratch = dirname(inputPath)
    if (kind === 'directory') await mkdir(outputPath)
    else if (kind === 'not-pdf') await writeFile(outputPath, 'engine diagnostic')
    else if (kind === 'incomplete') await writeFile(outputPath, '%PDF-1.7\n')
    else if (kind === 'too-large') await writeFile(outputPath, Buffer.concat([pdf, pdf]))
    return { backend: 'wasm', missingFonts: [] }
  })
  await expect(provider.convert(request)).rejects.toMatchObject({ code: kind === 'too-large' ? 'output-too-large' : 'invalid-output' })
  await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retries initialization after a failed kit factory and reports unclassified errors', async () => {
  const provider = await mount()
  kit.create.mockRejectedValueOnce(Object.assign(new Error('absent asset'), { code: 'unavailable' }))
  await expect(provider.convert(request)).rejects.toMatchObject({ code: 'unavailable' })
  expect(await provider.convert(request)).toMatchObject({ pdf: Uint8Array.from(pdf), missingFonts: ['Missing Serif'] })
  expect(kit.create).toHaveBeenCalledTimes(2)
  render.mockRejectedValueOnce(new Error('unexpected engine failure'))
  await expect(provider.convert(distinct(9))).rejects.toMatchObject({ code: 'failed' })
})

it.each([
  'input-too-large', 'output-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'timeout', 'unavailable',
] as const)('preserves the kit %s failure for the document consumer', async (code) => {
  const provider = await mount()
  const cause = Object.assign(new Error('conversion failed'), { code })
  render.mockRejectedValueOnce(cause)
  await expect(provider.convert(request)).rejects.toMatchObject({ code, cause })
})

it('cancels a queued caller without starting or stopping another conversion', async () => {
  const provider = await mount({ maxConcurrentConversions: 1 })
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  render.mockImplementationOnce(async ({ outputPath }, signal) => {
    entered.resolve(signal!)
    await release.promise
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  })
  const first = provider.convert(request)
  try {
    const activeSignal = await entered.promise
    const controller = new AbortController()
    const second = provider.convert(request, controller.signal)
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve(undefined)
    controller.abort()
    await rejected
    expect(render).toHaveBeenCalledOnce()
    expect(activeSignal.aborted).toBe(false)
  } finally { release.resolve(undefined); await first }
  expect(await provider.convert(request)).toHaveProperty('pdf')
})

it('bounds active converters and resumes queued work when a slot becomes free', async () => {
  const provider = await mount({ maxConcurrentConversions: 2 })
  const both = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let calls = 0
  render.mockImplementation(async ({ outputPath }) => {
    if (++calls === 2) both.resolve(undefined)
    await release.promise
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: [] }
  })
  const work = [provider.convert(distinct(1)), provider.convert(distinct(2)), provider.convert(distinct(3))]
  try {
    await both.promise
    expect(kit.create).toHaveBeenCalledTimes(2)
    expect(render).toHaveBeenCalledTimes(2)
  } finally { release.resolve(undefined); await Promise.all(work) }
  expect(render).toHaveBeenCalledTimes(3)
  expect(kit.create).toHaveBeenCalledTimes(2)
})

it.each(['caller', 'provider'] as const)('joins late kit completion and scratch cleanup after %s cancellation', async (owner) => {
  const provider = await mount()
  const entered = Promise.withResolvers<{ signal: AbortSignal; scratch: string }>()
  const release = Promise.withResolvers<undefined>()
  render.mockImplementation(async ({ inputPath, outputPath }, signal) => {
    entered.resolve({ signal: signal!, scratch: dirname(inputPath) })
    await release.promise
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: [] }
  })
  const caller = new AbortController()
  const work = provider.convert(request, caller.signal)
  const rejected = expect(work).rejects.toMatchObject(owner === 'caller' ? { name: 'AbortError' } : { code: 'unavailable' })
  const { signal, scratch } = await entered.promise
  let settled = false
  const observed = work.then(() => { settled = true }, () => { settled = true })
  let closing: Promise<void> | undefined
  try {
    if (owner === 'caller') caller.abort()
    else closing = ctx.fiber.dispose()
    await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
    await rejected
    await observed
    expect(settled).toBe(true)
    await access(scratch)
  } finally { release.resolve(undefined); await rejected; await observed; await closing; await ctx.fiber.dispose() }
  await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
  if (owner === 'provider') expect(dispose).toHaveBeenCalledOnce()
})

it('joins initialization during disposal and never starts a render after cancellation', async () => {
  const provider = await mount()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<Converter>()
  kit.create.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
  const work = provider.convert(request)
  const rejected = expect(work).rejects.toMatchObject({ code: 'unavailable' })
  await entered.promise
  const closing = ctx.fiber.dispose()
  release.resolve({ ...converter, backend: 'wasm' })
  await rejected
  await closing
  expect(render).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
  await expect(provider.convert(request)).rejects.toMatchObject({ code: 'unavailable' })
})

it('rejects caller cancellation before allocating any conversion resources', async () => {
  const provider = await mount()
  const reason = new Error('caller cancelled')
  await expect(provider.convert(request, AbortSignal.abort(reason))).rejects.toBe(reason)
  expect(kit.create).not.toHaveBeenCalled()
})

it('rejects relative font directories during provider configuration', async () => {
  expect(() => new OfficeKit(ctx, Config({ fontDirectories: ['relative/fonts'] })))
    .toThrow('fontDirectories must contain absolute paths')
})

it('rejects source capacity below one permitted input before allocating a converter', () => {
  expect(() => new OfficeKit(ctx, Config({ maxInputBytes: 4, maxSourceBytes: 3 })))
    .toThrow('maxSourceBytes must be at least maxInputBytes')
  expect(kit.create).not.toHaveBeenCalled()
})

it('joins every converter disposal before reporting an engine cleanup failure', async () => {
  const provider = await mount({ maxConcurrentConversions: 2 })
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const cleanupEntered = Promise.withResolvers<undefined>()
  const cleanupRelease = Promise.withResolvers<undefined>()
  let conversions = 0
  render.mockImplementation(async ({ outputPath }) => {
    if (++conversions === 2) entered.resolve(undefined)
    await released.promise
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: [] }
  })
  const failed = new Error('engine cleanup failed')
  kit.create.mockReset()
    .mockResolvedValueOnce({ ...converter, dispose: async () => { throw failed } })
    .mockResolvedValueOnce({ ...converter, dispose: async () => { cleanupEntered.resolve(undefined); await cleanupRelease.promise } })
  const work = [provider.convert(distinct(1)), provider.convert(distinct(2))]
  try { await entered.promise } finally { released.resolve(undefined); await Promise.all(work) }
  let disposed = false
  const closing = ctx.fiber.dispose().then(() => { disposed = true })
  try {
    await cleanupEntered.promise
    expect(disposed).toBe(false)
  } finally { cleanupRelease.resolve(undefined); await closing }
})
