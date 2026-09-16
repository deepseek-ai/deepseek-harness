/** Exact-path watching for live profile patch files outside Cordis module roots. */
import { dirname, relative, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { watch, type ChokidarOptions } from 'chokidar'
import type { Context } from '@deepseek-ai/cordis'

const registrations = new WeakMap<Context, Set<string>>()

async function findWatchRoot(filename: string): Promise<{ filename: string; root: string; depth: number }> {
  let root = dirname(filename)
  let depth = 0
  while (true) {
    try {
      if (!(await stat(root)).isDirectory()) throw new Error(`config watch parent is not a directory: ${root}`)
      const canonicalRoot = await realpath(root)
      return { filename: resolve(canonicalRoot, relative(root, filename)), root: canonicalRoot, depth }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(root)
      if (parent === root) throw error
      root = parent
      depth += 1
    }
  }
}

/**
 * Watch one patch path, including missing parents, and serialize refresh callbacks.
 * @param ctx Context that owns watcher disposal and receives refresh failures.
 * @param filename Absolute patch-file path.
 * @param options Deployment watcher options; configuration watches enable write stabilization by default.
 * @param refresh Callback for additions, changes, and removals.
 * @param inTransaction Whether disposal is running inside the refresh being removed.
 * @returns A disposer that closes the watcher and drains its current refresh.
 * @throws When path resolution, watcher startup, or effect registration fails.
 */
export async function watchConfig(
  ctx: Context, filename: string, options: ChokidarOptions, refresh: () => Promise<void> | void,
  inTransaction: () => boolean = () => false,
): Promise<() => Promise<void>> {
  const target = await findWatchRoot(filename)
  const paths = registrations.get(ctx) ?? new Set<string>()
  registrations.set(ctx, paths)
  if (paths.has(target.filename)) throw new Error(`config path already registered: ${filename}`)
  const { cwd: _cwd, ignored: _ignored, ...watchOptions } = options
  const watcher = watch(target.root, {
    // Stabilized events bypass Chokidar's lossy 50 ms change-event throttle.
    awaitWriteFinish: true, ...watchOptions, depth: target.depth, ignoreInitial: false,
  })
  paths.add(target.filename)
  const state = { dirty: false }
  let running: Promise<void> | undefined
  const onChange = (path: string) => {
    const observed = resolve(path)
    if (observed !== filename && observed !== target.filename) return
    state.dirty = true
    if (running) return
    running = (async () => {
      while (state.dirty) {
        state.dirty = false
        try {
          await refresh()
        } catch (reason) {
          const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
          ctx.logger.warn('config reload at %C failed', filename)
          ctx.logger.warn(error)
        }
      }
    })().finally(() => { running = undefined })
  }
  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)
  const ready = Promise.withResolvers<void>()
  let pending = true
  watcher.once('ready', () => { pending = false; ready.resolve() })
  watcher.on('error', (error) => {
    if (pending) { pending = false; ready.reject(error) } else { ctx.logger.warn(error) }
  })
  const dispose = async () => {
    await watcher.close()
    paths.delete(target.filename)
    if (!inTransaction()) await running
  }
  try {
    await ready.promise
    return ctx.effect(() => dispose, 'hmr.watchConfig()')
  } catch (error) {
    await dispose()
    throw error
  }
}
