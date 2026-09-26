/** Upstream Chokidar running unchanged through the shipped Worker module loader. */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { setActiveVfs } from '../../src/storage/active.ts'

const ROOT = '/dsh/workspace/skills'
let vfs: MemoryVfs
let chokidar: typeof import('chokidar')
const openWatchers: import('chokidar').FSWatcher[] = []

interface ChokidarFixture {
  readonly label: string
  readonly consumerManifest: string
  readonly chokidarFiles: readonly string[]
  readonly readdirpFiles: readonly string[]
}

const CHOKIDAR_FIXTURES: readonly ChokidarFixture[] = [
  {
    label: 'Chokidar 4 from credentials',
    consumerManifest: 'packages/credentials/credentials-local/package.json',
    chokidarFiles: ['package.json', 'esm/package.json', 'esm/index.js', 'esm/handler.js'],
    readdirpFiles: ['package.json', 'esm/package.json', 'esm/index.js'],
  },
  {
    label: 'Chokidar 5 from skill-filesystem',
    consumerManifest: 'packages/skill/skill-filesystem/package.json',
    chokidarFiles: ['package.json', 'index.js', 'handler.js'],
    readdirpFiles: ['package.json', 'index.js'],
  },
]

/** Copy one installed JavaScript package into the VFS exactly as the packer does. */
function packageRoot(name: string, entry: string): string {
  for (let directory = dirname(entry);;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (parsed.name === name) return directory
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`cannot locate package root for ${name}`)
    directory = parent
  }
}

/** Copy the package files selected by the packer's import condition. */
function mountPackage(name: string, directory: string, files: readonly string[]): void {
  for (const file of files) {
    const source = readFileSync(join(directory, file), 'utf8')
    const path = `/dsh/node_modules/${name}/${file}`
    vfs.seed(path, file.endsWith('.js') ? lowerModuleSource({ filename: path, source }).code : source)
  }
}

/** Load one consumer's exact Chokidar and readdirp versions through the Worker loader. */
function loadChokidar(fixture: ChokidarFixture): typeof import('chokidar') {
  const consumerManifest = join(process.cwd(), fixture.consumerManifest)
  const chokidarEntry = createRequire(consumerManifest).resolve('chokidar')
  const readdirpEntry = createRequire(chokidarEntry).resolve('readdirp')
  mountPackage('chokidar', packageRoot('chokidar', chokidarEntry), fixture.chokidarFiles)
  mountPackage('readdirp', packageRoot('readdirp', readdirpEntry), fixture.readdirpFiles)
  const loader = new WorkerModuleLoader({ vfs, staticModules: createNodeBuiltins() })
  return loader.createRequire('/dsh/')('chokidar') as typeof import('chokidar')
}

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(ROOT, { recursive: true })
})

afterEach(async () => {
  await Promise.all(openWatchers.splice(0).map(async (watcher) => { await watcher.close() }))
})

/** Await one emitter event while rejecting hangs deterministically. */
function onceEvent<T>(watcher: import('chokidar').FSWatcher, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error(`timed out waiting for chokidar ${event}`)) }, 2_000)
    const emitter = watcher as {
      once(name: string, listener: (...args: unknown[]) => void): void
    }
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timeout)
      resolve(args[0] as T)
    })
  })
}

/** Let watcher timers and promise-based stats reach a stable point. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Construct one tracked watcher with deterministic event normalization. */
function watchPath(path: string, options: import('chokidar').ChokidarOptions = {}): import('chokidar').FSWatcher {
  const watcher = chokidar.watch(path, {
    ignoreInitial: true,
    atomic: false,
    awaitWriteFinish: false,
    ...options,
  })
  openWatchers.push(watcher)
  return watcher
}

describe.each(CHOKIDAR_FIXTURES)('$label running unchanged', (fixture) => {
  beforeEach(() => {
    chokidar = loadChokidar(fixture)
  })

  it('reaches ready and reports a file lifecycle through fs.watch', async () => {
    const watcher = watchPath(ROOT, { depth: 1 })
    await onceEvent(watcher, 'ready')

    const directory = `${ROOT}/sample`
    const file = `${directory}/SKILL.md`
    const addDirectory = onceEvent<string>(watcher, 'addDir')
    const addFile = onceEvent<string>(watcher, 'add')
    vfs.mkdirSync(directory)
    vfs.writeFileSync(file, '# sample\n')
    await expect(addDirectory).resolves.toBe(directory)
    await expect(addFile).resolves.toBe(file)

    const changed = onceEvent<string>(watcher, 'change')
    vfs.writeFileSync(file, '# changed\n')
    await expect(changed).resolves.toBe(file)

    await new Promise((resolve) => { setTimeout(resolve, 10) })
    const removed = onceEvent<string>(watcher, 'unlink')
    vfs.rmSync(file)
    await expect(removed).resolves.toBe(file)
  })

  it('watches a missing file through its existing parent', async () => {
    const path = '/dsh/home/settings.yaml'
    vfs.mkdirSync('/dsh/home', { recursive: true })
    const watcher = watchPath(path)
    await onceEvent(watcher, 'ready')

    const added = onceEvent<string>(watcher, 'add')
    vfs.writeFileSync(path, 'theme: dark\n')
    await expect(added).resolves.toBe(path)

    const removed = onceEvent<string>(watcher, 'unlink')
    vfs.rmSync(path)
    await expect(removed).resolves.toBe(path)
  })

  it('discovers directory children through watchFile polling mode', async () => {
    const watcher = watchPath(ROOT, { usePolling: true, interval: 5 })
    await onceEvent(watcher, 'ready')
    const path = `${ROOT}/standalone.md`
    const added = onceEvent<string>(watcher, 'add')
    vfs.writeFileSync(path, '# standalone\n')
    await expect(added).resolves.toBe(path)
  })

  it('normalizes a short unlink/add replacement into one atomic change', async () => {
    const path = `${ROOT}/atomic.md`
    vfs.writeFileSync(path, 'before')
    const watcher = watchPath(path, { atomic: 40 })
    await onceEvent(watcher, 'ready')
    const events: string[] = []
    watcher.on('all', (event) => { events.push(event) })
    const changed = onceEvent<string>(watcher, 'change')
    vfs.rmSync(path)
    await delay(5)
    vfs.writeFileSync(path, 'after')
    await expect(changed).resolves.toBe(path)
    await delay(60)
    expect(events).toEqual(['change'])
  })

  it('waits for a write burst to stabilize before publishing one add', async () => {
    const path = `${ROOT}/settling.md`
    const watcher = watchPath(ROOT, {
      awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 5 },
    })
    await onceEvent(watcher, 'ready')
    const events: string[] = []
    watcher.on('all', (event) => { events.push(event) })
    const added = onceEvent<string>(watcher, 'add')
    vfs.writeFileSync(path, 'a')
    await delay(10)
    vfs.appendFileSync(path, 'b')
    await delay(10)
    vfs.appendFileSync(path, 'c')
    await expect(added).resolves.toBe(path)
    expect(events).toEqual(['add'])
  })

  it('emits nothing after close has reached quiescence', async () => {
    const watcher = watchPath(ROOT)
    const events: string[] = []
    watcher.on('all', (event) => { events.push(event) })
    await onceEvent(watcher, 'ready')
    await watcher.close()
    vfs.writeFileSync(`${ROOT}/after.md`, '# after\n')
    await Promise.resolve()
    expect(events).toEqual([])
  })
})
