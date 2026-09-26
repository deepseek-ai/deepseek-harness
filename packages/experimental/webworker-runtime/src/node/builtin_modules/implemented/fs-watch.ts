/** Node filesystem watching over the active in-memory VFS. */
import { Buffer } from 'buffer'
import { EventEmitter } from './events.ts'
import { captureAsyncContext, runWithAsyncContext } from './async_hooks.ts'
import { basename, relative, resolve, sep } from './path.ts'
import { requireActiveVfs } from '../../../storage/active.ts'
import type { VfsBigIntStats, VfsMutation, VfsStats } from '../../../storage/types.ts'
import { abortError } from './abort-error.ts'

type PathArg = string | URL | Uint8Array
type WatchListener = (eventType: 'rename' | 'change', filename: string | Buffer | null) => void
type WatchStats = VfsStats | VfsBigIntStats
type StatListener = (current: WatchStats, previous: WatchStats) => void

/** Options shared by the callback and promise watch faces. */
export interface WatchOptions {
  persistent?: boolean
  recursive?: boolean
  encoding?: BufferEncoding | 'buffer'
  signal?: AbortSignal
}
/** Poll-style watch options. */
export interface WatchFileOptions {
  persistent?: boolean
  interval?: number
  bigint?: boolean
}

const asPath = (path: PathArg): string => {
  if (typeof path === 'string') return resolve(path)
  if (path instanceof URL) return resolve(decodeURIComponent(path.pathname))
  return resolve(new TextDecoder().decode(path))
}

const missingStats = (bigint: boolean): WatchStats => ({
  size: bigint ? 0n : 0,
  ino: bigint ? 0n : 0,
  mtimeMs: bigint ? 0n : 0,
  ctimeMs: bigint ? 0n : 0,
  atimeMs: bigint ? 0n : 0,
  birthtimeMs: bigint ? 0n : 0,
  mtime: new Date(0),
  mode: bigint ? 0n : 0,
  ...bigint ? {
    dev: 0n,
    nlink: 0n,
    mtimeNs: 0n,
    ctimeNs: 0n,
    atimeNs: 0n,
    birthtimeNs: 0n,
    ctime: new Date(0),
    atime: new Date(0),
    birthtime: new Date(0),
  } : {},
  isFile: () => false,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isFIFO: () => false,
  isSocket: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
}) as WatchStats

const statOrMissing = (path: string, bigint: boolean): WatchStats => {
  try {
    return requireActiveVfs().statSync(path, { bigint })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missingStats(bigint)
    throw error
  }
}

const statsChanged = (left: WatchStats, right: WatchStats): boolean =>
  left.size !== right.size
  || left.mtimeMs !== right.mtimeMs
  || left.mode !== right.mode
  || left.ino !== right.ino
  || left.isFile() !== right.isFile()
  || left.isDirectory() !== right.isDirectory()

const contains = (parent: string, child: string): boolean =>
  parent === '/' || child === parent || child.startsWith(`${parent}${sep}`)

const overlaps = (left: string, right: string): boolean => contains(left, right) || contains(right, left)

/** `fs.FSWatcher` over VFS mutations. */
export class FSWatcher extends EventEmitter {
  private readonly disposeMutation: () => void
  private readonly signal: AbortSignal | undefined
  private readonly onAbort: (() => void) | undefined
  private closed = false
  private referenced: boolean

  constructor(
    private readonly target: string,
    private readonly directory: boolean,
    private readonly options: WatchOptions,
    listener?: WatchListener,
  ) {
    super()
    this.referenced = options.persistent ?? true
    const context = captureAsyncContext()
    if (listener !== undefined) this.on('change', listener as (...args: unknown[]) => void)
    this.disposeMutation = requireActiveVfs().subscribe((mutation) => {
      if (!this.matches(mutation)) return
      const eventType = mutation.kind === 'write' && !mutation.entryChanged || mutation.kind === 'chmod'
        ? 'change'
        : 'rename'
      const filename = this.filename(mutation.path)
      queueMicrotask(() => {
        if (this.closed) return
        runWithAsyncContext(context, () => { this.emit('change', eventType, filename) })
      })
    })
    this.signal = options.signal
    this.onAbort = options.signal === undefined ? undefined : () => { this.close() }
    if (options.signal?.aborted === true) {
      this.close()
      return
    }
    options.signal?.addEventListener('abort', this.onAbort as () => void, { once: true })
  }

