/** SQLite directory entries settle before database creation, including initialization retries. @module */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { sqliteLogs } from './fixtures/store.ts'

const observed = vi.hoisted(() => ({ database: '', failAt: '', creationError: undefined as Error | undefined,
  events: [] as { path: string; operation: string }[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const path = String(args[0])
    if (path === observed.database && args[1] === 'wx' && observed.creationError !== undefined) throw observed.creationError
    const handle = await actual.open(...args)
    if (path === observed.database) observed.events.push({ path, operation: 'database-open' })
    if (args[1] === 'r') {
      const sync = handle.sync.bind(handle), close = handle.close.bind(handle)
      handle.sync = async () => {
        observed.events.push({ path, operation: 'sync' })
        if (path === observed.failAt) throw new Error('fixture directory sync failed')
        await sync()
      }
      handle.close = async () => {
        observed.events.push({ path, operation: 'close' })
        await close()
      }
    }
    return handle
  } }
})

afterEach(() => { observed.database = ''; observed.failAt = ''; observed.creationError = undefined; observed.events = [] })

async function fixture(custom: boolean) {
  const base = await mkdtemp(join(tmpdir(), 'sqlite-directory-'))
  const root = join(base, 'profiles', 'sessions')
  const path = custom ? join(base, 'databases', 'nested', 'sessions.sqlite') : join(root, '.segments', 'sessions.sqlite')
  const logs = sqliteLogs(path, root)
  observed.database = path
  onTestFinished(async () => { try { await logs.close() } finally { await rm(base, { recursive: true, force: true }) } })
  return { base, root, path, logs }
}

// Windows publishes new directories with MOVEFILE_WRITE_THROUGH rather than opening them for fsync.
it.skipIf(process.platform === 'win32').each([false, true])(
  'syncs new directory ancestors before creating SQLite (custom path: %s)', async (custom) => {
    const { base, root, logs } = await fixture(custom)
    await logs.start()
    const databaseOpen = observed.events.findIndex(event => event.operation === 'database-open')
    expect(databaseOpen).toBeGreaterThan(0)
    const synced = observed.events.slice(0, databaseOpen).filter(event => event.operation === 'sync').map(event => event.path)
    expect(synced).toEqual(expect.arrayContaining(custom
      ? [base, join(base, 'databases'), join(base, 'profiles'), root]
      : [base, join(base, 'profiles'), root]))
    expect(synced).not.toContain(dirname(base))
  },
)

it.skipIf(process.platform === 'win32')('closes a failed directory sync and repeats ancestor sync on initialization retry', async () => {
  const { base, path, logs } = await fixture(true)
  observed.failAt = base
  await expect(logs.start()).rejects.toThrow('fixture directory sync failed')
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(observed.events.at(-1)).toEqual({ path: base, operation: 'close' })
  observed.failAt = ''
  observed.events = []
  await logs.start()
  expect(observed.events).toContainEqual({ path: base, operation: 'sync' })
})

it('preserves a database creation failure after directory preparation and permits retry', async () => {
  const { path, logs } = await fixture(true)
  const failure = Object.assign(new Error('fixture database creation denied'), { code: 'EACCES' })
  observed.creationError = failure
  await expect(logs.start()).rejects.toBe(failure)
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  observed.creationError = undefined
  await expect(logs.start()).resolves.toBeUndefined()
})

// Existing directory entries need no new publication; POSIX is the only directory-fsync path.
it.skipIf(process.platform === 'win32')('opens existing storage without synchronizing shared ancestor directories', async () => {
  const { root, path, logs } = await fixture(true)
  await logs.start()
  await logs.close()
  observed.events = []
  const reopened = sqliteLogs(path, root)
  try {
    await reopened.start()
    expect(observed.events.filter(event => event.operation === 'sync')).toEqual([])
  } finally { await reopened.close() }
})
