/** Poppler PDF rendering: backend selection, stdin and stdout pipes, process lifetime, selection checks, and limits. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Converter, RenderImagesRequest } from '@deepseek-ai/libreoffice-kit'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  SubprocessError, SubprocessExecutableNotFoundError, SubprocessRuntime, type SubprocessCollectedOutputs,
  type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import OfficeKit, { Config, type OfficeImagesRequest, type OfficeKitSource, type OfficeSourceKey } from '../src/index.ts'
import { resolveKitModule } from '../src/locate.ts'

vi.mock('../src/locate.ts', async (original) => {
  const actual = await original<typeof import('../src/locate.ts')>()
  return { ...actual, resolveKitModule: vi.fn(actual.resolveKitModule) }
})
const kit = vi.hoisted(() => ({ create: vi.fn<() => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  // Readers never check CRCs, so a zero CRC keeps the fixture readable.
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

/** A PNG stream of signature, IHDR declaring `width` x `height`, one IDAT, and IEND. */
function png(width: number, height: number, ihdrLength = 13): Buffer {
  const ihdr = Buffer.alloc(ihdrLength)
  if (ihdrLength >= 8) { ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4) }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([1, 2, 3])), chunk('IEND', Buffer.alloc(0))])
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BYTES = png(1, 1).length

/** A page's size in points. */
interface Page { width: number; height: number }
/** Script of one process; `hang` keeps it running until it is terminated, and `chunks` is its piped stdout. */
interface Run {
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stdout?: string
  chunks?: Buffer[]
  stderr?: string
  hang?: boolean
  reject?: Error
}
/** How the process reads stdin: fully, slowly behind a tiny buffer, failing with EPIPE, or never. */
type StdinMode = 'read' | 'slow' | 'epipe' | 'stall'

class FakeHandle implements SubprocessHandle {
  readonly stdin: Writable
  readonly stdout: PassThrough | undefined
  readonly stderr = undefined
  readonly control = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  readonly input: Promise<Buffer>
  terminated = false
  waited = false
  private stdoutText = ''
  private stderrText = ''
  private readonly exit = Promise.withResolvers<SubprocessOutcome>()

  constructor(readonly spec: SubprocessSpawnSpec, script: (input: Promise<Buffer>) => Promise<Run>, mode: StdinMode, dropReaders: boolean) {
    this.done = this.exit.promise
    const received: Buffer[] = []
    const input = Promise.withResolvers<Buffer>()
    this.input = input.promise
    this.stdin = new Writable({
      ...mode === 'slow' ? { highWaterMark: 16 } : {},
      write: (data: Buffer, _encoding, callback) => {
        if (mode === 'epipe') { callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); return }
        if (mode === 'stall') return
        received.push(data)
        if (mode === 'slow') setImmediate(callback)
        else callback()
      },
      final: (callback) => { input.resolve(Buffer.concat(received)); callback() },
      destroy: (error, callback) => { input.resolve(Buffer.concat(received)); callback(error) },
    })
    this.stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const reader = (text: () => string): { readFrom: () => { text: string; nextOffset: number; lossy: boolean } } =>
      ({ readFrom: () => ({ text: text(), nextOffset: 0, lossy: false }) })
    this.collected = dropReaders ? {} : { stdout: reader(() => this.stdoutText), stderr: reader(() => this.stderrText) }
    spec.signal?.addEventListener('abort', () => { this.terminate() }, { once: true })
    void script(this.input).then((run) => {
      if (run.reject !== undefined) { this.stdout?.end(); this.exit.reject(run.reject); return }
      if (run.hang === true) return
      // Collected stdout keeps only its tail within the requested byte limit, like the provider's collect mode.
      const limit = typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : Number.POSITIVE_INFINITY
      const stdout = Buffer.from(run.stdout ?? '')
      this.stdoutText = stdout.subarray(Math.max(0, stdout.length - limit)).toString()
      this.stderrText = run.stderr ?? ''
      for (const data of run.chunks ?? []) this.stdout?.write(data)
      this.stdout?.end()
      this.exit.resolve({ exitCode: run.exitCode === undefined ? 0 : run.exitCode, signal: run.signal ?? null })
    })
  }

  terminate(): void {
    this.terminated = true
    if (this.stdout !== undefined && !this.stdout.writableEnded) this.stdout.end()
    this.exit.resolve({ exitCode: null, signal: 'SIGTERM' })
  }

  async waitForExit(): Promise<boolean> {
    this.waited = true
    await this.done.catch((_spawnFailed: unknown) => undefined)
    return true
  }
}

