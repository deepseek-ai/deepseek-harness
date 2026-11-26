import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryWatch } from '../src/watch.ts'

/**
 * Watchers created through `node:fs`. Specs that assert which watchers are kept get watchers that report only the events
 * a spec emits, because macOS can report a watched directory's own creation to a watcher started just after it.
 */
const watchers = vi.hoisted(() => ({
  created: [] as import('node:events').EventEmitter[], closes: [] as { mock: { calls: unknown[][] } }[],
  refusal: undefined as Error | undefined, real: false,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: (path: string, options: { persistent: boolean }, listener: (event: string, filename: string | null) => void) => {
      if (watchers.refusal !== undefined) throw watchers.refusal
      const watcher = watchers.real
        ? actual.watch(path, options, listener)
        : Object.assign(new EventEmitter().on('change', listener), { close: () => {} })
      watchers.closes.push(vi.spyOn(watcher, 'close'))
      watchers.created.push(watcher)
      return watcher
    },
  }
})

let root: string | undefined
let watch: DirectoryWatch | undefined
afterEach(async () => {
  watch?.close()
  watch = undefined
  watchers.created.length = 0
  watchers.closes.length = 0
  watchers.refusal = undefined
  watchers.real = false
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write `file` until `reported` settles; a watcher that macOS has just started can miss the first change. */
async function change(file: string, reported: Promise<unknown>): Promise<void> {
  let settled = false
  const result = reported.finally(() => { settled = true })
  while (!settled) {
    await writeFile(file, 'Host a\n')
    await Promise.race([result, sleep(100)])
  }
  await result
}

/** A watch whose change and failure reports are recorded; `next()` resolves at the first change report after the call. */
async function setup(): Promise<{ watch: DirectoryWatch; failures: [string, unknown][]; next: () => Promise<undefined> }> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-watch-')))
  const failures: [string, unknown][] = []
  let report = Promise.withResolvers<undefined>()
  watch = new DirectoryWatch(() => {
    report.resolve(undefined)
  }, (directory, error) => { failures.push([directory, error]) })
  return {
    watch, failures,
    next: () => {
      report = Promise.withResolvers<undefined>()
      return report.promise
    },
  }
}

describe('directory watching', () => {
  it('reports changes of the entries in a watched directory', async () => {
    watchers.real = true
    const { watch, failures, next } = await setup()
    expect(await watch.update(new Set([root!]))).toBe(true)
    await change(join(root!, 'config'), next())
    expect(failures).toEqual([])
  })

  it('keeps the watchers of unchanged directories after entry changes and closes the others', async () => {
    const { watch, next } = await setup()
    const other = join(root!, 'other')
    await mkdir(other)
    expect(await watch.update(new Set([root!, other]))).toBe(true)
    expect(await watch.update(new Set([root!, other]))).toBe(false)
    const reported = next()
    watchers.created[0]!.emit('change', 'rename', 'config')
    await reported
    expect(await watch.update(new Set([root!]))).toBe(true)
    expect(watchers.closes.map(close => close.mock.calls.length)).toEqual([0, 1])
    watch.close()
    expect(watchers.closes.map(close => close.mock.calls.length)).toEqual([1, 1])
  })

  it('replaces a watcher that reports its own directory or no entry, also when the identity is unchanged', async () => {
    const { watch, next } = await setup()
    const directory = join(root!, 'config.d')
    await mkdir(directory)
    await watch.update(new Set([directory]))
    // Linux reports the removal of a watched directory, after which its watch ends, under the directory's own name.
    for (const filename of ['config.d', null]) {
      const reported = next()
      watchers.created.at(-1)!.emit('change', 'rename', filename)
      await reported
      expect(await watch.update(new Set([directory]))).toBe(true)
      expect(watchers.closes.at(-2)!.mock.calls).toHaveLength(1)
    }
    const reported = next()
    watchers.created.at(-1)!.emit('change', 'rename', 'hosts.conf')
    await reported
    expect(await watch.update(new Set([directory]))).toBe(false)
    expect(watchers.created).toHaveLength(3)
  })

  it('watches a retargeted symbolic link again', async () => {
    const { watch } = await setup()
    const link = join(root!, 'config.d')
    await mkdir(join(root!, 'first'))
    await mkdir(join(root!, 'second'))
    await symlink(join(root!, 'first'), link)
    await watch.update(new Set([link]))
    await rm(link)
    await symlink(join(root!, 'second'), link)
    expect(await watch.update(new Set([link]))).toBe(true)
    expect(watchers.closes[0]!.mock.calls).toHaveLength(1)
  })

  it('watches a directory removed and recreated at the same path again', async () => {
    watchers.real = true
    const { watch, next } = await setup()
    const replaced = join(root!, 'config.d')
    await mkdir(replaced)
    await watch.update(new Set([replaced]))
    const [removed] = watchers.created
    await rm(replaced, { recursive: true })
    await mkdir(replaced)
    // Discovery updates the watchers after reports. The recreated directory can have a new identity at once, or keep
    // its inode number while the old watch reports the removal shortly afterwards, as on Linux.
    while (watchers.created.at(-1) === removed) {
      await watch.update(new Set([replaced]))
      await sleep(10)
    }
    expect(watchers.closes[0]!.mock.calls).toHaveLength(1)
    await change(join(replaced, 'hosts.conf'), next())
  })

  it('reports directories it cannot inspect or watch and retries them at the next update', async () => {
    const { watch, failures } = await setup()
    const missing = join(root!, 'missing')
    expect(await watch.update(new Set([missing]))).toBe(false)
    watchers.refusal = Object.assign(new Error('System limit for number of file watchers reached'), { code: 'ENOSPC' })
    expect(await watch.update(new Set([root!]))).toBe(false)
    watchers.refusal = undefined
    expect(await watch.update(new Set([root!]))).toBe(true)
    expect(failures).toEqual([
      [missing, expect.objectContaining({ code: 'ENOENT' })],
      [root, expect.objectContaining({ code: 'ENOSPC' })],
    ])
  })

  it('replaces a failed watcher, reports it and asks for a new discovery', async () => {
    const { watch, failures, next } = await setup()
    await watch.update(new Set([root!]))
    const failure = new Error('watcher failed')
    const reported = next()
    watchers.created[0]!.emit('error', failure)
    await reported
    expect(failures).toEqual([[root, failure]])
    expect(await watch.update(new Set([root!]))).toBe(true)
    expect(watchers.created).toHaveLength(2)
  })
})
