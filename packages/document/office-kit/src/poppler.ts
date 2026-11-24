/**
 * PDF rasterization with Poppler's `pdfinfo` and `pdftoppm` as short-lived subprocesses. The PDF reaches each process
 * through stdin and `pdftoppm` returns PNG images through stdout, so no file is shared with the process and the
 * subprocess provider's execution world needs no access to Host files. Each process receives argv only, never a shell
 * command or a caller-supplied path, and is terminated and awaited before its call settles.
 */
import { dirname } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, type SubprocessOutcome, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OfficeKitError } from './errors.ts'
import type { OfficeOperation, OfficeOperationOutput } from './queue.ts'
import type { OfficeImage } from './types.ts'

/** Configured Poppler executables: bare PATH names or absolute paths in the subprocess execution world. */
export interface PopplerExecutables {
  readonly pdftoppm: string
  readonly pdfinfo: string
}

/** Resolved Poppler executables and the subprocess provider that runs them. */
export interface PopplerTools {
  readonly subprocess: SubprocessRuntime
  readonly pdftoppm: string
  readonly pdfinfo: string
}

type ImagesOperation = Extract<OfficeOperation, { kind: 'images' }>

/** Resolution used when a request omits `dpi`; equal to the LibreOffice Kit default. */
const DEFAULT_DPI = 144
/** Retained stderr tail of one process, kept only as a failure cause. */
const STDERR_BYTES = 8192
/** Retained pdfinfo stdout tail; the document properties precede `Pages:`, and only short fixed fields follow it. */
const PDFINFO_STDOUT_BYTES = 65536
/** Bytes written to stdin before waiting for the process to read them. */
const STDIN_CHUNK_BYTES = 65536
/** Termination grace for a canceled or timed-out process. */
const GRACE_MS = 2000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Locate Poppler where the subprocess provider runs processes: the provider must exist and resolve both executables.
 * Only a completed lookup that found no executable makes Poppler unavailable; every other lookup failure, such as an
 * unreachable provider, keeps its own error so the caller can report the real cause.
 * @param ctx - provider context holding the optional `subprocess` service.
 * @param executables - configured executable names or absolute paths.
 * @param signal - cancellation of executable lookup.
 * @returns the resolved executables and their subprocess provider.
 * @throws {OfficeKitError} `unavailable` when the provider is absent or an executable is not found; other lookup
 * failures pass through unchanged, and cancellation rejects with its reason.
 */
export async function locatePoppler(ctx: Context, executables: PopplerExecutables, signal?: AbortSignal): Promise<PopplerTools> {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new OfficeKitError('unavailable', 'Poppler rendering requires the subprocess service.')
  try {
    const [pdftoppm, pdfinfo] = await Promise.all([
      subprocess.resolveExecutable(executables.pdftoppm, undefined, signal),
      subprocess.resolveExecutable(executables.pdfinfo, undefined, signal),
    ])
    return { subprocess, pdftoppm, pdfinfo }
  } catch (cause) {
    signal?.throwIfAborted()
    if (!(cause instanceof SubprocessExecutableNotFoundError)) throw cause
    throw new OfficeKitError('unavailable', `Poppler was not found: ${cause.message} Install Poppler or configure poppler executable paths.`, { cause })
  }
}

/**
 * Render selected PDF pages with Poppler under one deadline. One `pdfinfo` reads the page count, then one
 * `pdftoppm -cropbox` renders each run of consecutive pages. Page dimensions are checked only after rendering, from
 * each PNG header; Poppler renders inclusive page ranges and a check before rendering would send the whole PDF to one
 * more process.
 * @param tools - located Poppler executables.
 * @param pdf - complete source bytes, written to each process's stdin.
 * @param operation - selection, resolution, and complete-result limits.
 * @param timeoutMs - deadline for every pdfinfo and pdftoppm process of this call.
 * @param signal - caller cancellation; terminates the running process.
 * @returns PNG images in ascending page order with the document's page count.
 * @throws {OfficeKitError} `invalid-request` for a malformed or out-of-range selection, `output-too-large` above a
 * count, pixel, dimension, or byte limit, `invalid-document` when Poppler cannot open the PDF, `invalid-output` for
 * unexpected Poppler output, `timeout` past the deadline, and `failed` for other process failures; cancellation
 * rejects with its reason.
 */
