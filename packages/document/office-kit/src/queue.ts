/** Bounded source admission, shared content conversion, and caller-owned output delivery. */
import { createHash } from 'node:crypto'
import { OfficeKitError } from './errors.ts'
import { OfficeKitKey, type OfficeKitGeneration } from './identity.ts'
import type {
  OfficeConversionFormat, OfficeImage, OfficeKitPriority, OfficeKitSource, OfficeRecalculationFormat,
} from './types.ts'
import type { Config } from './index.ts'

/** Engine operation applied to one admitted source; its JSON form distinguishes cached outputs. */
export type OfficeOperation =
  | { readonly kind: 'pdf' }
  | {
    readonly kind: 'images'
    readonly pages?: readonly number[]
    readonly sheet?: string
    readonly range?: string
    readonly dpi?: number
    readonly maxImages: number
    readonly maxPixels: number
    readonly maxDimension: number
    readonly maxBytes: number
  }
  | { readonly kind: 'convert'; readonly format: OfficeConversionFormat; readonly sheet?: string }
  | { readonly kind: 'recalculate'; readonly format: OfficeRecalculationFormat }

/** Complete engine output for one operation kind. */
export type OfficeOperationOutput =
  | { readonly kind: 'pdf'; readonly pdf: Uint8Array; readonly missingFonts: string[] }
  | {
    readonly kind: 'images'
    readonly images: readonly OfficeImage[]
    readonly pageCount: number
    readonly dpi: number
    readonly missingFonts: string[]
  }
  | { readonly kind: 'file'; readonly data: Uint8Array; readonly pageCount?: number; readonly missingFonts: string[] }

/** Output kind produced by each operation. */
export type OutputOf<O extends OfficeOperation> = Extract<OfficeOperationOutput, { kind: O['kind'] extends 'convert' | 'recalculate' ? 'file' : O['kind'] }>

/** One admitted operation on an authorized source. */
export interface QueueRequest<O extends OfficeOperation = OfficeOperation> {
  readonly extension: string
  readonly priority: OfficeKitPriority
  readonly source: OfficeKitSource
  readonly operation: O
}

/** Caller-owned output with its converter-owned identity. */
export type QueueResult<O extends OfficeOperation = OfficeOperation> = OutputOf<O> & {
  readonly cacheKey: OfficeKitKey
  readonly generation: OfficeKitGeneration
}

type Stored = OfficeOperationOutput & { readonly cacheKey: OfficeKitKey; readonly generation: OfficeKitGeneration }
type Convert = (bytes: Uint8Array, request: Pick<QueueRequest, 'extension' | 'operation'>, signal: AbortSignal) => Promise<OfficeOperationOutput>
interface Reader {
  job: Job
  readonly source: string
  readonly priority: OfficeKitPriority
  readonly resolve: (value: Stored) => void
  readonly reject: (error: unknown) => void
  readonly cleanup: () => void
}
interface Job {
  readonly request: QueueRequest
  readonly operation: string
  readonly controller: AbortController
  readonly readers: Set<Reader>
  readonly sources: Set<string>
  priority: OfficeKitPriority
  state: 'queued' | 'running' | 'finished'
}

/** Bytes a retained output occupies. */
function outputBytes(output: OfficeOperationOutput): number {
  switch (output.kind) {
    case 'pdf': return output.pdf.byteLength
    case 'file': return output.data.byteLength
    case 'images': return output.images.reduce((sum, image) => sum + image.png.byteLength, 0)
    /* v8 ignore next -- OfficeOperationOutput is a closed union */
    default: return exhausted(output)
  }
}

/** Independent copy of every byte array and list in an output. */
function copyOutput(result: Stored): Stored {
  switch (result.kind) {
    case 'pdf': return { ...result, pdf: Uint8Array.from(result.pdf), missingFonts: [...result.missingFonts] }
    case 'file': return { ...result, data: Uint8Array.from(result.data), missingFonts: [...result.missingFonts] }
    case 'images': return { ...result, missingFonts: [...result.missingFonts],
      images: result.images.map(image => ({ ...image, png: Uint8Array.from(image.png) })) }
    /* v8 ignore next -- OfficeOperationOutput is a closed union */
    default: return exhausted(result)
  }
}

/* v8 ignore next 3 -- reached only through an unchecked closed-union member */
function exhausted(value: never): never {
  throw new Error(`Unexpected Office output: ${JSON.stringify(value)}`)
}