/** Resolves executables to `/poppler/<name>` and runs scripted pdfinfo and pdftoppm processes. */
class FakeSubprocess extends SubprocessRuntime {
  static pages: Page[] = []
  static missing = new Set<string>()
  /** Executable lookup failures other than a missing executable. */
  static lookupFailure: Error | undefined
  static script: ((spec: SubprocessSpawnSpec, input: Promise<Buffer>) => Promise<Run | undefined>) | undefined
  static stdinMode: (spec: SubprocessSpawnSpec) => StdinMode = () => 'read'
  /** Piped stdout is delivered in reads of this many bytes. */
  static readBytes = Number.POSITIVE_INFINITY
  static dropReaders = false
  static handles: FakeHandle[] = []

  async terminalEnvironment() { return { platform: 'posix' as const } }
  override spawnTerminal(): Promise<never> { throw new Error('Poppler never spawns terminals') }

  override async resolveExecutable(command: string): Promise<string> {
    if (FakeSubprocess.lookupFailure !== undefined) throw FakeSubprocess.lookupFailure
    if (FakeSubprocess.missing.has(command)) throw new SubprocessExecutableNotFoundError(`${command} was not found`)
    return `/poppler/${command}`
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new FakeHandle(spec, async input => await FakeSubprocess.script?.(spec, input) ?? defaultRun(spec, input),
      FakeSubprocess.stdinMode(spec), FakeSubprocess.dropReaders)
    FakeSubprocess.handles.push(handle)
    return handle
  }
}

function range(argv: readonly string[]): [number, number] | undefined {
  const first = argv.indexOf('-f')
  return first === -1 ? undefined : [Number(argv[first + 1]), Number(argv[argv.indexOf('-l') + 1])]
}

/** Split `data` into reads of `size` bytes. */
function reads(data: Buffer, size = FakeSubprocess.readBytes): Buffer[] {
  const result: Buffer[] = []
  for (let offset = 0; offset < data.length; offset += Math.min(size, data.length)) result.push(data.subarray(offset, offset + size))
  return result
}


/** PNG stream pdftoppm writes for `argv` from the configured pages. */
function rendered(argv: readonly string[]): Buffer {
  const [first, last] = range(argv)!
  const dpi = Number(argv[argv.indexOf('-r') + 1])
  const images: Buffer[] = []
  for (let page = first; page <= last; page++) {
    const { width, height } = FakeSubprocess.pages[page - 1]!
    images.push(png(Math.ceil(width * dpi / 72), Math.ceil(height * dpi / 72)))
  }
  return Buffer.concat(images)
}

async function defaultRun(spec: SubprocessSpawnSpec, input: Promise<Buffer>): Promise<Run> {
  await input
  const { pages } = FakeSubprocess
  if (spec.argv[0] === '/poppler/pdftoppm') return { chunks: reads(rendered(spec.argv)) }
  return { stdout: `Title:          A long title\nPages:          ${pages.length}\nPage size:      612 x 792 pts\nFile size:      42 bytes\n` }
}

const pdfBytes = Buffer.from('%PDF-1.7\nsource\n%%EOF\n')
function source(key = 'report', bytes: Buffer = pdfBytes): OfficeKitSource {
  return { key: brandString<OfficeSourceKey>(key), version: 'v1', bytes: bytes.length, read: async () => ({ bytes, version: 'v1' }) }
}
const limits = { maxImages: 10, maxPixels: 16_000_000, maxDimension: 8192, maxBytes: 1_000_000 } as const
function pdfRequest(overrides: Partial<OfficeImagesRequest> = {}): OfficeImagesRequest {
  return { extension: 'pdf', source: source(), ...limits, ...overrides }
}