export async function renderPdf(
  tools: PopplerTools, pdf: Uint8Array, operation: ImagesOperation, timeoutMs: number, signal: AbortSignal,
): Promise<Extract<OfficeOperationOutput, { kind: 'images' }>> {
  const dpi = operation.dpi ?? DEFAULT_DPI
  checkSelection(operation)
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new OfficeKitError('timeout', `Poppler rendering exceeded ${timeoutMs} ms.`)) }, timeoutMs)
  const run = AbortSignal.any([signal, deadline.signal])
  try {
    const pageCount = parsePageCount(await runTool(tools, 'pdfinfo', ['-'], pdf, run, PDFINFO_STDOUT_BYTES))
    const runs = contiguousRuns(selectPages(operation, pageCount))
    const images: OfficeImage[] = []
    let remaining = operation.maxBytes
    for (const [first, last] of runs) {
      const splitter = new PngSplitter(remaining)
      await runTool(tools, 'pdftoppm', ['-png', '-cropbox', '-r', String(dpi), '-f', String(first), '-l', String(last), '-'], pdf, run,
        async (stdout) => { for await (const chunk of stdout) splitter.push(chunk as Buffer) })
      const pngs = splitter.finish()
      if (pngs.length !== last - first + 1) {
        throw new OfficeKitError('invalid-output', `pdftoppm returned ${pngs.length} images for ${last - first + 1} pages.`)
      }
      for (const [index, { png, width, height }] of pngs.entries()) {
        const page = first + index
        if (width > operation.maxDimension || height > operation.maxDimension || width * height > operation.maxPixels) {
          throw new OfficeKitError('output-too-large', `Page ${page} rendered at ${width}x${height} px, above maxPixels or maxDimension; reduce DPI or raise the image limits.`)
        }
        remaining -= png.byteLength
        images.push({ png, width, height, page })
      }
    }
    return { kind: 'images', images, pageCount, dpi, missingFonts: [] }
  } catch (cause) {
    if (deadline.signal.aborted && !signal.aborted) throw deadline.signal.reason
    throw cause
  } finally { clearTimeout(timer) }
}

/**
 * Refuse a selection with more pages than the image limit before any process starts. The model-facing tool owns the
 * resolution range, page uniqueness, and worksheet-argument rules; a request that reaches this provider has already
 * passed them.
 */
function checkSelection(operation: ImagesOperation): void {
  const { pages } = operation
  if (pages !== undefined && pages.length > operation.maxImages) {
    throw new OfficeKitError('output-too-large', 'Selected page count exceeds maxImages.')
  }
}

/** Ascending selected pages of a `pageCount`-page document. */
function selectPages(operation: ImagesOperation, pageCount: number): number[] {
  if (pageCount < 1) throw new OfficeKitError('invalid-document', 'The document contains no renderable pages.')
  if (operation.pages === undefined) {
    if (pageCount > operation.maxImages) {
      throw new OfficeKitError('output-too-large', 'Selected page count exceeds maxImages; select pages or raise the limit.')
    }
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }
  const pages = [...operation.pages].sort((left, right) => left - right)
  if (Math.max(...pages) > pageCount) throw new OfficeKitError('invalid-request', `Selected page lies outside the ${pageCount}-page document.`)
  return pages
}

/** Group distinct ascending pages into inclusive `[first, last]` ranges of consecutive pages. */
function contiguousRuns(pages: readonly number[]): [number, number][] {
  const runs: [number, number][] = []
  for (const page of pages) {
    const last = runs.at(-1)
    if (last !== undefined && last[1] + 1 === page) last[1] = page
    else runs.push([page, page])
  }
  return runs
}

/**
 * Read the page count from the last `Pages:` line. pdfinfo prints document properties such as Title before it, and a
 * property value containing a newline can forge an earlier `Pages:` line; only fixed-format fields follow the real one.
 */
function parsePageCount(stdout: string): number {
  const match = [...stdout.matchAll(/^Pages:\s+(\d+)\s*$/gmu)].at(-1)
  if (match === undefined) throw new OfficeKitError('invalid-output', 'pdfinfo did not report the page count.')
  return Number(match[1])
}

/** One complete PNG and the dimensions its IHDR chunk declares. */
interface SplitPng {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
}

/**
 * Split concatenated PNG streams at chunk boundaries as bytes arrive. Each image is a signature, an IHDR chunk, and
 * further chunks through IEND; a chunk header or signature may span reads.
 */
class PngSplitter {
  private readonly images: SplitPng[] = []
  private parts: Buffer[] = []
  /** Signature or chunk header bytes collected so far. */
  private readonly header = Buffer.alloc(8)
  private headerBytes = 0
  /** Data and CRC bytes still to pass through for the current chunk. */
  private chunkBytes = 0
  private chunkType = ''
  private inImage = false
  private total = 0

  /** @param maxBytes - inclusive limit of all bytes received. */
  constructor(private readonly maxBytes: number) {}