  private matches(mutation: VfsMutation): boolean {
    if (mutation.path === this.target) return true
    if (mutation.kind === 'remove' && contains(mutation.path, this.target)) return true
    if (!this.directory || !contains(this.target, mutation.path)) return false
    if (this.options.recursive === true) return true
    const child = relative(this.target, mutation.path)
    return child !== '' && !child.startsWith('..') && !child.includes(sep)
  }

  private filename(path: string): string | Buffer {
    const relativePath = relative(this.target, path)
    const value = this.directory && contains(this.target, path)
      ? this.options.recursive === true ? relativePath : relativePath.split(sep)[0] ?? ''
      : basename(this.target)
    return this.options.encoding === 'buffer' ? Buffer.from(value) : value
  }

  /** Stop observing and publish `close` once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.disposeMutation()
    if (this.onAbort !== undefined) this.signal?.removeEventListener('abort', this.onAbort)
    queueMicrotask(() => { this.emit('close') })
  }

  /**
   * Mark this watcher as process-liveness-bearing.
   * @returns This watcher.
   */
  ref(): this {
    this.referenced = true
    return this
  }

  /**
   * Clear the process-liveness flag; dedicated Workers have no ref-counted event loop.
   * @returns This watcher.
   */
  unref(): this {
    this.referenced = false
    return this
  }

  /**
   * Read the retained process-liveness flag.
   * @returns Whether this watcher is marked as keeping its owner alive.
   */
  hasRef(): boolean {
    return this.referenced
  }
}

/**
 * Watch one path through the active VFS.
 * @param path - File or directory path.
 * @param optionsOrListener - Watch options, encoding, or the change listener.
 * @param maybeListener - Change listener when the second argument carries options.
 * @returns The closeable watcher.
 */
export function watch(
  path: PathArg,
  optionsOrListener?: WatchOptions | BufferEncoding | 'buffer' | WatchListener,
  maybeListener?: WatchListener,
): FSWatcher {
  const options: WatchOptions = typeof optionsOrListener === 'object'
    ? optionsOrListener
    : typeof optionsOrListener === 'string' ? { encoding: optionsOrListener } : {}
  const listener = typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener
  const target = asPath(path)
  const stats = requireActiveVfs().statSync(target)
  return new FSWatcher(target, stats.isDirectory(), options, listener)
}

/** `fs.StatWatcher` returned from `watchFile`. */
export class StatWatcher extends EventEmitter {
  private readonly disposeMutation: () => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private previous: WatchStats
  private stopped = false
  private referenced: boolean
  private readonly context: ReturnType<typeof captureAsyncContext>
  private readonly interval: number
  private readonly bigint: boolean

  constructor(readonly path: string, options: WatchFileOptions) {
    super()
    this.referenced = options.persistent ?? true
    this.interval = options.interval ?? 5007
    this.bigint = options.bigint ?? false
    this.previous = statOrMissing(path, this.bigint)
    this.context = captureAsyncContext()
    this.disposeMutation = requireActiveVfs().subscribe((mutation) => {
      if (overlaps(path, mutation.path)) this.schedule()
    })
    if (!this.previous.isFile() && !this.previous.isDirectory()) this.schedule(true)
  }

  private schedule(initialMissing = false): void {
    if (this.stopped || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      const current = statOrMissing(this.path, this.bigint)
      const previous = this.previous
      this.previous = current
      if (initialMissing || statsChanged(current, previous)) {
        runWithAsyncContext(this.context, () => { this.emit('change', current, previous) })
      }
    }, this.interval)
    if (!this.referenced) timerUnref(this.timer)
  }

  /** Stop polling and release the VFS subscription. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.disposeMutation()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.emit('stop')
  }

  /** Alias used by callers treating the watcher as a closeable handle. */
  close(): void {
    this.stop()
  }

  /**
   * Mark this watcher as process-liveness-bearing.
   * @returns This watcher.
   */
  ref(): this {
    this.referenced = true
    if (this.timer !== undefined) timerRef(this.timer)
    return this
  }

  /**
   * Mark this watcher as not keeping its owner alive.
   * @returns This watcher.
   */
  unref(): this {
    this.referenced = false
    if (this.timer !== undefined) timerUnref(this.timer)
    return this
  }

  /**
   * Read the retained process-liveness flag.
   * @returns Whether this watcher is marked as keeping its owner alive.
   */
  hasRef(): boolean {
    return this.referenced
  }

}

type RefTimer = { ref?: () => unknown; unref?: () => unknown }

/** Browser timers are numeric; Node timers expose optional liveness methods. */
const timerRef = (timer: ReturnType<typeof setTimeout>): void => {
  ;(timer as RefTimer).ref?.()
}

