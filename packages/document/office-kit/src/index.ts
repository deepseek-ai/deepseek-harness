/** Host LibreOffice Kit provider with reusable converters, shared admission, and private disk input/output. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import z from '@deepseek-ai/schemastery'
import type { WorkspaceFileScope, WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveKitModule } from './locate.ts'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { OfficeKitError } from './errors.ts'
import type { OfficeKitGeneration, OfficeSourceKey } from './identity.ts'
import type {
  OfficeConversionRequest, OfficeFileResult, OfficeImagesRequest, OfficeImagesResult, OfficeKitRequest, OfficeKitResult,
  OfficeKitPriority, OfficeOutputTarget, OfficeRecalculationRequest, RenderedDocumentBytes,
} from './types.ts'
import { readOutput, readPdf, readPng } from './output.ts'
import { OutputStore } from './outputs.ts'
import { ConversionQueue, type OfficeOperation, type OfficeOperationOutput, type QueueRequest } from './queue.ts'

export * from './errors.ts'
export * from './identity.ts'
export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared Office rendering, conversion, recalculation, and authorized workspace-file previews. */
    officeKit: OfficeKit
  }
}

/** Provider concurrency and kit rendering/font configuration. */
export interface Config {
  /** Maximum simultaneous conversions; queued callers remain cancellable. */
  maxConcurrentConversions: number
  /** Maximum metadata-only jobs awaiting source admission. */
  maxQueuedJobs: number
  /** Maximum outstanding conversion readers. */
  maxReaders: number
  /** Maximum reserved bytes across admitted source reads and conversions. */
  maxSourceBytes: number
  /** Maximum concurrent background jobs; zero refuses speculative work. */
  maxBackgroundConversions: number
  /** Maximum retained content-addressed outputs. */
  maxCachedEntries: number
  /** Maximum retained output bytes. */
  maxCachedBytes: number
  /** Maximum retained source-version aliases to cached content. */
  maxSourceEntries: number
  /** Absolute directory for converted and recalculated files, with one subdirectory per Session. */
  outputDirectory: string
  /** Milliseconds a converted or recalculated file is kept. */
  outputRetentionMs: number
  /** Maximum bytes across retained converted and recalculated files; the oldest leave first. */
  maxOutputStoreBytes: number
  /** Conversion deadline in milliseconds; excludes the DSH queue. */
  timeoutMs: number
  /** Maximum authorized source bytes. */
  maxInputBytes: number
  /** Maximum complete PDF, converted, or recalculated file bytes. */
  maxOutputBytes: number
  /** Image resolution in DPI of PDF exports; `renderImages()` takes its resolution from each request's `dpi`. */
  maxImageResolution: number
  /** Maximum OOXML ZIP entries. */
  maxArchiveEntries: number
  /** Maximum total declared uncompressed OOXML bytes. */
  maxUncompressedBytes: number
  /** Absolute font roots; omission uses the kit's platform defaults. */
  fontDirectories?: string[]
  /** Ordered font-family preference groups; omission retains the kit defaults. */
  fontFallbacks?: string[][]
  /** Maximum physical font files indexed by each converter. */
  maxFontFiles: number
  /** Maximum individual font-file bytes. */
  maxFontFileBytes: number
  /** Maximum original font bytes loaded for a conversion. */
  maxLoadedFontBytes: number
}