  /**
   * Consume the next stdout bytes.
   * @param data - bytes in stream order.
   * @throws {OfficeKitError} `output-too-large` once the total exceeds the limit and `invalid-output` for bytes that do not
   * form PNG images.
   */
  push(data: Buffer): void {
    this.total += data.byteLength
    if (this.total > this.maxBytes) {
      throw new OfficeKitError('output-too-large', `The rendered images exceed the ${this.maxBytes}-byte limit.`)
    }
    let offset = 0
    while (offset < data.byteLength) {
      if (this.chunkBytes > 0) {
        const take = Math.min(this.chunkBytes, data.byteLength - offset)
        this.parts.push(data.subarray(offset, offset + take))
        offset += take
        this.chunkBytes -= take
        if (this.chunkBytes === 0 && this.chunkType === 'IEND') this.completeImage()
        continue
      }
      const take = Math.min(8 - this.headerBytes, data.byteLength - offset)
      data.copy(this.header, this.headerBytes, offset, offset + take)
      this.parts.push(data.subarray(offset, offset + take))
      offset += take
      this.headerBytes += take
      if (this.headerBytes === 8) this.readHeader()
    }
  }

  /**
   * End the stream.
   * @returns every complete image in stream order.
   * @throws {OfficeKitError} `invalid-output` when the stream ends inside an image.
   */
  finish(): SplitPng[] {
    if (this.parts.length > 0) throw new OfficeKitError('invalid-output', 'pdftoppm output ended inside a PNG image.')
    return this.images
  }

  private readHeader(): void {
    this.headerBytes = 0
    if (!this.inImage) {
      if (!this.header.equals(PNG_SIGNATURE)) throw new OfficeKitError('invalid-output', 'pdftoppm did not produce a PNG image.')
      this.inImage = true
      this.chunkType = ''
      return
    }
    const length = this.header.readUInt32BE(0)
    this.chunkType = this.header.toString('latin1', 4, 8)
    this.chunkBytes = length + 4
  }

  private completeImage(): void {
    const png = Buffer.concat(this.parts)
    this.parts = []
    this.inImage = false
    this.images.push({ png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) })
  }
}

/**
 * Write `bytes` to a process's stdin, waiting whenever the stream asks the writer to, then close it. A stream error,
 * such as EPIPE after the process stops reading, or a closed stream ends the write; the process's exit status then
 * reports the outcome.
 */
async function feed(stdin: Writable, bytes: Uint8Array): Promise<void> {
  const state = { stopped: false }
  const stop = new Promise<void>((resolve) => {
    const end = (): void => { state.stopped = true; resolve() }
    stdin.on('error', end)
    stdin.once('close', end)
  })
  for (let offset = 0; offset < bytes.byteLength && !state.stopped; offset += STDIN_CHUNK_BYTES) {
    if (!stdin.write(bytes.subarray(offset, offset + STDIN_CHUNK_BYTES))) {
      await Promise.race([new Promise((resolve) => { stdin.once('drain', resolve) }), stop])
    }
  }
  if (!state.stopped) stdin.end()
}

/**
 * Run one Poppler process with `input` on stdin to completion. Text stdout is collected up to `stdout` bytes, or a
 * reader consumes piped stdout while stdin is written. Settles only after the provider's managed range is empty,
 * including after a reader failure or cancellation.
 * @returns collected stdout text, or an empty string when a reader consumed it.
 */
async function runTool(
  tools: PopplerTools, program: 'pdfinfo' | 'pdftoppm', args: readonly string[], input: Uint8Array, signal: AbortSignal,
  stdout: number | ((stream: Readable) => Promise<void>),
): Promise<string> {
  signal.throwIfAborted()
  const executable = tools[program]
  const handle = tools.subprocess.spawn({
    // Any directory of the execution world serves; the executable's own directory exists wherever it resolved.
    argv: [executable, ...args], cwd: dirname(executable), graceMs: GRACE_MS, signal,
    stdio: { stdin: 'pipe', stdout: typeof stdout === 'number' ? { maxBytes: stdout } : 'pipe', stderr: { maxBytes: STDERR_BYTES } },
  })
  // `stdin: 'pipe'` and `stdout: 'pipe'` make the handle expose these streams.
  const stdin = handle.stdin as Writable
  const feeding = feed(stdin, input)
  const exited = handle.done.then((outcome): { outcome: SubprocessOutcome } => ({ outcome }), (error: unknown) => ({ error }))
  let settled: Awaited<typeof exited>
  try {
    if (typeof stdout !== 'number') await stdout(handle.stdout as Readable)
    settled = await exited
  } finally {
    handle.terminate()
    await handle.waitForExit()
    stdin.destroy()
    await feeding
  }
  if ('error' in settled) throw settled.error
  signal.throwIfAborted()
  const { outcome } = settled
  if (outcome.exitCode === 0) return handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  const status = outcome.exitCode ?? outcome.signal
  const cause = new Error(`${program} exited with ${status}: ${stderr.trim()}`)
  // Poppler utilities exit with 1 when they cannot open the PDF file.
  if (outcome.exitCode === 1) throw new OfficeKitError('invalid-document', 'Poppler could not open the PDF.', { cause })
  throw new OfficeKitError('failed', `${program} failed with exit ${status}.`, { cause })
}
