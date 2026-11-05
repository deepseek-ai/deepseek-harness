/** Image rendering, format conversion, and recalculation read bounded engine output from private scratch files. */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Converter, RenderImagesRequest, RenderImagesResult, RenderedImage } from '@deepseek-ai/libreoffice-kit'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import OfficeKit, { Config, OfficeSourceKey, type OfficeKitSource, type OfficeImagesRequest } from '../src/index.ts'

const kit = vi.hoisted(() => ({ create: vi.fn<() => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))

/** Holds output-store deletions under `root` until `gate` settles. */
const outputDeletion = vi.hoisted(() => ({ root: undefined as string | undefined, gate: undefined as Promise<void> | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rm(...args: Parameters<typeof actual.rm>) {
      const [path] = args
      if (outputDeletion.root !== undefined && typeof path === 'string' && path.startsWith(outputDeletion.root)) await outputDeletion.gate
      return actual.rm(...args)
    },
  }
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const PDF = Buffer.from('%PDF-1.7\nconverted\n%%EOF\n')
const XLSX = Buffer.from([80, 75, 3, 4, 9])

function source(key = 'source', bytes = new Uint8Array([80, 75, 3, 4])): OfficeKitSource {
  return { key: OfficeSourceKey(key), version: 'v1', bytes: bytes.length, read: async () => ({ bytes, version: 'v1' }) }
}

const limits = { maxImages: 4, maxPixels: 1_000_000, maxDimension: 4096, maxBytes: 1024 } as const
function imagesRequest(overrides: Partial<OfficeImagesRequest> = {}): OfficeImagesRequest {
  return { extension: 'pptx', source: source(), ...limits, ...overrides }
}

function image(request: RenderImagesRequest, index: number, fields: Partial<RenderedImage> = {}): RenderedImage {
  return { index, path: join(request.outputDir, `image-${index}.png`), width: 10 + index, height: 20,
    rectangle: { x: 0, y: 0, width: 1, height: 1 }, byteLength: PNG.length, ...fields }
}

async function writeImages(
  request: RenderImagesRequest, images: readonly RenderedImage[], data: Buffer = PNG,
): Promise<RenderImagesResult> {
  await mkdir(request.outputDir)
  for (const entry of images) await writeFile(entry.path, data)
  return { schemaVersion: 1, backend: 'native', rasterEngine: 'libreoffice', source: 'saved', inputPath: request.inputPath,
    sourceSha256: 'digest', dpi: request.dpi ?? 144, pageCount: 3, images, missingFonts: ['Missing Sans'] }
}

let ctx: Context
type Mocked<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? ReturnType<typeof vi.fn<T[K]>> : T[K] }
let converter: Mocked<Converter>

beforeEach(() => {
  ctx = new Context()
  converter = {
    backend: 'native',
    render: vi.fn<Converter['render']>().mockRejectedValue(new Error('Unexpected Converter.render call')),
    renderImages: vi.fn<Converter['renderImages']>().mockImplementation(async request => writeImages(request, [image(request, 1), image(request, 0)])),
    convert: vi.fn<Converter['convert']>().mockImplementation(async ({ outputPath }) => {
      await writeFile(outputPath, outputPath.endsWith('.pdf') ? PDF : XLSX)
      return { backend: 'native', missingFonts: [] }
    }),
    recalculate: vi.fn<Converter['recalculate']>().mockImplementation(async ({ outputPath }) => {
      await writeFile(outputPath, XLSX)
      return { backend: 'native', missingFonts: ['Calc Font'] }
    }),
    dispose: vi.fn<Converter['dispose']>().mockResolvedValue(undefined),
  }
  kit.create.mockReset().mockImplementation(async () => converter)
})
afterEach(async () => {
  outputDeletion.root = undefined
  outputDeletion.gate = undefined
  await ctx.fiber.dispose()
})

async function mount(config: Partial<Config> = {}): Promise<OfficeKit> {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-office-kit-outputs-'))
  onTestFinished(() => rm(outputDirectory, { recursive: true, force: true }))
  await ctx.plugin(OfficeKit, { outputDirectory, ...config })
  return ctx.officeKit
}

it('renders selected images in document order with their locations and passes the limits to the engine', async () => {
  const provider = await mount()
  converter.renderImages.mockImplementationOnce(async request => writeImages(request, [
    image(request, 1, { page: 3 }), image(request, 0, { sheet: 'Data', range: 'A1:B2' }),
  ]))
  const result = await provider.renderImages(imagesRequest({ pages: [3, 1], dpi: 96 }))
  expect(result).toEqual({
    images: [
      { png: Uint8Array.from(PNG), width: 10, height: 20, sheet: 'Data', range: 'A1:B2' },
      { png: Uint8Array.from(PNG), width: 11, height: 20, page: 3 },
    ],
    pageCount: 3, dpi: 96, missingFonts: ['Missing Sans'],
  })
  const [request] = converter.renderImages.mock.calls[0]!
  expect(request).toMatchObject({ pages: [3, 1], dpi: 96, maxPages: 4, maxPixels: 1_000_000, maxDimension: 4096 })
  expect(request.inputPath.endsWith('source.pptx')).toBe(true)
  await expect(access(dirname(request.inputPath))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('passes worksheet selections and returns independent copies of a cached rendering', async () => {
  const provider = await mount()
  const request = imagesRequest({ extension: 'xlsx', sheet: 'Data', range: 'A1:C9' })
  const first = await provider.renderImages(request)
  first.images[0]!.png[0] = 0
  const second = await provider.renderImages(request)
  expect(second.images[0]!.png).toEqual(Uint8Array.from(PNG))
  expect(converter.renderImages).toHaveBeenCalledOnce()
  expect(converter.renderImages.mock.calls[0]![0]).toMatchObject({ sheet: 'Data', range: 'A1:C9' })
  expect(converter.renderImages.mock.calls[0]![0]).not.toHaveProperty('pages')
})

it('caches renderings separately for distinct selections of one source', async () => {
  const provider = await mount()
  await provider.renderImages(imagesRequest({ pages: [1] }))
  await provider.renderImages(imagesRequest({ pages: [2] }))
  expect(converter.renderImages).toHaveBeenCalledTimes(2)
})

it.each([
  ['declared bytes above the limit', { maxBytes: PNG.length }, 'output-too-large', 'above the 10-byte limit'],
  ['bytes larger than declared', { maxBytes: PNG.length * 2 }, 'output-too-large', undefined],
])('rejects %s for the complete result', async (_label, overrides, code, message) => {
  const provider = await mount()
  converter.renderImages.mockImplementationOnce(async request => writeImages(request,
    [image(request, 0), image(request, 1)], message === undefined ? Buffer.concat([PNG, PNG]) : PNG))
  const failure = provider.renderImages(imagesRequest(overrides))
  await expect(failure).rejects.toMatchObject({ code })
  if (message !== undefined) await expect(failure).rejects.toThrow(message)
})

it.each([
  ['an image outside the output directory', (request: RenderImagesRequest) => image(request, 0, { path: request.inputPath }), PNG],
  ['the output directory itself', (request: RenderImagesRequest) => image(request, 0, { path: request.outputDir }), PNG],
  ['a non-PNG image', (request: RenderImagesRequest) => image(request, 0), Buffer.from('not an image')],
  ['a missing image', (request: RenderImagesRequest) => image(request, 0, { path: join(request.outputDir, 'absent.png') }), PNG],
])('rejects %s as invalid output', async (_label, entry, data) => {
  const provider = await mount()
  converter.renderImages.mockImplementationOnce(async (request) => {
    const result = await writeImages(request, [], data)
    if (data !== PNG) await writeFile(join(request.outputDir, 'image-0.png'), data)
    return { ...result, images: [entry(request)] }
  })
  await expect(provider.renderImages(imagesRequest())).rejects.toMatchObject({ code: 'invalid-output' })
})

it('reports an engine selection rejection with the engine description', async () => {
  const provider = await mount()
  converter.renderImages.mockRejectedValueOnce(new TypeError('sheet and range apply only to worksheets.'))
  await expect(provider.renderImages(imagesRequest({ sheet: 'Data' })))
    .rejects.toMatchObject({ name: 'OfficeKitError', code: 'invalid-request', message: 'sheet and range apply only to worksheets.' })
  converter.renderImages.mockRejectedValueOnce(Object.assign(new Error('Selected page count exceeds maxPages.'), { code: 'output-too-large' }))
  await expect(provider.renderImages(imagesRequest({ source: source('other') })))
    .rejects.toMatchObject({ code: 'output-too-large', message: 'Selected page count exceeds maxPages.' })
  converter.renderImages.mockRejectedValueOnce(Object.assign('engine string', { code: 'timeout' }))
  await expect(provider.renderImages(imagesRequest({ source: source('third') })))
    .rejects.toMatchObject({ code: 'timeout', message: 'LibreOffice conversion failed.' })
})

it.each([
  ['pdf', PDF],
  ['csv', XLSX],
] as const)('converts a document to %s and returns a copy of a cached result', async (format, expected) => {
  const provider = await mount()
  const request = { extension: 'xlsx', format, source: source(),
    output: { owner: 'session', name: `book.${format}` }, ...(format === 'csv' ? { sheet: 'Data' } : {}) } as const
  const result = await provider.convertTo(request)
  expect(result).toEqual({ path: result.path, bytes: expected.length, missingFonts: [] })
  expect(result.path.endsWith(`book.${format}`)).toBe(true)
  expect(await readFile(result.path)).toEqual(expected)
  const second = await provider.convertTo(request)
  expect(second.path).not.toBe(result.path)
  expect(await readFile(second.path)).toEqual(expected)
  expect(converter.convert).toHaveBeenCalledOnce()
  const [call] = converter.convert.mock.calls[0]!
  expect(call.outputPath.endsWith(`output.${format}`)).toBe(true)
  if (format === 'csv') expect(call).toHaveProperty('sheet', 'Data')
  else expect(call).not.toHaveProperty('sheet')
})

it('recalculates a workbook into the requested format', async () => {
  const provider = await mount()
  converter.recalculate.mockImplementationOnce(async ({ outputPath }) => {
    await writeFile(outputPath, XLSX)
    return { backend: 'native', missingFonts: ['Calc Font'], pageCount: 2 }
  })
  const result = await provider.recalculate({ extension: 'xls', format: 'xlsx', source: source(),
    output: { owner: 'session', name: 'book.xlsx' } })
  expect(result).toMatchObject({ bytes: XLSX.length, pageCount: 2, missingFonts: ['Calc Font'] })
  expect(await readFile(result.path)).toEqual(XLSX)
  expect(converter.recalculate.mock.calls[0]![0].outputPath.endsWith('output.xlsx')).toBe(true)
})

it.each([
  ['missing output', async (_path: string) => undefined, 'invalid-output'],
  ['oversized output', async (path: string) => { await writeFile(path, Buffer.alloc(64)) }, 'output-too-large'],
])('rejects %s of a conversion', async (_label, produce, code) => {
  const provider = await mount({ maxOutputBytes: 32 })
  converter.convert.mockImplementationOnce(async ({ outputPath }) => { await produce(outputPath); return { backend: 'native', missingFonts: [] } })
  await expect(provider.convertTo({ extension: 'docx', format: 'odt', source: source(),
    output: { owner: 'session', name: 'a.odt' } }))
    .rejects.toMatchObject({ code })
})

it('shares the conversion queue between previews and operations', async () => {
  const provider = await mount({ maxConcurrentConversions: 1 })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  converter.recalculate.mockImplementationOnce(async ({ outputPath }) => {
    entered.resolve(undefined)
    await release.promise
    await writeFile(outputPath, XLSX)
    return { backend: 'native', missingFonts: [] }
  })
  const first = provider.recalculate({ extension: 'xlsx', format: 'ods', source: source('a'),
    output: { owner: 'session', name: 'a.ods' } })
  await entered.promise
  const second = provider.renderImages(imagesRequest({ source: source('b') }))
  try {
    await Promise.resolve()
    expect(converter.renderImages).not.toHaveBeenCalled()
  } finally { release.resolve(undefined) }
  await first
  await second
  expect(converter.renderImages).toHaveBeenCalledOnce()
})

it('deletes the outputs of a disposed Session when the Session is disposed and every output when the provider unloads', async () => {
  const provider = await mount()
  const request = (owner: string) => ({ extension: 'docx', format: 'pdf', source: source(owner),
    output: { owner, name: 'doc.pdf' } }) as const
  const first = await provider.convertTo(request('first'))
  const second = await provider.convertTo(request('second'))
  ctx.emit('session/disposed', { id: 'first' } as never)
  await vi.waitFor(async () => { await expect(access(first.path)).rejects.toMatchObject({ code: 'ENOENT' }) })
  await access(second.path)
  await ctx.fiber.dispose()
  await expect(access(second.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('waits for the deletion of a disposed Session\'s outputs before the provider finishes unloading', async () => {
  const provider = await mount()
  const output = await provider.convertTo({ extension: 'docx', format: 'pdf', source: source(),
    output: { owner: 'first', name: 'doc.pdf' } })
  const gate = Promise.withResolvers<undefined>()
  outputDeletion.root = provider.outputDirectory
  outputDeletion.gate = gate.promise
  ctx.emit('session/disposed', { id: 'first' } as never)
  let unloaded = false
  const unloading = ctx.fiber.dispose().then(() => { unloaded = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(unloaded).toBe(false)
  gate.resolve(undefined)
  await unloading
  await expect(access(output.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a saved output after cancellation and a relative output directory', async () => {
  const provider = await mount()
  const controller = new AbortController()
  converter.convert.mockImplementationOnce(async ({ outputPath }) => {
    await writeFile(outputPath, PDF)
    controller.abort(new Error('stop'))
    return { backend: 'native', missingFonts: [] }
  })
  await expect(provider.convertTo({ extension: 'docx', format: 'pdf', source: source(),
    output: { owner: 'session', name: 'doc.pdf' } }, controller.signal)).rejects.toThrow()
  expect(() => new OfficeKit(new Context(), Config({ outputDirectory: 'relative' }))).toThrow('outputDirectory must be an absolute path')
})