/** Deployment defaults resolved before provider construction. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxConcurrentConversions: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  maxQueuedJobs: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
  maxReaders: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(32),
  maxSourceBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(104857600),
  maxBackgroundConversions: z.natural().min(0).max(Number.MAX_SAFE_INTEGER).default(1),
  maxCachedEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
  maxCachedBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(134217728),
  maxSourceEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64),
  outputDirectory: z.string().min(1).default(dshHomePath('office-kit', 'outputs')),
  outputRetentionMs: z.natural().min(1).max(2_147_483_647).default(24 * 60 * 60 * 1000),
  maxOutputStoreBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 * 1024),
  timeoutMs: z.natural().min(1).max(2_147_483_647).default(60_000),
  maxInputBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER - 1).default(50 * 1024 * 1024),
  maxOutputBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER - 1).default(100 * 1024 * 1024),
  maxImageResolution: z.natural().min(1).max(2_147_483_647).default(192),
  maxArchiveEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(10_000),
  maxUncompressedBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(250 * 1024 * 1024),
  fontDirectories: z.array(z.string().min(1)).extra('default', undefined),
  fontFallbacks: z.array(z.array(z.string().pattern(/\S/)).min(2)).extra('default', undefined),
  maxFontFiles: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(20_000),
  maxFontFileBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(256 * 1024 * 1024),
  maxLoadedFontBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 * 1024),
})

/** Kit operations loaded from the provider's Kit entry. */
type KitModule = Pick<typeof import('@deepseek-ai/libreoffice-kit'), 'createConverter'>

/** Imported Kit operations with the engine resolver anchored at the same Kit entry. */
interface LoadedKit extends KitModule {
  readonly resolveEnginePackage: NonNullable<ConverterOptions['resolveEnginePackage']>
}

const KIT_INSTALL_HINT = 'This deployment does not provide LibreOffice Kit; install or enable it as this deployment requires, then retry.'

interface Slot {
  busy: boolean
  converter?: Promise<Converter>
}

/** A provider lifetime owns all converters, queued calls, and temporary files. */
export class OfficeKit extends TypertRemoteService {
  static Config = Config
  /** Changes whenever engine, font, or conversion configuration is replaced. */
  readonly generation: OfficeKitGeneration = brandString<OfficeKitGeneration>(randomUUID())
  /** Absolute Host directory holding converted and recalculated files; consumers check that their execution world reads it. */
  readonly outputDirectory: string
  private readonly remoteLifetime = new AbortController()
  private readonly remoteRequests = new Set<Promise<RenderedDocumentBytes>>()
  private readonly slots: Slot[] = []
  private readonly queue: ConversionQueue
  private readonly outputs: OutputStore
  private readonly options: Omit<ConverterOptions, 'resolveEnginePackage'>
  private loadedKit?: Promise<LoadedKit>
  private readonly reportedKitFailures = new Set<string>()

  /**
   * @param ctx - owning Host context.
   * @param config - resolved rendering, font, and concurrency limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'officeKit')
    if (config.fontDirectories?.some(path => !isAbsolute(path))) throw new Error('fontDirectories must contain absolute paths.')
    if (config.maxSourceBytes < config.maxInputBytes) throw new Error('maxSourceBytes must be at least maxInputBytes.')
    if (!isAbsolute(config.outputDirectory)) throw new Error('outputDirectory must be an absolute path.')
    const { fontDirectories, fontFallbacks, timeoutMs, maxInputBytes, maxOutputBytes, maxImageResolution,
      maxArchiveEntries, maxUncompressedBytes, maxFontFiles, maxFontFileBytes, maxLoadedFontBytes } = config
    this.options = { timeoutMs, maxInputBytes, maxOutputBytes, maxImageResolution,
      maxArchiveEntries, maxUncompressedBytes, maxFontFiles, maxFontFileBytes, maxLoadedFontBytes,
      ...(fontDirectories === undefined ? {} : { fontDirectories }),
      ...(fontFallbacks === undefined ? {} : { fontFallbacks }),
    }
    this.queue = new ConversionQueue(config, this.generation, (bytes, request, signal) => this.runOperation(bytes, request, signal))
    this.outputDirectory = config.outputDirectory
    this.outputs = new OutputStore({ root: config.outputDirectory, retentionMs: config.outputRetentionMs,
      maxBytes: config.maxOutputStoreBytes }, ctx.logger.warn.bind(ctx.logger))
    // The output store records this release, and its disposal below waits for the release to settle.
    ctx.on('session/disposed', (session) => { void this.outputs.release(session.id) })
    ctx.effect(() => async () => {
      this.remoteLifetime.abort()
      await this.queue.dispose()
      await this.outputs.dispose()
      await Promise.allSettled(this.remoteRequests)
      const results = await Promise.allSettled(this.slots.map(async (slot) => {
        const converter = await slot.converter
        await converter?.dispose()
      }))
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length > 0) throw new AggregateError(failures.map((result): unknown => result.reason), 'LibreOffice converter disposal failed.')
    })
  }

  /**
   * Convert Office bytes to PDF without modifying the source or writing Session events.
   * @param request - authorized metadata and deferred bounded source read.
   * @param signal - caller cancellation; provider disposal also stops active work.
   * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
   * @throws {OfficeKitError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
   */
  async convert(request: OfficeKitRequest, signal?: AbortSignal): Promise<OfficeKitResult> {
    const { kind: _kind, ...result } = await this.queue.read({ ...request, operation: { kind: 'pdf' } }, signal)
    return result
  }