/** One converter generation owns every queued source, conversion, reader, and retained PDF. */
export class ConversionQueue {
  private readonly ready = new Map<OfficeKitKey, Stored>()
  private readonly aliases = new Map<string, OfficeKitKey>()
  private readonly sources = new Map<string, Job>()
  private readonly digests = new Map<OfficeKitKey, Job>()
  private readonly queue: Job[] = []
  private readonly tasks = new Set<Promise<void>>()
  private readonly jobs = new Set<Job>()
  private cachedBytes = 0
  private sourceBytes = 0
  private running = 0
  private background = 0
  private readers = 0
  private disposed = false

  /**
   * @param config - validated queue, source, reader, and completed-result limits.
   * @param generation - provider lifetime; prevents reuse after engine or font replacement.
   * @param convert - executes one admitted conversion and settles after scratch cleanup.
   */
  constructor(private readonly config: Config, private readonly generation: OfficeKitGeneration,
    private readonly convert: Convert) {}

  /**
   * Admit metadata before loading source bytes and share conversion across authorized readers.
   * @param request - already-authorized metadata and deferred bounded source read.
   * @param signal - this reader's cancellation; the final reader cancels shared work.
   * @returns independent output bytes; busy or canceled readers reject without releasing active engine capacity early.
   */
  async read<O extends OfficeOperation>(request: QueueRequest<O>, signal?: AbortSignal): Promise<QueueResult<O>> {
    // The stored output was produced for this request's operation kind.
    return await this.readStored(request, signal) as QueueResult<O>
  }

