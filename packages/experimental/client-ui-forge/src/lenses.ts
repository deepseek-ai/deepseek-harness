/** Filter lenses registered on the forge panel host, the runs that classify one diff with one of them, and the kept results. */

import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {
  ForgeLens, ForgeLensFile, ForgeLensFrame, ForgeLensInput, ForgeLensKeep, ForgeLensSource, ForgeRegisteredLens,
} from './types.ts'

/** The files a lens kept, by path. */
export type LensFiles = Readonly<Record<string, ForgeLensKeep>>

/** Why a lens run produced no result; the message names the cause for the reader. */
export class LensFailed extends Error {
  override name = 'LensFailed'
}

/** The reason a run stops when its lens's registration ends. */
export class LensWithdrawn extends Error {
  override name = 'LensWithdrawn'
}

/** One registered lens and the runs that use it. */
export interface LensRegistration {
  /** The lens as its plugin registered it. */
  readonly lens: ForgeLens
  /** Aborts with a {@link LensWithdrawn} once the registration ends. */
  readonly lifetime: AbortSignal
  /**
   * Keep one run among the work the registration's disposer waits for.
   * @param run - the run.
   * @returns the same run.
   */
  track<T>(run: Promise<T>): Promise<T>
}

/**
 * The lenses registered on one panel host. Identities are unique while registered; the follow streams of every reader
 * receive the list after each change, and end once the registry closes.
 */
export class LensRegistry {
  private readonly entries = new Map<string, LensRegistration>()
  private readonly listeners = new Set<() => void>()
  private readonly closed = new AbortController()

  /**
   * Register a lens.
   * @param lens - the lens.
   * @returns the disposer, which aborts the lens's running classifications and waits for them.
   * @throws when another registration holds `lens.id`.
   */
  add(lens: ForgeLens): () => Promise<void> {
    if (this.entries.has(lens.id)) throw new Error(`forge-panel: a lens "${lens.id}" is already registered`)
    const lifetime = new AbortController()
    const runs = new Set<Promise<void>>()
    const registration: LensRegistration = {
      lens,
      lifetime: lifetime.signal,
      track: (run) => {
        const settled = run.then(() => undefined, () => undefined)
        runs.add(settled)
        void settled.then(() => runs.delete(settled))
        return run
      },
    }
    this.entries.set(lens.id, registration)
    this.changed()
    return async () => {
      this.entries.delete(lens.id)
      lifetime.abort(new LensWithdrawn(`the lens "${lens.id}" was unregistered`))
      this.changed()
      await Promise.allSettled([...runs])
    }
  }

  /**
   * Find a registered lens.
   * @param id - its identity.
   * @returns the registration, or undefined while no lens holds the identity.
   */
  get(id: string): LensRegistration | undefined {
    return this.entries.get(id)
  }

  /**
   * Stream the registered lenses: the current list first, then the list after each change; changes that arrive while
   * the reader is busy collapse into the next list.
   * @param signal - ends the stream.
   * @returns identities and versions in registration order.
   */
  async *follow(signal: AbortSignal): AsyncIterable<readonly ForgeRegisteredLens[]> {
    const stop = AbortSignal.any([signal, this.closed.signal])
    let wake = Promise.withResolvers<void>()
    const listener = (): void => { wake.resolve() }
    this.listeners.add(listener)
    stop.addEventListener('abort', listener)
    try {
      while (!stop.aborted) {
        const current = wake
        yield [...this.entries.values()].map(({ lens }) => ({ id: lens.id, version: lens.version }))
        await current.promise
        wake = Promise.withResolvers()
      }
    } finally {
      this.listeners.delete(listener)
      stop.removeEventListener('abort', listener)
    }
  }