  /**
   * Render selected pages, slides, or worksheet areas of one document as PNG images. Requests share the admission
   * queue, concurrency, source-byte reservation, and cache with previews, and run at foreground priority.
   * @param request - authorized metadata, deferred bounded source read, selection, and complete-result limits.
   * @param signal - caller cancellation; provider disposal also stops active work.
   * @returns caller-owned images in document order whose count, per-image size, and total bytes satisfy the limits.
   * @throws {OfficeKitError} `invalid-request` for a selection the engine rejects, `output-too-large` when the
   * selection exceeds a limit, and the other conversion codes; cancellation rejects with its reason.
   */
  async renderImages(request: OfficeImagesRequest, signal?: AbortSignal): Promise<OfficeImagesResult> {
    const { extension, source, pages, sheet, range, dpi, maxImages, maxPixels, maxDimension, maxBytes } = request
    const result = await this.queue.read({ extension, priority: 'foreground', source, operation: {
      kind: 'images',
      ...(pages === undefined ? {} : { pages: [...pages] }),
      ...(sheet === undefined ? {} : { sheet }),
      ...(range === undefined ? {} : { range }),
      ...(dpi === undefined ? {} : { dpi }),
      maxImages, maxPixels, maxDimension, maxBytes,
    } }, signal)
    return { images: result.images, pageCount: result.pageCount, dpi: result.dpi, missingFonts: result.missingFonts }
  }

  /**
   * Convert one document to another format at foreground priority, sharing admission, concurrency, and cache with
   * previews, and save the result in the provider's output store.
   * @param request - authorized metadata, deferred bounded source read, target format, and output owner and name.
   * @param signal - caller cancellation; provider disposal also stops active work.
   * @returns the saved file's absolute Host path and size; the file is deleted after `outputRetentionMs`, when older
   * outputs need `maxOutputStoreBytes`, when the Session whose id is `output.owner` is disposed, or when the provider is disposed.
   * @throws {OfficeKitError} `invalid-request` for a format or sheet the engine rejects and the other conversion
   * codes; cancellation rejects with its reason.
   */
  async convertTo(request: OfficeConversionRequest, signal?: AbortSignal): Promise<OfficeFileResult> {
    const { extension, source, format, sheet, output } = request
    return this.saveFile(output, await this.queue.read({ extension, priority: 'foreground', source,
      operation: { kind: 'convert', format, ...(sheet === undefined ? {} : { sheet }) } }, signal), signal)
  }

  /**
   * Recalculate every formula of one workbook at foreground priority and save formulas with refreshed cached results, sharing admission,
   * concurrency, and cache with previews, and save the workbook in the provider's output store. This does not validate
   * formulas or business data.
   * @param request - authorized workbook metadata, deferred bounded source read, output format, and output owner and name.
   * @param signal - caller cancellation; provider disposal also stops active work.
   * @returns the saved workbook's absolute Host path and size, retained like {@link convertTo} outputs.
   * @throws {OfficeKitError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
   */
  async recalculate(request: OfficeRecalculationRequest, signal?: AbortSignal): Promise<OfficeFileResult> {
    const { extension, source, format, output } = request
    return this.saveFile(output, await this.queue.read({ extension, priority: 'foreground', source, operation: { kind: 'recalculate', format } }, signal), signal)
  }

