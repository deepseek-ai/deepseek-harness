/** Routing publication errors and platform-specific durable publication. @module */
import { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

const faults = vi.hoisted(() => ({ op: '', error: undefined as Error | undefined, race: false, skip: 0,
  directory: '', directorySyncs: 0, directoryCloses: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (faults.op === 'readFile') return Promise.reject(faults.error ?? new Error('Injected filesystem failure'))
      return actual.readFile(...args)
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      if (faults.op === 'readdir') return Promise.reject(faults.error ?? new Error('Injected filesystem failure'))
      return actual.readdir(...args)
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (faults.op === 'stat' && faults.skip-- <= 0) return Promise.reject(faults.error ?? new Error('Injected filesystem failure'))
      return actual.stat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.op === 'open') throw faults.error ?? new Error('Injected filesystem failure')
      if (String(args[0]) === faults.directory) {
        // Windows cannot open a directory through fs.open; this stand-in isolates the POSIX publication protocol.
        const handle = await actual.open(`${faults.directory}.sync`, 'w')
        const sync = handle.sync.bind(handle), close = handle.close.bind(handle)
        handle.sync = async () => { faults.directorySyncs++; await sync() }
        handle.close = async () => { faults.directoryCloses++; await close() }
        return handle
      }
      return actual.open(...args)
    },
    link: async (source: string, target: string) => {
      if (faults.op === 'link') {
        if (faults.race) await actual.link(source, target)
        throw faults.error
      }
      await actual.link(source, target)
    },
  }
})
vi.mock('../src/win32.ts', async (importOriginal) => {
  const windows = await importOriginal<typeof import('../src/win32.ts')>()
  const actual = await import('node:fs/promises')
  return { ...windows, ensureDurableDirectoryWin32: (path: string) => actual.mkdir(path, { recursive: true }),
    publishNewFileWin32: (source: string, target: string) => actual.link(source, target) }
})

class Adapter extends SqliteSessionPersistence {
  constructor(ctx: Context, root: string) {
    super(ctx, ctx, { root }, {
      async prepare() { throw new Error('legacy preparation') },
      async stat() { return undefined },
      async list() { return [] },
      async hasStoredJsonl() { return false },
    })
  }
  publishRoute(id: SessionId) { return this.publish(id) }
}
afterEach(() => {
  faults.op = ''; faults.error = undefined; faults.race = false; faults.skip = 0
  faults.directory = ''; faults.directorySyncs = 0; faults.directoryCloses = 0
  vi.restoreAllMocks()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-segment-routing-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  const storage = new Adapter(ctx, root)
  return { root, ctx, storage }
}
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('selected'), createdAt: 0, isSeeded: false }

it('uses the resolved defaults for SQLite creation', async () => {
  const { storage } = await fixture()
  const writer = await storage.create(header)
  await writer.flush(); await writer.close()
  await storage.flush()
})

it('validates routing read failures rather than treating them as absence', async () => {
  const { storage } = await fixture()
  faults.op = 'readFile'; faults.error = Object.assign(new Error('routing denied'), { code: 'EACCES' })
  await expect(storage.stat(header.id)).rejects.toThrow('routing denied')
  faults.op = ''
})

it('rejects an unreadable routing directory and preserves explicit absence', async () => {
  const { storage } = await fixture()
  faults.op = 'readdir'; faults.error = Object.assign(new Error('directory denied'), { code: 'EACCES' })
  await expect(storage.list()).rejects.toThrow('directory denied')
  faults.op = ''
  expect(await storage.list()).toEqual([])

})

it('propagates routing directory read failures during create', async () => {
  const { storage } = await fixture()
  faults.op = 'readdir'
  faults.error = Object.assign(new Error('routing directory denied'), { code: 'EACCES' })
  await expect(storage.create(header)).rejects.toThrow('routing directory denied')
})

