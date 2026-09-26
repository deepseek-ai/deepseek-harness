/** Disk output, resource bounds, and cancellation around the external kit. */
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OfficeToPdf, { Config, OfficeSourceKey, type OfficeToPdfRequest } from '../src/index.ts'

const kit = vi.hoisted(() => ({ create: vi.fn<(options?: ConverterOptions) => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))

const pdf = Buffer.from('%PDF-1.7\npreview\n%%EOF\n')
const input = new Uint8Array([80, 75, 3, 4])
const request: OfficeToPdfRequest = { extension: 'docx', priority: 'foreground', source: {
  key: OfficeSourceKey('source'), version: 'v1', bytes: input.length,
  read: async () => ({ bytes: input, version: 'v1' }),
} }
function distinct(index: number): OfficeToPdfRequest {
  return { ...request, source: { ...request.source, key: OfficeSourceKey(`source-${index}`),
    read: async () => ({ bytes: new Uint8Array([80, 75, 3, index]), version: 'v1' }) } }
}
let ctx: Context
let render: ReturnType<typeof vi.fn<Converter['render']>>
let dispose: ReturnType<typeof vi.fn<Converter['dispose']>>
let converter: Converter

beforeEach(() => {
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

async function mount(config: Partial<Config> = {}): Promise<OfficeToPdf> {
  await ctx.plugin(OfficeToPdf, config)
  return ctx.officeToPdf
}

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
    maxSourceEntries: _aliases, ...options } = config
  expect(kit.create).toHaveBeenCalledExactlyOnceWith(options)
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
  expect(() => new OfficeToPdf(ctx, Config({ fontDirectories: ['relative/fonts'] })))
    .toThrow('fontDirectories must contain absolute paths')
})

it('rejects source capacity below one permitted input before allocating a converter', () => {
  expect(() => new OfficeToPdf(ctx, Config({ maxInputBytes: 4, maxSourceBytes: 3 })))
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