  private async saveFile(
    output: OfficeOutputTarget, result: Extract<OfficeOperationOutput, { kind: 'file' }>,
    signal: AbortSignal | undefined,
  ): Promise<OfficeFileResult> {
    signal?.throwIfAborted()
    const path = await this.outputs.save(output.owner, output.name, result.data)
    return { path, bytes: result.data.byteLength, ...(result.pageCount === undefined ? {} : { pageCount: result.pageCount }),
      missingFonts: result.missingFonts }
  }

  /**
   * Read and convert one Office file using the Session's ordinary filesystem authorization.
   * @param workspaceFileScope - Session header lookup shared with workspaceFiles.
   * @param path - absolute or workspace-relative Office path.
   * @param priority - foreground preview or speculative background work.
   * @param signal - Remote cancellation; disposal also cancels outstanding reads and conversions.
   * @returns complete PDF bytes with original source identity and missing font families.
   */
  @Remote
  async render(
    workspaceFileScope: WorkspaceFileScope, path: string, priority: OfficeKitPriority, signal: AbortSignal,
  ): Promise<RenderedDocumentBytes> {
    const upstream = AbortSignal.any([signal, this.remoteLifetime.signal])
    const operation = this.renderFile(workspaceFileScope, path, priority, upstream)
    this.remoteRequests.add(operation)
    try { return await operation } finally { this.remoteRequests.delete(operation) }
  }

  /**
   * Read the current rendering generation before reusing a Client PDF.
   * @param signal - Remote caller cancellation.
   * @returns provider lifetime, replaced with rendering, font, or engine configuration.
   */
  @Remote('generation')
  getGeneration(signal: AbortSignal): OfficeKitGeneration { signal.throwIfAborted(); return this.generation }