  /** End every follow stream; registrations still end through their own disposers. */
  close(): void {
    this.closed.abort()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/** One diff a lens classifies, with the reader of its files' sides. */
export interface LensSubject {
  /** What the view shows. */
  readonly source: ForgeLensSource
  /** Every file of the diff in display order. */
  readonly files: readonly ForgeLensFile[]
  /**
   * Read one side of a file of `files`.
   * @returns the text, or null when the side does not exist or holds binary content.
   */
  readonly read: (side: 'old' | 'new', file: ForgeLensFile, signal: AbortSignal) => Promise<string | null>
}

/** Bounds of one lens run, from the panel's configuration. */
export interface LensLimits {
  /** `lensTimeoutMs`. */
  readonly timeoutMs: number
  /** `maxLensReadBytes`. */
  readonly maxReadBytes: number
  /** `maxCachedLensBytes`, which bounds one result as JSON. */
  readonly maxResultBytes: number
}

/**
 * Classify one diff with one lens. The lens's signal aborts with the caller's, when the registration ends, and after
 * `timeoutMs`; the run settles then even when the lens ignores its signal, while the registration's disposer waits until
 * `classify` itself settles. A run whose signal aborted before it started does not call the lens. Paths the lens names
 * outside the diff are left out of the result.
 * @param registration - the registered lens.
 * @param subject - the diff and its reader.
 * @param limits - deadline, read budget, and result bound.
 * @param signal - the caller's cancellation.
 * @param progress - receives the lens's progress while it runs.
 * @returns the files the lens kept.
 * @throws `signal.reason` once the caller aborts; a {@link LensWithdrawn} once the registration ends; a
 * {@link LensFailed} when the lens rejects, runs past the deadline, reads past the budget, or answers over the bound.
 */
export async function runLens(
  registration: LensRegistration,
  subject: LensSubject,
  limits: LensLimits,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<LensFiles> {
  using timer = deadline(AbortSignal.any([signal, registration.lifetime]), limits.timeoutMs, 'FORGE_LENS_TIMEOUT')
  const operation = timer.signal
  const byPath = new Map(subject.files.map(file => [file.path, file]))
  let read = 0
  const overBudget = (): LensFailed => new LensFailed(`the lens read more than maxLensReadBytes (${limits.maxReadBytes} bytes) of file text`)
  const input: ForgeLensInput = {
    source: subject.source,
    files: subject.files,
    text: async (side, path, inner) => {
      const file = byPath.get(path)
      if (file === undefined) throw new Error(`forge-panel: ${JSON.stringify(path)} is not a file of this diff`)
      if (read > limits.maxReadBytes) throw overBudget()
      const text = await subject.read(side, file, AbortSignal.any([inner, operation]))
      if (text === null) return null
      read += Buffer.byteLength(text)
      if (read > limits.maxReadBytes) throw overBudget()
      return text
    },
    progress: (done, total) => { if (!operation.aborted) progress(done, total) },
  }
  let result: Awaited<ReturnType<ForgeLens['classify']>>
  try {
    // A registration that ended or a caller that left before the run starts never reaches the lens.
    operation.throwIfAborted()
    const stopped = new Promise<never>((_resolve, reject) => {
      operation.addEventListener('abort', () => { reject(new Error('the lens run stopped', { cause: operation.reason })) }, { once: true })
    })
    // The race observes `stopped`; this handler only keeps a later abort from rejecting unobserved.
    void stopped.catch(() => undefined)
    // The registration's disposer waits for the classification itself; the race only decides when the caller hears back.
    const classified = registration.track(Promise.resolve().then(() => registration.lens.classify(input, operation)))
    result = await Promise.race([classified, stopped])
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (registration.lifetime.aborted) throw registration.lifetime.reason
    if (timeoutOf(operation) !== undefined) throw new LensFailed(`the lens ran past lensTimeoutMs (${limits.timeoutMs} ms)`)
    if (error instanceof LensFailed) throw error
    throw new LensFailed(`the lens failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (read > limits.maxReadBytes) throw overBudget()
  const files: Record<string, ForgeLensKeep> = {}
  for (const [path, keep] of Object.entries(result.files)) {
    if (byPath.has(path)) files[path] = keep
  }
  if (Buffer.byteLength(JSON.stringify(files)) > limits.maxResultBytes) {
    throw new LensFailed(`the lens result exceeds maxCachedLensBytes (${limits.maxResultBytes} bytes)`)
  }
  return files
}

/**
 * Turn one run into frames: the latest progress whenever the lens reported some since the last frame, then the result.
 * @param run - starts the run with the progress receiver.
 * @returns progress frames, then one result frame.
 * @throws the run's failure after its last progress frame.
 */
export async function* lensFrames(
  run: (progress: (done: number, total: number) => void) => Promise<LensFiles>,
): AsyncIterable<ForgeLensFrame> {
  // A box, so the reads below see what the progress callback writes.
  const reports: { latest: { readonly done: number; readonly total: number } | null; finished: boolean } = { latest: null, finished: false }
  // A function, so each check reads what the settlement wrote rather than the value the loop condition narrowed.
  const finished = (): boolean => reports.finished
  let wake = Promise.withResolvers<void>()
  const outcome = run((done, total) => {
    reports.latest = { done, total }
    wake.resolve()
  })
  const settled = outcome.then(() => { reports.finished = true }, () => { reports.finished = true })
  while (!finished()) {
    const current = wake
    await Promise.race([current.promise, settled])
    wake = Promise.withResolvers()
    const reported = reports.latest
    reports.latest = null
    if (reported !== null && !finished()) yield { kind: 'progress', done: reported.done, total: reported.total }
  }
  yield { kind: 'result', files: await outcome }
}

/** Lens results kept for later requests, at most `maxBytes` of them as JSON, the least recently used dropped first. */
export class LensCache {
  private readonly entries = new Map<string, { readonly files: LensFiles; readonly bytes: number }>()
  private bytes = 0

  /** @param maxBytes - `maxCachedLensBytes`. */
  constructor(private readonly maxBytes: number) {}

  /**
   * Read a kept result, which becomes the most recently used.
   * @param key - the request's files, lens, and lens version.
   * @returns the result, or undefined when none is kept.
   */
  get(key: string): LensFiles | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.files
  }

  /**
   * Keep a result no larger than `maxBytes`, replacing one under the same key and dropping the least recently used
   * results until the rest fit.
   * @param key - the request's files, lens, and lens version.
   * @param files - the result.
   */
  set(key: string, files: LensFiles): void {
    const previous = this.entries.get(key)
    if (previous !== undefined) {
      this.entries.delete(key)
      this.bytes -= previous.bytes
    }
    const bytes = Buffer.byteLength(JSON.stringify(files))
    this.entries.set(key, { files, bytes })
    this.bytes += bytes
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break
      this.entries.delete(oldest)
      this.bytes -= entry.bytes
    }
  }
}