let ctx: Context
let converter: Converter & { renderImages: ReturnType<typeof vi.fn<Converter['renderImages']>> }

beforeEach(() => {
  ctx = new Context()
  FakeSubprocess.pages = [{ width: 72, height: 144 }, { width: 72, height: 144 }, { width: 72, height: 144 }]
  FakeSubprocess.missing = new Set()
  FakeSubprocess.lookupFailure = undefined
  FakeSubprocess.script = undefined
  FakeSubprocess.stdinMode = () => 'read'
  FakeSubprocess.readBytes = Number.POSITIVE_INFINITY
  FakeSubprocess.dropReaders = false
  FakeSubprocess.handles = []
  converter = {
    backend: 'native',
    render: vi.fn<Converter['render']>().mockRejectedValue(new Error('Unexpected Converter.render call')),
    convert: vi.fn<Converter['convert']>().mockRejectedValue(new Error('Unexpected Converter.convert call')),
    recalculate: vi.fn<Converter['recalculate']>().mockRejectedValue(new Error('Unexpected Converter.recalculate call')),
    renderImages: vi.fn<Converter['renderImages']>().mockImplementation(async (request: RenderImagesRequest) => {
      await mkdir(request.outputDir)
      const path = join(request.outputDir, 'image.png')
      await writeFile(path, png(2, 2))
      return { schemaVersion: 1, backend: 'native', rasterEngine: 'libreoffice', source: 'saved', inputPath: request.inputPath,
        sourceSha256: 'digest', dpi: 144, pageCount: 3, missingFonts: [],
        images: [{ index: 0, page: 1, path, width: 2, height: 2, rectangle: { x: 0, y: 0, width: 1, height: 1 }, byteLength: PNG_BYTES }] }
    }),
    dispose: vi.fn<Converter['dispose']>().mockResolvedValue(undefined),
  }
  kit.create.mockReset().mockImplementation(async () => converter)
})
afterEach(async () => {
  vi.mocked(resolveKitModule).mockRestore()
  await ctx.fiber.dispose()
})

async function mount(options: { config?: Partial<Config>; subprocess?: boolean } = {}): Promise<OfficeKit> {
  if (options.subprocess !== false) await ctx.plugin(FakeSubprocess)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-office-kit-outputs-'))
  onTestFinished(() => rm(outputDirectory, { recursive: true, force: true }))
  await ctx.plugin(OfficeKit, { outputDirectory, ...options.config })
  return ctx.officeKit
}

function spawned(program: 'pdfinfo' | 'pdftoppm'): FakeHandle[] {
  return FakeSubprocess.handles.filter(handle => handle.spec.argv[0] === `/poppler/${program}`)
}

/** Script only `program`, leaving the other process on its default behavior. */
function scriptOnly(program: 'pdfinfo' | 'pdftoppm', run: (spec: SubprocessSpawnSpec, input: Promise<Buffer>) => Run | Promise<Run>): void {
  FakeSubprocess.script = async (spec, input) => spec.argv[0] === `/poppler/${program}` ? await run(spec, input) : undefined
}

