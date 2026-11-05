/** The output store keeps bounded, owner-scoped files and deletes only what it saved, apart from expired leftovers. */
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { OutputStore, type OutputStoreOptions } from '../src/outputs.ts'

const io = vi.hoisted(() => ({
  rmFailure: undefined as Error | undefined, statFailure: undefined as Error | undefined, writeFailures: [] as Error[],
  rmGate: undefined as Promise<void> | undefined, rmBlocked: 0,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rm(...args: Parameters<typeof actual.rm>) {
      const gate = io.rmGate
      if (gate !== undefined) { io.rmBlocked++; await gate }
      if (io.rmFailure !== undefined) throw io.rmFailure
      return actual.rm(...args)
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      const failure = io.writeFailures.shift()
      if (failure !== undefined) throw failure
      return actual.writeFile(...args)
    },
    async stat(...args: Parameters<typeof actual.stat>) {
      if (io.statFailure !== undefined) throw io.statFailure
      return actual.stat(...args)
    },
    async lstat(...args: Parameters<typeof actual.lstat>) {
      if (io.statFailure !== undefined) throw io.statFailure
      return actual.lstat(...args)
    },
  }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-office-outputs-'))
})
afterEach(async () => {
  io.rmFailure = undefined
  io.statFailure = undefined
  io.writeFailures = []
  io.rmGate = undefined
  io.rmBlocked = 0
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

function store(options: Partial<OutputStoreOptions> = {}) {
  const warn = vi.fn<(message: string) => void>()
  const outputs = new OutputStore({ root: join(root, 'outputs'), retentionMs: 60_000, maxBytes: 8, ...options }, warn)
  onTestFinished(() => outputs.dispose())
  return { outputs, warn }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

it('saves owner-only files under a per-owner directory with the requested name', async () => {
  const { outputs } = store()
  const path = await outputs.save('session/a', '../report.pdf', Uint8Array.of(1, 2))
  expect(path.endsWith('report.pdf')).toBe(true)
  expect(dirname(dirname(dirname(path)))).toBe(join(root, 'outputs'))
  expect(await readFile(path)).toEqual(Buffer.from([1, 2]))
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
  }
})

it('deletes the oldest files to stay within the byte budget and refuses a file above it', async () => {
  const { outputs } = store()
  const first = await outputs.save('a', 'one.pdf', new Uint8Array(4))
  const second = await outputs.save('a', 'two.pdf', new Uint8Array(4))
  const third = await outputs.save('b', 'three.pdf', new Uint8Array(4))
  expect(await exists(first)).toBe(false)
  expect(await exists(second)).toBe(true)
  expect(await exists(third)).toBe(true)
  await expect(outputs.save('a', 'big.pdf', new Uint8Array(9))).rejects.toMatchObject({ code: 'output-too-large' })
  expect(await outputs.save('a', 'exact.pdf', new Uint8Array(8))).toMatch(/exact\.pdf$/u)
})

it('deletes a file when its retention expires', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { outputs } = store({ retentionMs: 1000 })
  const path = await outputs.save('a', 'one.pdf', Uint8Array.of(1))
  await vi.advanceTimersByTimeAsync(1000)
  vi.useRealTimers()
  await vi.waitFor(async () => { expect(await exists(path)).toBe(false) })
})

it('releases one owner and disposes the rest, refusing later saves', async () => {
  const { outputs } = store()
  const a = await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  const b = await outputs.save('b', 'b.pdf', Uint8Array.of(1))
  await Promise.all([outputs.release('a'), outputs.release('a')])
  expect(await exists(a)).toBe(false)
  expect(await exists(dirname(dirname(a)))).toBe(false)
  expect(await exists(b)).toBe(true)
  await outputs.release('missing')
  await outputs.dispose()
  expect(await exists(b)).toBe(false)
  await expect(outputs.save('a', 'late.pdf', Uint8Array.of(1))).rejects.toMatchObject({ code: 'unavailable' })
})

it('removes the private directory of a failed write and continues later saves', async () => {
  const { outputs } = store()
  await expect(outputs.save('a', '', Uint8Array.of(1))).rejects.toThrow()
  const owner = join(root, 'outputs', (await readdir(join(root, 'outputs')))[0]!)
  expect(await readdir(owner)).toEqual([])
  expect(await outputs.save('a', 'ok.pdf', Uint8Array.of(1))).toMatch(/ok\.pdf$/u)
})

const OWNER = `session-${'0'.repeat(24)}`
const OUTPUT = '00000000-0000-4000-8000-000000000000'
const FRESH_OUTPUT = '00000000-0000-4000-8000-000000000001'
const past = new Date(Date.now() - 120_000)

/** Create a directory whose modification time precedes the 60-second test retention. */
async function expiredDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'file.pdf'), 'kept')
  await utimes(path, past, past)
  return path
}