  private async renderFile(
    scope: WorkspaceFileScope, path: string, priority: OfficeKitPriority, signal: AbortSignal,
  ): Promise<RenderedDocumentBytes> {
    try {
      signal.throwIfAborted()
      const extension = extname(path).slice(1).toLowerCase()
      if (extension !== 'doc' && extension !== 'docx' && extension !== 'xls'
        && extension !== 'xlsx' && extension !== 'ppt' && extension !== 'pptx') {
        throw new OfficeKitError('unsupported-format', 'The path must end in doc, docx, xls, xlsx, ppt, or pptx.')
      }
      const files = this.ctx.get('workspaceFiles')
      const fs = this.ctx.get('fs')
      if (files === undefined || fs === undefined) throw new OfficeKitError('unavailable', 'Office file rendering requires workspaceFiles and fs.')
      const authorized = await files.readBytes(scope, path, { range: { offset: 0, length: 1 } }, signal)
      const source = await files.stat(scope, path, signal)
      const assertUnchanged = (current: WorkspaceFileStat): void => {
        if (current.absolutePath !== source.absolutePath || current.version !== source.version) {
          throw new OfficeKitError('source-changed', 'The source changed.')
        }
      }
      assertUnchanged(authorized)
      signal.throwIfAborted()
      const result = await this.convert({ extension, priority, source: {
        key: brandString<OfficeSourceKey>(JSON.stringify([scope.sessionId, scope.workspaceRoot, source.absolutePath])),
        version: source.version, ...(source.bytes === undefined ? {} : { bytes: source.bytes }),
        read: async (upstream, maxBytes) => {
          const target = await fs.resolve(source.absolutePath, { signal: upstream })
          const info = await fs.stat(target, upstream)
          if (info === undefined || info.type !== 'file') throw new OfficeKitError('source-changed', 'The source changed.')
          assertUnchanged({ absolutePath: fs.processPath(target), version: info.version })
          const bytes = await fs.readBytes(target, upstream, maxBytes).catch(async (cause: unknown) => {
            if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'FS_TOO_LARGE') {
              assertUnchanged(await files.stat(scope, path, upstream))
              throw new OfficeKitError('input-too-large', 'The source exceeds the reserved byte capacity.', { cause })
            }
            throw cause
          })
          upstream.throwIfAborted()
          const after = await files.stat(scope, path, upstream)
          assertUnchanged(after)
          return { bytes, version: source.version }
        },
      } }, signal)
      signal.throwIfAborted()
      return { absolutePath: source.absolutePath, version: source.version,
        offset: 0, eof: true, bytes: result.pdf.byteLength, data: result.pdf,
        missingFonts: result.missingFonts, generation: result.generation }
    } catch (cause) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'The document preview was cancelled.', {}, { cause })
      if (cause instanceof OfficeKitError) {
        throw new RemoteError('document-render/failed', 'Office conversion failed.', { reason: cause.code }, { cause })
      }
      throw cause
    }
  }

  /**
   * Locate and import Kit for a converter. A successful import is reused for the provider lifetime; a missing or
   * unloadable Kit rejects as `unavailable` without being retained, so the next converter request locates Kit again.
   */
  private loadKit(): Promise<LoadedKit> {
    if (this.loadedKit !== undefined) return this.loadedKit
    const loading = this.importKit()
    this.loadedKit = loading
    loading.catch(() => { delete this.loadedKit })
    return loading
  }

  private async importKit(): Promise<LoadedKit> {
    const kit = resolveKitModule(() => import.meta.resolve('@deepseek-ai/libreoffice-kit'))
    if (kit.kind === 'missing') throw this.unavailableKit('LibreOffice Kit is not installed.', kit.error)
    let createConverter: KitModule['createConverter']
    try {
      ({ createConverter } = await import(kit.entry) as KitModule)
    } catch (cause) {
      throw this.unavailableKit('LibreOffice Kit could not be loaded.', cause)
    }
    return { createConverter, resolveEnginePackage: kit.resolveEnginePackage }
  }

  /** Classify a Kit failure as `unavailable`, logging each distinct message and cause once per provider lifetime. */
  private unavailableKit(message: string, cause: unknown): OfficeKitError {
    const error = new OfficeKitError('unavailable', `${message} ${KIT_INSTALL_HINT}`, { cause })
    const key = `${message}\n${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`
    if (!this.reportedKitFailures.has(key)) {
      this.reportedKitFailures.add(key)
      this.ctx.logger.warn(error)
    }
    return error
  }

  private async runOperation(
    bytes: Uint8Array, request: Pick<QueueRequest, 'extension' | 'operation'>, signal: AbortSignal,
  ): Promise<OfficeOperationOutput> {
    signal.throwIfAborted()
    let slot = this.slots.find(candidate => !candidate.busy)
    if (slot === undefined) { slot = { busy: false }; this.slots.push(slot) }
    slot.busy = true
    let directory: string | undefined
    try {
      if (slot.converter === undefined) {
        slot.converter = this.loadKit().then(({ createConverter, resolveEnginePackage }) =>
          createConverter({ ...this.options, resolveEnginePackage })).catch((error: unknown) => {
          delete slot.converter
          throw error
        })
      }
      const converter = await slot.converter
      signal.throwIfAborted()
      directory = await mkdtemp(join(tmpdir(), 'dsh-office-kit-'))
      const inputPath = join(directory, `source.${request.extension}`)
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      const output = await this.runEngine(converter, inputPath, directory, request.operation, signal)
      signal.throwIfAborted()
      return output
    } catch (cause) {
      signal.throwIfAborted()
      if (cause instanceof OfficeKitError) throw cause
      if (cause instanceof TypeError || cause instanceof RangeError) throw new OfficeKitError('invalid-request', cause.message, { cause })
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
      switch (code) {
        case 'input-too-large': case 'output-too-large': case 'invalid-document': case 'unsupported-format':
        case 'invalid-output': case 'timeout': case 'unavailable':
          throw new OfficeKitError(code, cause instanceof Error ? cause.message : 'LibreOffice conversion failed.', { cause })
        default: throw new OfficeKitError('failed', 'LibreOffice conversion failed.', { cause })
      }
    } finally {
      try { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) }
      finally { slot.busy = false }
    }
  }

  /** Run one engine operation in a private scratch directory and read its complete, bounded output. */
  private async runEngine(
    converter: Converter, inputPath: string, directory: string, operation: OfficeOperation, signal: AbortSignal,
  ): Promise<OfficeOperationOutput> {
    switch (operation.kind) {
      case 'pdf': {
        const outputPath = join(directory, 'converted.pdf')
        const result = await converter.render({ inputPath, outputPath }, signal)
        return { kind: 'pdf', pdf: await this.readFile(outputPath, 'pdf', signal), missingFonts: result.missingFonts }
      }
      case 'convert': case 'recalculate': {
        const outputPath = join(directory, `output.${operation.format}`)
        const result = operation.kind === 'convert'
          ? await converter.convert({ inputPath, outputPath, ...(operation.sheet === undefined ? {} : { sheet: operation.sheet }) }, signal)
          : await converter.recalculate({ inputPath, outputPath }, signal)
        return { kind: 'file', data: await this.readFile(outputPath, operation.format, signal),
          ...(result.pageCount === undefined ? {} : { pageCount: result.pageCount }), missingFonts: result.missingFonts }
      }
      case 'images': return this.renderPng(converter, inputPath, directory, operation, signal)
      /* v8 ignore next -- OfficeOperation is a closed union */
      default: throw new Error(`Unexpected Office operation: ${JSON.stringify(operation satisfies never)}`)
    }
  }

  private async readFile(path: string, format: string, signal: AbortSignal): Promise<Uint8Array> {
    try {
      return format === 'pdf' ? await readPdf(path, this.config.maxOutputBytes, signal) : await readOutput(path, this.config.maxOutputBytes, signal)
    } catch (cause) {
      if (cause instanceof OfficeKitError) throw cause
      throw new OfficeKitError('invalid-output', 'The converter output could not be read.', { cause })
    }
  }

  private async renderPng(
    converter: Converter, inputPath: string, directory: string, operation: Extract<OfficeOperation, { kind: 'images' }>,
    signal: AbortSignal,
  ): Promise<OfficeOperationOutput> {
    const outputDir = join(directory, 'images')
    const result = await converter.renderImages({
      inputPath, outputDir,
      ...(operation.pages === undefined ? {} : { pages: operation.pages }),
      ...(operation.sheet === undefined ? {} : { sheet: operation.sheet }),
      ...(operation.range === undefined ? {} : { range: operation.range }),
      ...(operation.dpi === undefined ? {} : { dpi: operation.dpi }),
      maxPages: operation.maxImages, maxPixels: operation.maxPixels, maxDimension: operation.maxDimension,
    }, signal)
    const declared = result.images.reduce((sum, image) => sum + image.byteLength, 0)
    if (declared > operation.maxBytes) {
      throw new OfficeKitError('output-too-large', `The rendered images total ${declared} bytes, above the ${operation.maxBytes}-byte limit.`)
    }
    const images = []
    let remaining = operation.maxBytes
    for (const image of [...result.images].sort((left, right) => left.index - right.index)) {
      const within = relative(outputDir, image.path)
      if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
        throw new OfficeKitError('invalid-output', 'The converter reported an image outside its output directory.')
      }
      let png: Uint8Array
      try { png = await readPng(image.path, remaining, signal) }
      catch (cause) {
        if (cause instanceof OfficeKitError) throw cause
        throw new OfficeKitError('invalid-output', 'The rendered image could not be read.', { cause })
      }
      remaining -= png.byteLength
      images.push({ png, width: image.width, height: image.height,
        ...(image.page === undefined ? {} : { page: image.page }),
        ...(image.sheet === undefined ? {} : { sheet: image.sheet }),
        ...(image.range === undefined ? {} : { range: image.range }) })
    }
    return { kind: 'images', images, pageCount: result.pageCount, dpi: result.dpi, missingFonts: result.missingFonts }
  }
}

export default OfficeKit