  private async readStored(request: QueueRequest, signal?: AbortSignal): Promise<Stored> {
    signal?.throwIfAborted()
    if (this.disposed) throw this.unavailable()
    if (request.source.bytes !== undefined && request.source.bytes > this.config.maxInputBytes) {
      throw new OfficeKitError('input-too-large', 'The Office source exceeds maxInputBytes.')
    }
    const operation = JSON.stringify(request.operation)
    const source = JSON.stringify([request.source.key, request.source.version, request.extension, operation])
    const alias = this.aliases.get(source)
    const cached = alias === undefined ? undefined : this.ready.get(alias)
    if (cached !== undefined) {
      this.ready.delete(cached.cacheKey)
      this.ready.set(cached.cacheKey, cached)
      this.aliases.delete(source)
      this.aliases.set(source, cached.cacheKey)
      return this.copy(cached)
    }
    const readerLimit = request.priority === 'background' ? this.config.maxReaders - 1 : this.config.maxReaders
    if (this.readers >= readerLimit) throw this.busy()
    if (request.priority === 'background' && this.config.maxBackgroundConversions === 0) throw this.busy()
    let job = this.sources.get(source)
    if (job === undefined) {
      if (this.queue.length >= this.config.maxQueuedJobs) {
        const obsolete = request.priority === 'foreground' ? this.queue.find(item => item.priority === 'background') : undefined
        if (obsolete === undefined) throw this.busy()
        this.fail(obsolete, this.busy())
      }
      job = { request, operation, priority: request.priority, controller: new AbortController(), readers: new Set(), sources: new Set([source]), state: 'queued' }
      this.sources.set(source, job)
      this.jobs.add(job)
      this.queue.push(job)
    }
    const shared = job
    if (request.priority === 'foreground') shared.priority = 'foreground'
    this.readers++
    const promise = new Promise<Stored>((resolve, reject) => {
      const abort = (): void => {
        this.release(reader)
        const reason: unknown = signal?.reason
        reject(reason instanceof Error ? reason : new Error('Office conversion cancelled', { cause: reason }))
        if (reader.job.readers.size === 0) this.cancel(reader.job)
        // Cancellation or demotion can unblock queued background work.
        this.drain()
      }
      const reader: Reader = { job: shared, source, priority: request.priority, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) }
      shared.readers.add(reader)
      signal?.addEventListener('abort', abort, { once: true })
    })
    this.drain()
    return promise
  }

  /** Cancel all readers and wait until actual reads, conversions, and scratch cleanup finish. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const job of this.jobs) this.fail(job, this.unavailable())
    this.ready.clear()
    this.aliases.clear()
    this.cachedBytes = 0
    await Promise.allSettled(this.tasks)
  }

  private busy(): OfficeKitError { return new OfficeKitError('busy', 'The document converter has reached its admission limit.') }
  private unavailable(): OfficeKitError { return new OfficeKitError('unavailable', 'The document converter is unavailable.') }
  private copy(result: Stored): Stored { return copyOutput(result) }
  private release(reader: Reader): void {
    reader.job.readers.delete(reader)
    if (reader.job.state === 'queued') {
      reader.job.priority = [...reader.job.readers].some(other => other.priority === 'foreground') ? 'foreground' : 'background'
    }
    if (![...reader.job.readers].some(other => other.source === reader.source)) {
      reader.job.sources.delete(reader.source)
      if (this.sources.get(reader.source) === reader.job) this.sources.delete(reader.source)
    }
    reader.cleanup()
    this.readers--
  }
  private cancel(job: Job): void {
    job.controller.abort()
    if (job.state === 'queued') {
      this.queue.splice(this.queue.indexOf(job), 1)
      job.state = 'finished'
      this.jobs.delete(job)
    }
  }
  private fail(job: Job, error: unknown): void {
    for (const reader of job.readers) { this.release(reader); reader.reject(error) }
    this.cancel(job)
  }
  private reservation(job: Job): number { return Math.max(1, job.request.source.bytes ?? this.config.maxInputBytes) }

  private drain(): void {
    while (!this.disposed && this.running < this.config.maxConcurrentConversions) {
      const eligible = (job: Job): boolean => this.sourceBytes + this.reservation(job) <= this.config.maxSourceBytes
        && (job.priority === 'foreground' || this.background < Math.min(this.config.maxBackgroundConversions, Math.max(1, this.config.maxConcurrentConversions - 1)))
      const foregroundWaiting = this.queue.some(item => item.priority === 'foreground')
      const job = this.queue.find(item => (!foregroundWaiting || item.priority === 'foreground') && eligible(item))
      if (job === undefined) return
      this.queue.splice(this.queue.indexOf(job), 1)
      job.state = 'running'
      const background = job.priority === 'background'
      const reserved = this.reservation(job)
      this.running++
      if (background) this.background++
      this.sourceBytes += reserved
      const task = this.execute(job, reserved).catch((error: unknown) => { this.fail(job, error) }).finally(() => {
        this.running--
        if (background) this.background--
        this.sourceBytes -= reserved
        job.state = 'finished'
        this.jobs.delete(job)
        this.tasks.delete(task)
        this.drain()
      })
      this.tasks.add(task)
    }
  }

  private async execute(job: Job, reserved: number): Promise<void> {
    const signal = job.controller.signal
    signal.throwIfAborted()
    const input = await job.request.source.read(signal, reserved)
    signal.throwIfAborted()
    if (input.version !== job.request.source.version) throw new OfficeKitError('source-changed', 'The source changed while waiting for conversion.')
    if (input.bytes.byteLength > reserved) throw new OfficeKitError('input-too-large', 'The source exceeds its reserved read capacity.')
    const digest = createHash('sha256').update(job.request.extension).update('\0').update(job.operation).update('\0')
      .update(input.bytes).digest('hex')
    const key = OfficeKitKey(`${this.generation}:${digest}`)
    const cached = this.ready.get(key)
    if (cached !== undefined) {
      this.ready.delete(key)
      this.ready.set(key, cached)
      this.finish(job, cached)
      return
    }
    const existing = this.digests.get(key)
    if (existing !== undefined && !existing.controller.signal.aborted) {
      if (job.priority === 'foreground') existing.priority = 'foreground'
      for (const reader of job.readers) { reader.job = existing; existing.readers.add(reader) }
      job.readers.clear()
      for (const source of job.sources) { existing.sources.add(source); this.sources.set(source, existing) }
      job.sources.clear()
      return
    }
    this.digests.set(key, job)
    try {
      const converted = await this.convert(input.bytes, job.request, signal)
      signal.throwIfAborted()
      const result: Stored = { ...converted, cacheKey: key, generation: this.generation }
      this.retain(result)
      this.finish(job, result)
    } finally { if (this.digests.get(key) === job) this.digests.delete(key) }
  }

  private finish(job: Job, result: Stored): void {
    for (const source of job.sources) this.sources.delete(source)
    if (this.ready.has(result.cacheKey)) {
      for (const source of job.sources) {
        this.aliases.delete(source)
        this.aliases.set(source, result.cacheKey)
        while (this.aliases.size > this.config.maxSourceEntries) this.aliases.delete(this.aliases.keys().next().value as string)
      }
    }
    for (const reader of job.readers) { this.release(reader); reader.resolve(this.copy(result)) }
  }
  private retain(result: Stored): void {
    const bytes = outputBytes(result)
    if (bytes > this.config.maxCachedBytes) return
    while (this.ready.size >= this.config.maxCachedEntries || this.cachedBytes + bytes > this.config.maxCachedBytes) {
      const [key, oldest] = this.ready.entries().next().value as [OfficeKitKey, Stored]
      this.ready.delete(key)
      this.cachedBytes -= outputBytes(oldest)
      for (const [source, digest] of this.aliases) if (digest === key) this.aliases.delete(source)
    }
    this.ready.set(result.cacheKey, result)
    this.cachedBytes += bytes
  }
}