/** Link `path` to the directory `target`; Windows uses a junction, which needs no symlink privilege. */
async function linkDirectory(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

it('sweeps expired leftovers of earlier processes and keeps fresh ones', async () => {
  const leftover = await expiredDirectory(join(root, 'outputs', OWNER, OUTPUT))
  const fresh = join(root, 'outputs', OWNER, FRESH_OUTPUT)
  await mkdir(fresh, { recursive: true })
  await writeFile(join(root, 'outputs', 'stray-file'), '')
  const { outputs } = store()
  await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  expect(await exists(leftover)).toBe(false)
  expect(await exists(fresh)).toBe(true)
})

it('removes an expired owner directory left empty by the sweep', async () => {
  await expiredDirectory(join(root, 'outputs', OWNER, OUTPUT))
  const { outputs } = store()
  await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  expect(await exists(join(root, 'outputs', OWNER))).toBe(false)
})

it('does not follow an owner-position link out of the store root', async () => {
  const external = await expiredDirectory(join(root, 'external', OUTPUT))
  const link = join(root, 'outputs', OWNER)
  await linkDirectory(join(root, 'external'), link)
  const { outputs } = store()
  await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  expect(await readFile(join(external, 'file.pdf'), 'utf8')).toBe('kept')
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
})

it('does not follow or delete an output-position link', async () => {
  const external = await expiredDirectory(join(root, 'external'))
  const link = join(root, 'outputs', OWNER, OUTPUT)
  await linkDirectory(external, link)
  await utimes(dirname(link), past, past)
  const { outputs } = store()
  await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  expect(await readFile(join(external, 'file.pdf'), 'utf8')).toBe('kept')
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
})

it('leaves expired directories whose names the store does not generate', async () => {
  const unrelated = [
    await expiredDirectory(join(root, 'outputs', 'sessions', 'project', 'session')),
    await expiredDirectory(join(root, 'outputs', `session-${'0'.repeat(23)}`, OUTPUT)),
    await expiredDirectory(join(root, 'outputs', `session-${'A'.repeat(24)}`, OUTPUT)),
    await expiredDirectory(join(root, 'outputs', OWNER, 'not-an-output')),
    await expiredDirectory(join(root, 'outputs', OWNER, 'ABCDEF00-0000-4000-A000-000000000000')),
  ]
  const { outputs } = store()
  await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  for (const directory of unrelated) expect(await readFile(join(directory, 'file.pdf'), 'utf8')).toBe('kept')
})

it('reports cleanup failures without failing saves or disposal', async () => {
  await mkdir(join(root, 'outputs', OWNER, OUTPUT), { recursive: true })
  io.statFailure = new Error('stat failed')
  const { outputs, warn } = store()
  const path = await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  io.statFailure = undefined
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not sweep output'))
  io.rmFailure = new Error('rm failed')
  await outputs.release('a')
  io.rmFailure = undefined
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not delete output ${path}`))
})

function busy(): Error {
  return Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
}

/** Bytes of every regular file under `directory`. */
async function storedBytes(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size
  }
  return total
}

it('keeps a file whose deletion failed in the byte budget and retries it on eviction and disposal', async () => {
  const { outputs, warn } = store()
  const first = await outputs.save('a', 'one.pdf', new Uint8Array(4))
  await outputs.save('a', 'two.pdf', new Uint8Array(4))
  io.rmFailure = busy()
  await expect(outputs.save('b', 'three.pdf', new Uint8Array(4))).rejects.toMatchObject({ code: 'unavailable' })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not delete output ${first}`))
  expect(await storedBytes(join(root, 'outputs'))).toBeLessThanOrEqual(8)
  io.rmFailure = undefined
  const third = await outputs.save('b', 'three.pdf', new Uint8Array(4))
  expect(await exists(first)).toBe(false)
  expect(await storedBytes(join(root, 'outputs'))).toBe(8)
  io.rmFailure = busy()
  await outputs.release('b')
  expect(await exists(third)).toBe(true)
  io.rmFailure = undefined
  await outputs.dispose()
  expect(await exists(third)).toBe(false)
  expect(await storedBytes(join(root, 'outputs'))).toBe(0)
})

it('waits for a release in progress before disposal completes', async () => {
  const { outputs } = store()
  const path = await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  const gate = Promise.withResolvers<undefined>()
  io.rmGate = gate.promise
  const releasing = outputs.release('a')
  let disposed = false
  const disposing = outputs.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  io.rmGate = undefined
  gate.resolve(undefined)
  await disposing
  expect(await exists(path)).toBe(false)
  await releasing
})

it('counts a file deleted by a concurrent release once while eviction continues', async () => {
  const { outputs } = store()
  await outputs.save('x', 'x.pdf', new Uint8Array(2))
  await outputs.save('y', 'y.pdf', new Uint8Array(3))
  await outputs.save('z', 'z.pdf', new Uint8Array(3))
  const gate = Promise.withResolvers<undefined>()
  io.rmGate = gate.promise
  const saving = outputs.save('w', 'w.pdf', new Uint8Array(8))
  await vi.waitFor(() => { expect(io.rmBlocked).toBe(1) })
  io.rmGate = undefined
  await outputs.release('y')
  gate.resolve(undefined)
  await saving
  await outputs.save('v', 'v.pdf', new Uint8Array(3))
  expect(await storedBytes(join(root, 'outputs'))).toBe(3)
})

it('reports a deletion that still fails during disposal', async () => {
  const { outputs, warn } = store()
  const path = await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  io.rmFailure = busy()
  await outputs.dispose()
  io.rmFailure = undefined
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not delete output ${path}`))
  expect(await exists(path)).toBe(true)
})

function missing(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}

it('recreates a directory removed by concurrent cleanup and retries the write once', async () => {
  const { outputs } = store()
  io.writeFailures = [missing()]
  const path = await outputs.save('a', 'a.pdf', Uint8Array.of(7))
  expect(await readFile(path)).toEqual(Buffer.from([7]))
  expect(io.writeFailures).toEqual([])
})

it('fails a save whose retried write is also missing its directory, leaving no directory behind', async () => {
  const { outputs } = store()
  io.writeFailures = [missing(), missing()]
  await expect(outputs.save('a', 'a.pdf', Uint8Array.of(7))).rejects.toMatchObject({ code: 'ENOENT' })
  const owner = join(root, 'outputs', (await readdir(join(root, 'outputs')))[0]!)
  expect(await readdir(owner)).toEqual([])
  expect(await outputs.save('a', 'b.pdf', Uint8Array.of(1))).toMatch(/b\.pdf$/u)
})