it.each(['linux', 'win32'])('publishes routing using the %s durable namespace', async (platform) => {
  const { root, storage } = await fixture()
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw new Error('Missing platform descriptor')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    faults.directory = join(root, '.segments')
    await storage.publishRoute(header.id)
    await storage.publishRoute(header.id)
    expect(faults.directorySyncs).toBe(platform === 'linux' ? 1 : 0)
    expect(faults.directoryCloses).toBe(faults.directorySyncs)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

it.each(['identity', 'parse', 'race', 'link-failure'] as const)('retains routing publication failure for %s', async (fault) => {
  const { root, storage: initial } = await fixture()
  const writer = await initial.create(header); await writer.flush(); await writer.close()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const storage = new Adapter(ctx, root)
  const { readdir, readFile } = await import('node:fs/promises')
  const directory = join(root, '.segments')
  const name = (await readdir(directory)).find(name => name.endsWith('.json'))
  if (name === undefined) throw new Error('Missing route')
  const path = join(directory, name), original = await readFile(path)
  if (fault === 'identity' || fault === 'parse') {
    await writeFile(path, fault === 'parse' ? 'invalid' : JSON.stringify({ id: 'wrong', database: '/wrong' }))
    await expect(storage.publishRoute(header.id)).rejects.toThrow()
    await writeFile(path, original)
  } else {
    await rm(path)
    faults.op = 'link'; faults.error = Object.assign(new Error('link failure'), { code: fault === 'race' ? 'EEXIST' : 'EACCES' })
    faults.race = fault === 'race'
    if (fault === 'race') await storage.publishRoute(header.id)
    else await expect(storage.publishRoute(header.id)).rejects.toThrow('link failure')
    faults.op = ''
  }
  await storage.publishRoute(header.id)
})


it.each(['open', 'stat', 'readdir', 'exists'] as const)('refuses database initialization after a %s failure', async (op) => {
  const { root } = await fixture()
  const path = join(root, 'events.sqlite')
  const { sqliteLogs } = await import('./fixtures/store.ts')
  const logs = sqliteLogs(path, root)
  if (op !== 'readdir') await writeFile(path, '')
  faults.op = op === 'exists' ? 'stat' : op; faults.skip = op === 'stat' ? 1 : 0
  faults.error = Object.assign(new Error('database admission denied'), { code: 'EACCES' })
  try { await expect(logs.create(header)).rejects.toThrow('database admission denied') }
  finally {
    faults.op = ''
    await expect(logs.close()).resolves.toBeUndefined()
  }
})

it('refuses orphan routing records before admitting new Sessions', async () => {
  const { storage, root } = await fixture()
  await storage.publishRoute(header.id)
  const { SqliteStore } = await import('../src/sqlite.ts')
  const database = vi.spyOn(SqliteStore.prototype, 'hasDatabase').mockResolvedValue(false)
  await expect(storage.stat(header.id)).rejects.toMatchObject({ code: 'SESSION_STORAGE_MISSING' })
  await rm(join(root, '.segments'), { recursive: true })
  expect(await storage.stat(header.id)).toBeUndefined()
  faults.op = 'readdir'; faults.error = new Error('routing scan denied')
  await expect(storage.stat(header.id)).rejects.toThrow('routing scan denied')
  database.mockRestore()
})

it('reports a database removed between routing validation and row inspection', async () => {
  const { storage } = await fixture()
  const writer = await storage.create(header); await writer.flush(); await writer.close()
  const { SqliteStore } = await import('../src/sqlite.ts')
  vi.spyOn(SqliteStore.prototype, 'stat').mockResolvedValue(undefined)
  vi.spyOn(SqliteStore.prototype, 'hasDatabase').mockResolvedValue(false)
  await expect(storage.stat(header.id)).rejects.toMatchObject({ code: 'SESSION_STORAGE_MISSING' })
})

it('refuses a competing publication with a different identity', async () => {
  const { storage } = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const link = vi.spyOn(await import('node:fs/promises'), 'link').mockImplementation(async (_source, target) => {
    await actual.writeFile(target, JSON.stringify({ id: 'wrong', database: '/wrong' }))
    throw Object.assign(new Error('race'), { code: 'EEXIST' })
  })
  await expect(storage.publishRoute(header.id)).rejects.toMatchObject({ code: 'SESSION_STORAGE_IDENTITY' })
  link.mockRestore()
})

it('honors cancellation while entering the bounded routing scan', async () => {
  const { storage } = await fixture()
  const { SqliteStore } = await import('../src/sqlite.ts')
  const aborted = new AbortController()
  vi.spyOn(SqliteStore.prototype, 'assertRoutingDatabase').mockImplementation(async () => { aborted.abort() })
  await expect(storage.list({ signal: aborted.signal })).rejects.toThrow()
})

it('preserves filesystem failures while checking a database recreated during initialization', async () => {
  const { root } = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await actual.mkdir(join(root, '.segments'), { recursive: true })
  await actual.writeFile(join(root, '.segments', 'orphan.json'), '{}')
  const { sqliteLogs } = await import('./fixtures/store.ts')
  const logs = sqliteLogs(join(root, 'missing.sqlite'), root)
  const stat = vi.spyOn(await import('node:fs/promises'), 'stat')
    .mockRejectedValueOnce(Object.assign(new Error('absent'), { code: 'ENOENT' }))
    .mockRejectedValueOnce(new Error('stat denied'))
  await expect(logs.start()).rejects.toThrow('stat denied')
  stat.mockRestore()
  await logs.close()
})

it('allows an empty routing directory without a database', async () => {
  const { storage, root } = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await actual.mkdir(join(root, '.segments'), { recursive: true })
  expect(await storage.stat(header.id)).toBeUndefined()
})

it('accepts a database initialized while its routing directory is being inspected', async () => {
  const { root } = await fixture()
  const { sqliteLogs } = await import('./fixtures/store.ts')
  const path = join(root, 'events.sqlite')
  const observer = sqliteLogs(path, root), initializer = sqliteLogs(path, root)
  const fs = await import('node:fs/promises')
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  const readdir = vi.spyOn(fs, 'readdir').mockImplementationOnce(async (...args) => {
    await initializer.start()
    await actual.mkdir(join(root, '.segments'), { recursive: true })
    await actual.writeFile(join(root, '.segments', 'published.json'), '{}')
    return actual.readdir(...args)
  })
  try { await observer.assertRoutingDatabase() }
  finally { readdir.mockRestore(); await observer.close(); await initializer.close() }
})
