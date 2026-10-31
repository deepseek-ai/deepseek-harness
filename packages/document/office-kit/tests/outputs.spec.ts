/** The output store keeps bounded, owner-scoped files and deletes only what it saved, apart from expired leftovers. */
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { OutputStore, type OutputStoreOptions } from '../src/outputs.ts'

const io = vi.hoisted(() => ({
  rmFailure: undefined as Error | undefined, statFailure: undefined as Error | undefined, writeFailures: [] as Error[],
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rm(...args: Parameters<typeof actual.rm>) {
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

it('sweeps expired leftovers of earlier processes and keeps fresh ones', async () => {
  const leftover = join(root, 'outputs', 'session-old', 'expired')
  const fresh = join(root, 'outputs', 'session-old', 'fresh')
  await mkdir(leftover, { recursive: true })
  await mkdir(fresh, { recursive: true })
  await writeFile(join(root, 'outputs', 'stray-file'), '')
  const past = new Date(Date.now() - 120_000)
  await utimes(leftover, past, past)
  const { outputs } = store()
  await outputs.save('a', 'a.pdf', Uint8Array.of(1))
  expect(await exists(leftover)).toBe(false)
  expect(await exists(fresh)).toBe(true)
})

it('reports cleanup failures without failing saves or disposal', async () => {
  await mkdir(join(root, 'outputs', 'session-old', 'entry'), { recursive: true })
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