/** Browser timers are numeric; Node timers expose optional liveness methods. */
const timerUnref = (timer: ReturnType<typeof setTimeout>): void => {
  ;(timer as RefTimer).unref?.()
}

const statWatchers = new Map<string, StatWatcher>()

/**
 * Register a stat-poll watcher for one path.
 * @param path - File or directory path, including a currently missing path.
 * @param optionsOrListener - Polling options or the change listener.
 * @param maybeListener - Change listener when the second argument carries options.
 * @returns The path's shared stat watcher.
 */
export function watchFile(
  path: PathArg,
  optionsOrListener: WatchFileOptions | StatListener,
  maybeListener?: StatListener,
): StatWatcher {
  const options = typeof optionsOrListener === 'function' ? {} : optionsOrListener
  const listener = typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener
  if (listener === undefined) throw new TypeError('The "listener" argument must be of type function')
  const target = asPath(path)
  let watcher = statWatchers.get(target)
  if (watcher === undefined) {
    watcher = new StatWatcher(target, options)
    statWatchers.set(target, watcher)
    watcher.once('stop', () => { statWatchers.delete(target) })
  }
  watcher.on('change', listener as (...args: unknown[]) => void)
  return watcher
}

/**
 * Remove one listener or every listener for a path.
 * @param path - Watched path.
 * @param listener - Specific registration to remove; omission removes all registrations.
 */
export function unwatchFile(path: PathArg, listener?: StatListener): void {
  const target = asPath(path)
  const watcher = statWatchers.get(target)
  if (watcher === undefined) return
  if (listener === undefined) watcher.removeAllListeners('change')
  else watcher.removeListener('change', listener as (...args: unknown[]) => void)
  if (watcher.listenerCount('change') === 0) watcher.stop()
}

/**
 * Create the promise-based watch iterator over the callback watcher.
 * @param path - File or directory path.
 * @param options - Watch options and cancellation signal.
 * @returns An iterator of change records that closes its watcher on return or failure.
 */
export function watchAsync(
  path: PathArg,
  options: WatchOptions = {},
): AsyncIterableIterator<{ eventType: 'rename' | 'change'; filename: string | Buffer | null }> {
  type WatchEvent = { eventType: 'rename' | 'change'; filename: string | Buffer | null }
  type Waiting = {
    resolve(result: IteratorResult<WatchEvent>): void
    reject(reason: unknown): void
  }
  const queued: WatchEvent[] = []
  const waiting: Waiting[] = []
  let watcher: FSWatcher | undefined
  let failure: Error | undefined
  let closed = false

  const stopWatcher = (): void => {
    options.signal?.removeEventListener('abort', onAbort)
    watcher?.close()
  }
  const settleFailure = (reason: unknown): void => {
    if (closed) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    closed = true
    queued.length = 0
    stopWatcher()
    const failed = waiting.shift()
    if (failed === undefined) failure = error
    else failed.reject(error)
    for (const pending of waiting.splice(0)) pending.resolve({ done: true, value: undefined })
  }
  const onAbort = (): void => { settleFailure(abortError(options.signal?.reason)) }
  const start = (): void => {
    if (watcher !== undefined || closed || failure !== undefined) return
    if (options.signal?.aborted === true) {
      settleFailure(abortError(options.signal.reason))
      return
    }
    try {
      watcher = watch(path, options, (eventType, filename) => {
        const event = { eventType, filename }
        const pending = waiting.shift()
        if (pending === undefined) queued.push(event)
        else pending.resolve({ done: false, value: event })
      })
      watcher.on('error', settleFailure)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    } catch (error) {
      settleFailure(error)
    }
  }
  const close = (): void => {
    const alreadyClosed = closed
    closed = true
    queued.length = 0
    failure = undefined
    if (!alreadyClosed) stopWatcher()
    for (const pending of waiting.splice(0)) pending.resolve({ done: true, value: undefined })
  }

  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<WatchEvent>> {
      start()
      if (failure !== undefined) {
        const reason = failure
        failure = undefined
        return Promise.reject(reason)
      }
      const event = queued.shift()
      if (event !== undefined) return Promise.resolve({ done: false, value: event })
      if (closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise<IteratorResult<WatchEvent>>((resolve, reject) => { waiting.push({ resolve, reject }) })
    },
    return(): Promise<IteratorResult<WatchEvent>> {
      close()
      return Promise.resolve({ done: true, value: undefined })
    },
    throw(reason?: unknown): Promise<IteratorResult<WatchEvent>> {
      close()
      // AsyncIterator.throw forwards the caller's exact reason, including non-Error values.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      return Promise.reject(reason)
    },
  }
}