describe('backend selection', () => {
  it('renders PDF with Poppler by default through stdin and stdout without a LibreOffice converter', async () => {
    const provider = await mount()
    const result = await provider.renderImages(pdfRequest())
    expect(result).toEqual({
      renderer: 'poppler', pageCount: 3, dpi: 144, missingFonts: [],
      images: [1, 2, 3].map(page => ({ png: Uint8Array.from(png(144, 288)), width: 144, height: 288, page })),
    })
    expect(kit.create).not.toHaveBeenCalled()
    expect(FakeSubprocess.handles.map(handle => handle.spec.argv)).toEqual([
      ['/poppler/pdfinfo', '-'],
      ['/poppler/pdftoppm', '-png', '-cropbox', '-r', '144', '-f', '1', '-l', '3', '-'],
    ])
    for (const handle of FakeSubprocess.handles) {
      expect(handle.spec.cwd).toBe('/poppler')
      expect(handle.spec.stdio.stdin).toBe('pipe')
      expect(await handle.input).toEqual(pdfBytes)
      expect(handle.waited).toBe(true)
    }
    expect(spawned('pdftoppm')[0]!.spec.stdio).toMatchObject({ stdout: 'pipe', stderr: { maxBytes: 8192 } })
    expect(spawned('pdfinfo')[0]!.spec.stdio).toMatchObject({ stdout: { maxBytes: 65536 } })
  })

  it.each([
    ['the subprocess service is absent', { subprocess: false }, (): void => undefined],
    ['pdftoppm is not found', {}, () => { FakeSubprocess.missing.add('pdftoppm') }],
    ['pdfinfo is not found', {}, () => { FakeSubprocess.missing.add('pdfinfo') }],
  ])('falls back to LibreOffice when %s and rejects an explicit poppler request as unavailable', async (_label, options, arrange) => {
    arrange()
    const provider = await mount(options)
    expect(await provider.renderImages(pdfRequest())).toMatchObject({ renderer: 'libreoffice', pageCount: 3 })
    expect(converter.renderImages).toHaveBeenCalledOnce()
    await expect(provider.renderImages(pdfRequest({ renderer: 'poppler', source: source('other') })))
      .rejects.toMatchObject({ name: 'OfficeKitError', code: 'unavailable' })
    expect(FakeSubprocess.handles).toEqual([])
  })

  it('refuses poppler for Office input before reading the source', async () => {
    const provider = await mount()
    const read = vi.fn<OfficeKitSource['read']>()
    await expect(provider.renderImages({ ...pdfRequest({ renderer: 'poppler' }), extension: 'pptx', source: { ...source(), read } }))
      .rejects.toMatchObject({ code: 'unsupported-format', message: 'The poppler renderer accepts only pdf input.' })
    expect(read).not.toHaveBeenCalled()
  })

  it('uses LibreOffice for Office input and for an explicit libreoffice request even when Poppler is available', async () => {
    const provider = await mount()
    expect(await provider.renderImages(pdfRequest({ extension: 'pptx' }))).toMatchObject({ renderer: 'libreoffice' })
    expect(await provider.renderImages(pdfRequest({ renderer: 'libreoffice' }))).toMatchObject({ renderer: 'libreoffice' })
    expect(FakeSubprocess.handles).toEqual([])
  })

  it('skips an unavailable LibreOffice Kit for the next configured renderer and reports an explicit request', async () => {
    vi.mocked(resolveKitModule).mockReturnValue({ kind: 'missing', error: new Error('Cannot find package') })
    ctx.logger.warn = vi.fn()
    const provider = await mount({ config: { renderers: { office: ['libreoffice'], pdf: ['libreoffice', 'poppler'] } } })
    expect(await provider.renderImages(pdfRequest())).toMatchObject({ renderer: 'poppler' })
    await expect(provider.renderImages(pdfRequest({ renderer: 'libreoffice', source: source('other') })))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('uses the last configured renderer without an availability check and reports its failure', async () => {
    const provider = await mount({ subprocess: false, config: { renderers: { office: ['libreoffice'], pdf: ['poppler'] } } })
    await expect(provider.renderImages(pdfRequest())).rejects.toMatchObject({
      code: 'unavailable', message: 'Poppler rendering requires the subprocess service.',
    })
  })

  it('stops selection when the caller cancels during an availability check', async () => {
    const provider = await mount()
    const controller = new AbortController()
    const resolve = vi.spyOn(FakeSubprocess.prototype, 'resolveExecutable').mockImplementation(async () => {
      controller.abort(new Error('stop'))
      throw new Error('lookup aborted')
    })
    onTestFinished(() => { resolve.mockRestore() })
    await expect(provider.renderImages(pdfRequest(), controller.signal)).rejects.toThrow('stop')
    await expect(provider.renderImages(pdfRequest(), AbortSignal.abort(new Error('early')))).rejects.toThrow('early')
    expect(converter.renderImages).not.toHaveBeenCalled()
  })

  it('caches renderings per backend', async () => {
    const provider = await mount()
    await provider.renderImages(pdfRequest())
    await provider.renderImages(pdfRequest({ renderer: 'poppler' }))
    expect(spawned('pdftoppm')).toHaveLength(1)
    await provider.renderImages(pdfRequest({ renderer: 'libreoffice' }))
    expect(converter.renderImages).toHaveBeenCalledOnce()
  })
})

describe('Poppler processes', () => {
  it('renders each run of consecutive pages once and pairs images with pages in stream order', async () => {
    FakeSubprocess.pages = Array.from({ length: 12 }, (_, index) => ({ width: 72 + index, height: 72 }))
    const provider = await mount()
    const result = await provider.renderImages(pdfRequest({ pages: [10, 1, 2, 4, 5, 12], dpi: 72 }))
    expect(result.images.map(image => [image.page, image.width])).toEqual([[1, 72], [2, 73], [4, 75], [5, 76], [10, 81], [12, 83]])
    expect(spawned('pdfinfo').map(handle => handle.spec.argv)).toEqual([['/poppler/pdfinfo', '-']])
    expect(spawned('pdftoppm').map(handle => range(handle.spec.argv))).toEqual([[1, 2], [4, 5], [10, 10], [12, 12]])
  })

  it('reads the page count after document properties that forge an earlier Pages line', async () => {
    FakeSubprocess.pages = [{ width: 72, height: 144 }, { width: 72, height: 144 }]
    const forged = 'Title:          Forged\nPages:          1\n'
    scriptOnly('pdfinfo', async (spec, input) => {
      const run = await defaultRun(spec, input)
      return { stdout: `${forged}${run.stdout!}` }
    })
    const provider = await mount()
    const result = await provider.renderImages(pdfRequest())
    expect(result.pageCount).toBe(2)
    expect(result.images.map(image => image.page)).toEqual([1, 2])
  })

  it.each([1, 3, 7, 13])('splits PNG streams whose headers and chunks span reads of %i bytes', async (size) => {
    FakeSubprocess.readBytes = size
    const provider = await mount()
    const result = await provider.renderImages(pdfRequest())
    expect(result.images.map(image => image.png)).toEqual([1, 2, 3].map(() => Uint8Array.from(png(144, 288))))
  })

  it.each([
    ['fewer', 2],
    ['more', 4],
  ] as const)('rejects %s PNG images than the pages of a run', async (_label, count) => {
    scriptOnly('pdftoppm', () => ({ chunks: [Buffer.concat(Array.from({ length: count }, () => png(144, 288)))] }))
    const provider = await mount()
    await expect(provider.renderImages(pdfRequest())).rejects.toMatchObject({
      code: 'invalid-output', message: `pdftoppm returned ${count} images for 3 pages.`,
    })
  })

  it.each([
    ['equal to', 3 * PNG_BYTES, undefined],
    ['above', 3 * PNG_BYTES - 1, 'output-too-large'],
  ])('bounds the PNG bytes of all pages %s maxBytes and terminates pdftoppm above it', async (_label, maxBytes, code) => {
    FakeSubprocess.readBytes = 16
    const provider = await mount()
    const rendering = provider.renderImages(pdfRequest({ maxBytes, dpi: 24 }))
    if (code === undefined) {
      expect((await rendering).images).toHaveLength(3)
      return
    }
    await expect(rendering).rejects.toMatchObject({ code })
    expect(spawned('pdftoppm')[0]).toMatchObject({ terminated: true, waited: true })
  })

  it('applies the remaining byte budget to later runs', async () => {
    const provider = await mount()
    await expect(provider.renderImages(pdfRequest({ pages: [1, 3], maxBytes: 2 * PNG_BYTES - 1, dpi: 24 })))
      .rejects.toMatchObject({ code: 'output-too-large' })
    expect(spawned('pdftoppm')).toHaveLength(2)
  })

  it.each([
    ['equal to maxDimension', { maxDimension: 288 }, undefined],
    ['above maxDimension', { maxDimension: 287 }, 'Page 1 rendered at 144x288 px'],
    ['equal to maxPixels', { maxPixels: 144 * 288 }, undefined],
    ['above maxPixels', { maxPixels: 144 * 288 - 1 }, 'Page 1 rendered at 144x288 px'],
  ])('rejects page pixels %s after rendering', async (_label, overrides, failure) => {
    const provider = await mount()
    const rendering = provider.renderImages(pdfRequest(overrides))
    if (failure === undefined) {
      await rendering
      return
    }
    await expect(rendering).rejects.toMatchObject({ code: 'output-too-large', message: expect.stringContaining(failure) as string })
    expect(spawned('pdftoppm')).toHaveLength(1)
  })

  it.each([
    ['every page within maxImages', { maxImages: 3 }, 3, undefined],
    ['every page above maxImages', { maxImages: 2 }, 0, 'Selected page count exceeds maxImages; select pages or raise the limit.'],
    ['selected pages within maxImages', { maxImages: 2, pages: [1, 3] }, 2, undefined],
    ['selected pages above maxImages', { maxImages: 1, pages: [1, 3] }, 0, 'Selected page count exceeds maxImages.'],
  ])('accepts %s and rejects a larger selection', async (_label, overrides, count, failure) => {
    const provider = await mount()
    const rendering = provider.renderImages(pdfRequest(overrides))
    if (failure === undefined) {
      expect((await rendering).images).toHaveLength(count)
      return
    }
    await expect(rendering).rejects.toMatchObject({ code: 'output-too-large', message: failure })
    expect(spawned('pdftoppm')).toEqual([])
  })

  it.each([
    ['more pages than maxImages', { pages: [1, 2, 3], maxImages: 2 }],
  ])('rejects %s before starting a process', async (_label, overrides) => {
    const provider = await mount()
    await expect(provider.renderImages(pdfRequest({ renderer: 'poppler', ...overrides }))).rejects.toMatchObject({ code: 'output-too-large' })
    expect(FakeSubprocess.handles).toEqual([])
  })

  it('rejects pages outside the document and documents without pages', async () => {
    const provider = await mount()
    await expect(provider.renderImages(pdfRequest({ pages: [2, 4] })))
      .rejects.toMatchObject({ code: 'invalid-request', message: 'Selected page lies outside the 3-page document.' })
    FakeSubprocess.pages = []
    await expect(provider.renderImages(pdfRequest({ source: source('empty') })))
      .rejects.toMatchObject({ code: 'invalid-document' })
  })

  it.each([
    ['pdfinfo cannot open the PDF', 'pdfinfo', { exitCode: 1 }, 'invalid-document', 'Poppler could not open the PDF.'],
    ['pdftoppm cannot open the PDF', 'pdftoppm', { exitCode: 1, stderr: 'Syntax Error' }, 'invalid-document', 'Poppler could not open the PDF.'],
    ['pdftoppm fails otherwise', 'pdftoppm', { exitCode: 99 }, 'failed', 'pdftoppm failed with exit 99.'],
    ['pdfinfo is killed', 'pdfinfo', { exitCode: null, signal: 'SIGKILL' }, 'failed', 'pdfinfo failed with exit SIGKILL.'],
    ['the provider fails the process', 'pdftoppm', { reject: new Error('runner lost') }, 'failed', 'Poppler rendering failed.'],
    ['pdfinfo omits the page count', 'pdfinfo', { stdout: 'Title: x\n' }, 'invalid-output', 'pdfinfo did not report the page count.'],
  ] as const)('maps %s', async (_label, program, run, code, message) => {
    scriptOnly(program, () => run)
    const provider = await mount()
    await expect(provider.renderImages(pdfRequest())).rejects.toMatchObject({ code, message })
    expect(FakeSubprocess.handles.every(handle => handle.terminated && handle.waited)).toBe(true)
  })

  it('reports absent output readers', async () => {
    const provider = await mount()
    FakeSubprocess.dropReaders = true
    await expect(provider.renderImages(pdfRequest({ source: source('readers') })))
      .rejects.toMatchObject({ code: 'invalid-output', message: 'pdfinfo did not report the page count.' })
    FakeSubprocess.script = async () => ({ exitCode: 3 })
    await expect(provider.renderImages(pdfRequest({ source: source('stderr') })))
      .rejects.toMatchObject({ code: 'failed', cause: expect.objectContaining({ message: 'pdfinfo exited with 3: ' }) as Error })
  })

  it.each([
    ['a stream that is not a PNG', Buffer.from('not a png image at all'), 'invalid-output', 'pdftoppm did not produce a PNG image.'],
    ['a stream that ends inside an image', png(144, 288).subarray(0, 40), 'invalid-output', 'pdftoppm output ended inside a PNG image.'],
    ['a stream that ends inside a signature', Buffer.concat([png(144, 288), PNG_SIGNATURE.subarray(0, 3)]), 'invalid-output', 'pdftoppm output ended inside a PNG image.'],
    ['an image above maxDimension', png(9000, 1), 'output-too-large', 'Page 1 rendered at 9000x1 px'],
  ])('rejects %s', async (_label, data, code, message) => {
    scriptOnly('pdftoppm', () => ({ chunks: [data] }))
    const provider = await mount()
    await expect(provider.renderImages(pdfRequest({ pages: [1] })))
      .rejects.toMatchObject({ code, message: expect.stringContaining(message) as string })
  })
})

describe('Poppler stdin', () => {
  it('waits for a slow reader to drain stdin', async () => {
    FakeSubprocess.stdinMode = () => 'slow'
    const large = Buffer.alloc(200_000, 7)
    const provider = await mount()
    expect(await provider.renderImages(pdfRequest({ source: source('large', large), pages: [1] }))).toMatchObject({ renderer: 'poppler' })
    for (const handle of FakeSubprocess.handles) expect(await handle.input).toEqual(large)
  })

  it.each([
    ['a failure', { exitCode: 1 }, 'invalid-document'],
    ['a success', undefined, undefined],
  ] as const)('reports the exit status after stdin fails with EPIPE, here %s', async (_label, run, code) => {
    FakeSubprocess.stdinMode = spec => spec.argv[0] === '/poppler/pdftoppm' ? 'epipe' : 'read'
    if (run !== undefined) scriptOnly('pdftoppm', () => run)
    const provider = await mount()
    const rendering = provider.renderImages(pdfRequest({ source: source('large', Buffer.alloc(200_000)), pages: [1] }))
    if (code === undefined) expect(await rendering).toMatchObject({ images: [{ page: 1 }] })
    else await expect(rendering).rejects.toMatchObject({ code })
    expect(await spawned('pdftoppm')[0]!.input).toEqual(Buffer.alloc(0))
  })
})

describe('Poppler process lifetime', () => {
  /** pdftoppm never reads stdin, writes nothing, and runs until it is terminated. */
  function hangPdftoppm(): Promise<void> {
    const started = Promise.withResolvers<undefined>()
    FakeSubprocess.stdinMode = spec => spec.argv[0] === '/poppler/pdftoppm' ? 'stall' : 'read'
    scriptOnly('pdftoppm', () => {
      started.resolve(undefined)
      return { hang: true }
    })
    return started.promise
  }
  const large = (): OfficeKitSource => source('stalled', Buffer.alloc(200_000))

  it('terminates and awaits a process past the deadline and reports a timeout', async () => {
    void hangPdftoppm()
    const provider = await mount({ config: { timeoutMs: 20 } })
    await expect(provider.renderImages(pdfRequest({ source: large() }))).rejects.toMatchObject({ code: 'timeout', message: 'Poppler rendering exceeded 20 ms.' })
    expect(spawned('pdftoppm')[0]).toMatchObject({ terminated: true, waited: true })
    expect(spawned('pdftoppm')[0]!.stdin.destroyed).toBe(true)
  })

  it('terminates and awaits a process when the caller cancels', async () => {
    const started = hangPdftoppm()
    const provider = await mount()
    const controller = new AbortController()
    const rendering = provider.renderImages(pdfRequest({ source: large() }), controller.signal)
    await started
    controller.abort(new Error('caller stopped'))
    await expect(rendering).rejects.toThrow('caller stopped')
    await vi.waitFor(() => { expect(spawned('pdftoppm')[0]).toMatchObject({ terminated: true, waited: true }) })
  })

  it('terminates and awaits a running process when the provider is disposed', async () => {
    const started = hangPdftoppm()
    const provider = await mount()
    const rendering = provider.renderImages(pdfRequest({ source: large() })).catch((error: unknown) => error)
    await started
    await ctx.fiber.dispose()
    expect(spawned('pdftoppm')[0]).toMatchObject({ terminated: true, waited: true })
    expect(await rendering).toMatchObject({ code: 'unavailable' })
  })
})

describe('renderer configuration', () => {
  it.each([
    [{ office: ['libreoffice', 'libreoffice'], pdf: ['poppler'] }, 'renderers.office must not repeat a renderer.'],
    [{ office: ['libreoffice'], pdf: ['poppler', 'poppler'] }, 'renderers.pdf must not repeat a renderer.'],
    [{ office: ['poppler'], pdf: ['poppler'] }, 'renderers.office must not include poppler'],
  ] as const)('rejects %j when the provider loads', (renderers, message) => {
    const config = Config({ outputDirectory: tmpdir(), renderers: { office: [...renderers.office], pdf: [...renderers.pdf] } })
    expect(() => new OfficeKit(new Context(), config)).toThrow(message)
  })

  it.each([
    [{ renderers: { office: [], pdf: ['poppler'] } }],
    [{ renderers: { office: ['libreoffice'], pdf: ['ghostscript'] } }],
    [{ poppler: { pdftoppm: '', pdfinfo: 'pdfinfo' } }],
  ])('rejects %j in the schema', (config) => {
    expect(() => Config(config as never)).toThrow()
  })

  it('passes configured Poppler executables to executable lookup', async () => {
    const provider = await mount({ config: { poppler: { pdftoppm: '/opt/poppler/pdftoppm', pdfinfo: 'pdfinfo-custom' } } })
    const resolve = vi.spyOn(FakeSubprocess.prototype, 'resolveExecutable')
    onTestFinished(() => { resolve.mockRestore() })
    FakeSubprocess.missing = new Set(['/opt/poppler/pdftoppm', 'pdfinfo-custom'])
    await expect(provider.renderImages(pdfRequest({ renderer: 'poppler' }))).rejects.toMatchObject({ code: 'unavailable' })
    expect(resolve.mock.calls.map(([command]) => command)).toContain('/opt/poppler/pdftoppm')
    expect(resolve.mock.calls.map(([command]) => command)).toContain('pdfinfo-custom')
    expect(Config({})).toMatchObject({ renderers: { office: ['libreoffice'], pdf: ['poppler', 'libreoffice'] },
      poppler: { pdftoppm: 'pdftoppm', pdfinfo: 'pdfinfo' } })
  })

  it('reports a lookup that found no executable as unavailable and names it', async () => {
    const provider = await mount()
    FakeSubprocess.missing = new Set(['pdfinfo'])
    await expect(provider.renderImages(pdfRequest({ renderer: 'poppler' }))).rejects.toMatchObject({
      code: 'unavailable', message: expect.stringContaining('pdfinfo was not found') as string,
    })
  })

  it('passes a lookup failure other than a missing executable through, so the real cause survives', async () => {
    const provider = await mount()
    const failure = new SubprocessError('the provider channel closed', 'SUBPROCESS_RUNNER_IPC_FAILED')
    FakeSubprocess.lookupFailure = failure
    await expect(provider.renderImages(pdfRequest({ renderer: 'poppler' }))).rejects.toBe(failure)
  })

  it('rejects with the cancellation reason instead of reporting a lookup failure', async () => {
    const provider = await mount()
    FakeSubprocess.lookupFailure = new SubprocessExecutableNotFoundError('pdftoppm was not found')
    const controller = new AbortController()
    const reason = new Error('stop')
    const rendering = provider.renderImages(pdfRequest({ renderer: 'poppler' }), controller.signal)
    controller.abort(reason)
    await expect(rendering).rejects.toBe(reason)
  })
})
