import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry, {
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
} from '../src/index.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from '../src/index.ts'

const DOMAIN_VERSION = 2

const header = (id: string, cwd?: string, createdAt = 0): SessionHeader => ({
  version: 0,
  id: SessionId(id),
  createdAt,
  isSeeded: false,
  ...(cwd === undefined ? {} : { cwd }),
})

interface HarnessOptions {
  pool?: MemoryMediaPool
  sessions?: SessionHeader[]
  liveSessions?: SessionHeader[]
  sessionStore?: boolean
  backend?: StorageBackend
}

/** Boot the real storage/domain/registry composition over controllable header-only peers. */
async function harness(options: HarnessOptions = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  let listed = options.sessions ?? []
  const list = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> =>
    listed.map(header => ({ header, revision: SessionPersistenceRevision(`rev-${header.id}`) })))
  const open = vi.fn(() => { throw new Error('event bodies must not be opened') })
  const stat = vi.fn(() => { throw new Error('per-session stat must not be needed') })
  ctx.provide('sessionPersistence', { list, open, stat } as never)

  if (options.sessionStore === true) {
    await ctx.plugin(SessionStore)
  } else if (options.liveSessions !== undefined) {
    const live = new Map(options.liveSessions.map(meta => [meta.id, { header: meta }]))
    ctx.provide('sessions', {
      get: (id: SessionId) => live.get(id),
      list: () => [...live.values()],
    } as never)
  }

  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(WorkspaceRegistry)
  const initChanges = [...changes]
  changes.length = 0
  return {
    ctx,
    fiber,
    pool,
    registry: ctx.workspaceRegistry,
    changes,
    initChanges,
    list,
    open,
    stat,
    setSessions: (headers: SessionHeader[]) => { listed = headers },
  }
}

/** Boot only the storage side, for dependency-pending and startup-failure cases. */
async function storageContext(pool: MemoryMediaPool, backend: StorageBackend = new MemoryStorageBackend(pool)) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return ctx
}

/** Backend wrapper that injects one selected bootstrap write failure. */
function selectiveFailureBackend(
  pool: MemoryMediaPool,
  failure: { putAt?: number; deleteAt?: number; globalAt?: number | readonly number[] },
): StorageBackend {
  const inner = new MemoryStorageBackend(pool)
  let puts = 0
  let deletes = 0
  let globals = 0
  return {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            puts += 1
            if (puts === failure.putAt) throw new Error('selected bootstrap put failure')
            await unit.putRecord(table, key, value)
          },
          deleteRecord: async (table, key) => {
            deletes += 1
            if (deletes === failure.deleteAt) throw new Error('selected rollback delete failure')
            await unit.deleteRecord(table, key)
          },
          setGlobal: async (value) => {
            globals += 1
            const failAt = Array.isArray(failure.globalAt) ? failure.globalAt : [failure.globalAt]
            if (failAt.includes(globals)) throw new Error('selected bootstrap marker failure')
            await unit.setGlobal(value)
          },
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
}

function record(path: string, sessionIds: string[], createdAt = '2026-07-24T00:00:00.000Z'): WorkspaceRecord {
  return {
    path,
    title: basename(path),
    sessionIds: sessionIds.map(SessionId),
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * Media written before archivedSessionIds existed omit the field; keeping the
 * fixtures in that shape continuously proves the schema default upgrades them.
 */
type StoredDomainState = Omit<WorkspaceDomainState, 'archivedSessionIds'>
  & Partial<Pick<WorkspaceDomainState, 'archivedSessionIds'>>

function storedPool(
  entries: Array<[string, WorkspaceRecord]>,
  state: StoredDomainState,
): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('workspace', DOMAIN_VERSION)
  pool.media.set('workspace', {
    tables: new Map([['workspaces', new Map<string, unknown>(entries)]]),
    global: state,
  })
  return pool
}

function storedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

function storedState(pool: MemoryMediaPool): WorkspaceDomainState {
  return pool.media.get('workspace')!.global as WorkspaceDomainState
}

let base: string
const tempDirs: string[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined as never
})

describe('WorkspaceRegistry lifecycle and bootstrap', () => {
  it('stays pending without sessionPersistence and never opens or marks the domain', async () => {
    const pool = new MemoryMediaPool()
    const ctx = await storageContext(pool)
    const fiber = await ctx.plugin(WorkspaceRegistry)
    expect(ctx.get('workspaceRegistry')).toBeUndefined()
    expect(pool.media.has('workspace')).toBe(false)

    const list = vi.fn(async () => [] as SessionPersistenceSnapshot[])
    ctx.provide('sessionPersistence', { list } as never)
    await fiber.await()
    expect(ctx.workspaceRegistry.list()).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
    expect(storedState(pool)).toEqual({ initialized: true, workspaceIds: [], archivedSessionIds: [] })
  })

  it('bootstraps once from list headers only, in workspace/session createdAt order', async () => {
    const older = await makeDir('older')
    const newer = await makeDir('newer')
    const alias = join(base, 'older-link')
    const plain = join(base, 'plain.txt')
    await symlink(older, alias)
    await writeFile(plain, 'not a directory')
    const missing = join(base, 'missing')
    const result = await harness({
      sessions: [
        header('older-first', older, 100),
        header('newer-only', newer, 500),
        header('older-latest', alias, 300),
        header('no-cwd', undefined, 900),
        header('missing-dir', missing, 800),
        header('plain-file', plain, 700),
      ],
    })

    expect(result.list).toHaveBeenCalledTimes(1)
    expect(result.open).not.toHaveBeenCalled()
    expect(result.stat).not.toHaveBeenCalled()
    expect(result.registry.list().map(workspace => workspace.path)).toEqual([newer, older])
    expect(result.registry.list().map(workspace => workspace.sessionIds)).toEqual([
      ['newer-only'],
      ['older-latest', 'older-first'],
    ])
    expect(storedState(result.pool)).toEqual({
      initialized: true,
      workspaceIds: result.registry.list().map(workspace => workspace.id),
      archivedSessionIds: [],
    })
  })

  it('breaks equal bootstrap timestamps by session id and canonical path', async () => {
    const first = await makeDir('tie-first')
    const second = await makeDir('tie-second')
    const result = await harness({
      sessions: [
        header('z-session', first, 100),
        header('a-session', first, 100),
        header('second-session', second, 100),
      ],
    })
    expect(new Set(result.registry.list().map(workspace => workspace.path))).toEqual(new Set([first, second]))
    expect(result.registry.list().find(workspace => workspace.path === first)!.sessionIds)
      .toEqual(['a-session', 'z-session'])
  })

  it('does not rerun bootstrap for a genuinely initialized empty registry', async () => {
    const late = await makeDir('late-cwd-only')
    const pool = new MemoryMediaPool()
    const first = await harness({ pool, sessions: [] })
    expect(first.list).toHaveBeenCalledTimes(1)
    await first.fiber.dispose()

    const second = await harness({ pool, sessions: [header('late', late, 100)] })
    expect(second.list).not.toHaveBeenCalled()
    expect(second.registry.list()).toEqual([])
    expect(storedState(pool)).toEqual({ initialized: true, workspaceIds: [], archivedSessionIds: [] })
  })

  it('reuses partial records after a bootstrap record write fails', async () => {
    const firstDir = await makeDir('partial-first')
    const secondDir = await makeDir('partial-second')
    const sessions = [header('first', firstDir, 200), header('second', secondDir, 100)]
    const pool = new MemoryMediaPool()
    await expect(harness({
      pool,
      sessions,
      backend: selectiveFailureBackend(pool, { putAt: 2 }),
    })).rejects.toThrow(/selected bootstrap put failure/)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
    expect(pool.media.get('workspace')!.global).toBeNull()

    const retried = await harness({ pool, sessions })
    expect(retried.registry.list()).toHaveLength(2)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(2)
    expect(storedState(pool).initialized).toBe(true)
  })

  it('reuses durable order when the final initialized marker write fails', async () => {
    const dir = await makeDir('marker-retry')
    const sessions = [header('session', dir, 100)]
    const pool = new MemoryMediaPool()
    await expect(harness({
      pool,
      sessions,
      backend: selectiveFailureBackend(pool, { globalAt: 2 }),
    })).rejects.toThrow(/selected bootstrap marker failure/)
    expect(storedState(pool)).toMatchObject({ initialized: false })
    expect(storedState(pool).workspaceIds).toHaveLength(1)

    const retried = await harness({ pool, sessions })
    expect(retried.registry.list()).toHaveLength(1)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
    expect(storedState(pool).initialized).toBe(true)
  })

  it('merges partial records and leaves an already-accounted cwd drift ungrouped', async () => {
    const owned = await makeDir('partial-owned')
    const prior = await makeDir('partial-prior')
    const drifted = await makeDir('partial-drifted')
    const ownedId = WorkspaceId('00000000-0000-4000-8000-000000000010')
    const priorId = WorkspaceId('00000000-0000-4000-8000-000000000011')
    const pool = storedPool(
      [
        [ownedId, record(owned, ['old'], '2026-07-24T00:00:00.000Z')],
        [priorId, record(prior, ['drift'], '2026-07-23T00:00:00.000Z')],
      ],
      { initialized: false, workspaceIds: [] },
    )
    const result = await harness({
      pool,
      sessions: [header('new', owned, 200), header('old', owned, 100), header('drift', drifted, 300)],
    })
    expect(result.registry.list().map(workspace => workspace.id)).toContain(ownedId)
    expect(result.registry.get(ownedId)!.sessionIds).toEqual(['new', 'old'])
    expect(result.registry.list().some(workspace => workspace.path === drifted)).toBe(false)
  })

  it('orders headerless partial records by prior order, then stable id', async () => {
    const first = await makeDir('fallback-first')
    const second = await makeDir('fallback-second')
    const firstId = WorkspaceId('00000000-0000-4000-8000-000000000020')
    const secondId = WorkspaceId('00000000-0000-4000-8000-000000000021')
    const entries: Array<[string, WorkspaceRecord]> = [
      [secondId, record(second, [], '2026-07-24T00:00:00.000Z')],
      [firstId, record(first, [], '2026-07-24T00:00:00.000Z')],
    ]
    const prior = await harness({
      pool: storedPool(entries, { initialized: false, workspaceIds: [secondId, firstId] }),
    })
    expect(prior.registry.list().map(workspace => workspace.id)).toEqual([secondId, firstId])

    const byId = await harness({
      pool: storedPool(entries, { initialized: false, workspaceIds: [] }),
    })
    expect(byId.registry.list().map(workspace => workspace.id)).toEqual([firstId, secondId])
  })

  it('closes its domain on disposal and reloads the persisted stable order', async () => {
    const dir = await makeDir('replug')
    const result = await harness()
    const first = await result.registry.create(dir)
    await result.fiber.dispose()
    const nextFiber = await result.ctx.plugin(WorkspaceRegistry)
    expect(result.ctx.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([first.id])
    await nextFiber.dispose()
  })
})

describe('WorkspaceRegistry create and lookup', () => {
  it('creates newest-first and idempotently reuses a canonical path without retitling', async () => {
    const firstDir = await makeDir('first')
    const secondDir = await makeDir('second')
    const alias = join(base, 'first-link')
    await symlink(firstDir, alias)
    const { registry, pool } = await harness()
    const first = await registry.create(firstDir, 'Original')
    const second = await registry.create(secondDir)
    const reused = await registry.create(alias, 'Ignored')
    expect(reused).toBe(first)
    expect(first.title).toBe('Original')
    expect(registry.list()).toEqual([second, first])
    expect(storedState(pool).workspaceIds).toEqual([second.id, first.id])
    expect(await registry.resolveByPath(alias)).toBe(first)
    expect(await registry.resolveByPath(await makeDir('unowned'))).toBeUndefined()
  })

  it('serializes concurrent same-path creates into one entity', async () => {
    const dir = await makeDir('concurrent')
    const { registry, pool } = await harness()
    const [left, right] = await Promise.all([
      registry.create(dir, 'Winner'),
      registry.create(dir, 'Loser'),
    ])
    expect(left).toBe(right)
    expect(registry.list()).toEqual([left])
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
  })

  it('allows a duplicate display name on a different canonical path', async () => {
    const firstDir = await makeDir('named-first')
    const secondDir = await makeDir('named-second')
    const { registry } = await harness()
    const first = await registry.create(firstDir, 'Shared')
    const second = await registry.create(secondDir, 'Shared')
    expect(first.title).toBe('Shared')
    expect(second.title).toBe('Shared')
    expect(registry.list()).toEqual([second, first])
  })

  it('rejects nonexistent and non-directory paths without changing order', async () => {
    const parent = await makeDir('invalid')
    const file = join(parent, 'plain.txt')
    await writeFile(file, 'file')
    const { registry } = await harness()
    await expect(registry.create(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(registry.create(file)).rejects.toThrow(/not a directory/)
    await expect(registry.resolveByPath(join(parent, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(registry.list()).toEqual([])
  })

  it('rolls back the provisional cache when the record write fails', async () => {
    const dir = await makeDir('write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { putAt: 1 }),
    })
    await expect(result.registry.create(dir)).rejects.toThrow(/selected bootstrap put failure/)
    expect(result.registry.list()).toEqual([])
    expect(await result.registry.create(dir)).toBeDefined()
  })

  it('does not publish a Workspace when its pending marker cannot be written', async () => {
    const dir = await makeDir('pending-marker-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 2 }),
    })
    await expect(result.registry.create(dir)).rejects.toThrow(/selected bootstrap marker failure/)
    expect(result.registry.list()).toEqual([])
    expect(pool.media.get('workspace')!.tables.get('workspaces')?.size ?? 0).toBe(0)
  })

  it('rolls back a record when registry-order persistence fails', async () => {
    const dir = await makeDir('order-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 3 }),
    })
    await expect(result.registry.create(dir)).rejects.toThrow(/marker failure/)
    expect(result.registry.list()).toEqual([])
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(0)
  })

  it('reports both order and rollback failures while retaining the recoverable record', async () => {
    const dir = await makeDir('rollback-write-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 3, deleteAt: 1 }),
    })
    await expect(result.registry.create(dir)).rejects.toBeInstanceOf(AggregateError)
    expect(pool.media.get('workspace')!.tables.get('workspaces')!.size).toBe(1)
  })

  it('reports a record write and pending-marker rollback failure together', async () => {
    const dir = await makeDir('record-marker-rollback-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { putAt: 1, globalAt: 3 }),
    })
    await expect(result.registry.create(dir)).rejects.toBeInstanceOf(AggregateError)
    expect(storedState(pool)).toMatchObject({
      pendingMutation: { operation: 'create' },
    })
  })

  it('reports an order write and pending-marker rollback failure together', async () => {
    const dir = await makeDir('order-marker-rollback-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: [3, 4] }),
    })
    await expect(result.registry.create(dir)).rejects.toBeInstanceOf(AggregateError)
    expect(storedState(pool)).toMatchObject({
      pendingMutation: { operation: 'create' },
    })
  })

  it('deletes only the registration and leaves its directory and session headers untouched', async () => {
    const dir = await makeDir('delete-registration')
    const result = await harness({ sessions: [header('kept-session', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('kept-session'))

    await expect(result.registry.delete(workspace.id)).resolves.toBe(true)
    await expect(result.registry.delete(workspace.id)).resolves.toBe(false)
    expect(result.registry.get(workspace.id)).toBeUndefined()
    expect(result.registry.list()).toEqual([])
    expect(storedState(result.pool)).toEqual({ initialized: true, workspaceIds: [], archivedSessionIds: [] })
    expect(result.pool.media.get('workspace')!.tables.get('workspaces')!.has(workspace.id)).toBe(false)
    await expect(realpath(dir)).resolves.toBe(dir)
    expect(result.list).toHaveBeenCalledTimes(1)
    expect(result.open).not.toHaveBeenCalled()
    expect(result.stat).not.toHaveBeenCalled()

    const reregistered = await result.registry.create(dir)
    expect(reregistered.id).not.toBe(workspace.id)
    expect(reregistered.path).toBe(dir)
    expect(reregistered.sessionIds).toEqual([])
  })

  it('rolls registry order and cache back when record deletion fails', async () => {
    const dir = await makeDir('delete-rollback')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { deleteAt: 1 }),
    })
    const workspace = await result.registry.create(dir)

    await expect(result.registry.delete(workspace.id)).rejects.toThrow(/selected rollback delete failure/)
    expect(result.registry.get(workspace.id)).toBe(workspace)
    expect(result.registry.list()).toEqual([workspace])
    expect(storedState(pool).workspaceIds).toEqual([workspace.id])
    expect(storedRecord(pool, workspace.id)).toMatchObject({ path: dir })
  })

  it('commits deletion and leaves a recoverable marker when marker cleanup fails', async () => {
    const dir = await makeDir('delete-marker-cleanup')
    const pool = new MemoryMediaPool()
    const first = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { globalAt: 5 }),
    })
    const workspace = await first.registry.create(dir)

    await expect(first.registry.delete(workspace.id)).resolves.toBe(true)
    expect(first.registry.list()).toEqual([])
    expect(storedState(pool)).toEqual({
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pendingMutation: { operation: 'delete', workspaceId: workspace.id },
    })
    const reregistered = await first.registry.create(dir)
    expect(reregistered.id).not.toBe(workspace.id)
    expect(storedState(pool)).toEqual({
      initialized: true,
      workspaceIds: [reregistered.id],
      archivedSessionIds: [],
    })
    await first.fiber.dispose()

    const restarted = await harness({ pool })
    expect(restarted.registry.list().map(item => item.id)).toEqual([reregistered.id])
  })

  it('keeps the failed deletion unpublished when record and order rollback both fail', async () => {
    const dir = await makeDir('delete-double-failure')
    const pool = new MemoryMediaPool()
    const result = await harness({
      pool,
      backend: selectiveFailureBackend(pool, { deleteAt: 1, globalAt: 5 }),
    })
    const workspace = await result.registry.create(dir)

    await expect(result.registry.delete(workspace.id)).rejects.toBeInstanceOf(AggregateError)
    expect(result.registry.get(workspace.id)).toBeUndefined()
    expect(storedState(pool)).toMatchObject({
      workspaceIds: [],
      pendingMutation: { operation: 'delete', workspaceId: workspace.id },
    })
  })

  it('rejects table access before the registry has started', async () => {
    const dir = await makeDir('unstarted')
    const registry = new WorkspaceRegistry(new Context())
    await expect(registry.create(dir)).rejects.toThrow(/not started/)
    expect(() => registry.list()).toThrow(/not started/)
    const internals = registry as unknown as { requireTable(): unknown }
    expect(() => internals.requireTable()).toThrow(/not started/)
  })
})

describe('Workspace registry ordering', () => {
  it('moves a workspace before an anchor or to the end and restores that order after restart', async () => {
    const firstDir = await makeDir('order-first')
    const secondDir = await makeDir('order-second')
    const thirdDir = await makeDir('order-third')
    const result = await harness()
    const first = await result.registry.create(firstDir)
    const second = await result.registry.create(secondDir)
    const third = await result.registry.create(thirdDir)
    expect(result.registry.list().map(item => item.id)).toEqual([third.id, second.id, first.id])

    await expect(result.registry.insertBefore(first.id, second.id))
      .resolves.toEqual([third.id, first.id, second.id])
    await expect(result.registry.insertBefore(third.id))
      .resolves.toEqual([first.id, second.id, third.id])
    expect(storedState(result.pool).workspaceIds).toEqual([first.id, second.id, third.id])

    const restarted = await harness({ pool: result.pool })
    expect(restarted.registry.list().map(item => item.id)).toEqual([first.id, second.id, third.id])
  })

  it('keeps self-anchored and already-positioned moves write-free and rejects unknown ids', async () => {
    const firstDir = await makeDir('order-noop-first')
    const secondDir = await makeDir('order-noop-second')
    const result = await harness()
    const first = await result.registry.create(firstDir)
    const second = await result.registry.create(secondDir)
    const written = result.changes.length

    await result.registry.insertBefore(second.id, second.id)
    await result.registry.insertBefore(second.id, first.id)
    await result.registry.insertBefore(first.id)
    expect(result.changes).toHaveLength(written)
    expect(result.registry.list().map(item => item.id)).toEqual([second.id, first.id])

    await expect(result.registry.insertBefore(WorkspaceId('missing')))
      .rejects.toBeInstanceOf(WorkspaceOrderInvalidError)
    await expect(result.registry.insertBefore(second.id, WorkspaceId('missing-anchor')))
      .rejects.toMatchObject({ workspaceId: 'missing-anchor' })
    expect(result.changes).toHaveLength(written)
  })
})

describe('Workspace session ordering', () => {
  it('prepends new attaches and keeps repeat attach idempotent', async () => {
    const dir = await makeDir('attach-order')
    const result = await harness()
    result.setSessions([
      header('s1', dir, 1),
      header('s2', dir, 2),
    ])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    expect(workspace.sessionIds).toEqual(['s2', 's1'])
    await workspace.attachSession(SessionId('s1'))
    expect(workspace.sessionIds).toEqual(['s2', 's1'])
    expect(storedRecord(result.pool, workspace.id).sessionIds).toEqual(['s2', 's1'])
  })

  it('moves one id before an anchor or to the end, durably', async () => {
    const dir = await makeDir('insert-before')
    const result = await harness()
    result.setSessions([header('s1', dir, 1), header('s2', dir, 2), header('s3', dir, 3)])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    await workspace.attachSession(SessionId('s3'))
    expect(workspace.sessionIds).toEqual(['s3', 's2', 's1'])

    await workspace.insertSessionBefore(SessionId('s1'), SessionId('s2'))
    expect(workspace.sessionIds).toEqual(['s3', 's1', 's2'])
    await workspace.insertSessionBefore(SessionId('s3'))
    expect(workspace.sessionIds).toEqual(['s1', 's2', 's3'])
    expect(storedRecord(result.pool, workspace.id).sessionIds).toEqual(['s1', 's2', 's3'])
  })

  it('treats self-anchored and already-in-place moves as no-ops without writing', async () => {
    const dir = await makeDir('insert-noop')
    const result = await harness()
    result.setSessions([header('s1', dir, 1), header('s2', dir, 2)])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    await workspace.attachSession(SessionId('s2'))
    const written = result.changes.length

    await workspace.insertSessionBefore(SessionId('s1'), SessionId('s1'))
    await workspace.insertSessionBefore(SessionId('s2'), SessionId('s1'))
    await workspace.insertSessionBefore(SessionId('s1'))
    await workspace.detachSession(SessionId('absent'))
    expect(result.changes).toHaveLength(written)
    expect(workspace.sessionIds).toEqual(['s2', 's1'])
  })

  it('rejects moves naming an unaccounted session or anchor', async () => {
    const dir = await makeDir('insert-invalid')
    const result = await harness()
    result.setSessions([header('s1', dir, 1)])
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    const written = result.changes.length

    await expect(workspace.insertSessionBefore(SessionId('ghost')))
      .rejects.toBeInstanceOf(WorkspaceMoveInvalidError)
    await expect(workspace.insertSessionBefore(SessionId('s1'), SessionId('ghost')))
      .rejects.toThrow(/anchor session is not accounted/)
    expect(result.changes).toHaveLength(written)
    expect(workspace.sessionIds).toEqual(['s1'])
  })

  it('validates a lazy live session without requiring it in persistence.list()', async () => {
    const dir = await makeDir('live')
    const result = await harness({ sessions: [], liveSessions: [header('live', dir, 1)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('live'))
    expect(workspace.sessionIds).toEqual(['live'])
    expect(result.list).toHaveBeenCalledTimes(1)
  })

  it('rejects mismatched, missing, unresolved, non-directory, and unknown cwd facts', async () => {
    const dir = await makeDir('strict')
    const elsewhere = await makeDir('elsewhere')
    const gone = await makeDir('gone')
    const file = join(base, 'cwd-file')
    await writeFile(file, 'file')
    const result = await harness()
    result.setSessions([
      header('mismatch', elsewhere),
      header('no-cwd'),
      header('gone', gone),
      header('file', file),
    ])
    await rm(gone, { recursive: true })
    const workspace = await result.registry.create(dir)
    await expect(workspace.attachSession(SessionId('mismatch'))).rejects.toThrow(/resolves to/)
    await expect(workspace.attachSession(SessionId('no-cwd'))).rejects.toThrow(/no cwd/)
    await expect(workspace.attachSession(SessionId('gone'))).rejects.toThrow(/does not resolve/)
    await expect(workspace.attachSession(SessionId('file'))).rejects.toThrow(/not a directory/)
    await expect(workspace.attachSession(SessionId('unknown'))).rejects.toThrow(/no such session/)
    expect(workspace.sessionIds).toEqual([])
  })

  it('decides detach/attach membership at domain write-chain slots', async () => {
    const dir = await makeDir('race')
    const result = await harness({ sessions: [header('s1', dir)] })
    const workspace = await result.registry.create(dir)
    await workspace.attachSession(SessionId('s1'))
    const detached = workspace.detachSession(SessionId('s1'))
    const attached = workspace.attachSession(SessionId('s1'))
    await Promise.all([detached, attached])
    expect(workspace.sessionIds).toEqual(['s1'])
  })

})

describe('header-validated membership projection', () => {
  it('requires both candidate id and matching canonical cwd without re-reading on list()', async () => {
    const owned = await makeDir('owned')
    const elsewhere = await makeDir('projection-elsewhere')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000001')
    const pool = storedPool(
      [[id, record(owned, ['good', 'mismatch', 'missing'])]],
      { initialized: true, workspaceIds: [id] },
    )
    const result = await harness({
      pool,
      sessions: [
        header('good', owned),
        header('mismatch', elsewhere),
        header('cwd-only', owned),
      ],
    })
    const workspace = result.registry.list()[0]!
    expect(workspace.sessionIds).toEqual(['good'])
    expect(result.registry.list()[0]!.sessionIds).toEqual(['good'])
    expect(result.list).toHaveBeenCalledTimes(1)
    expect(storedRecord(pool, id).sessionIds).toEqual(['good', 'mismatch', 'missing'])

    await workspace.setTitle('pruned')
    expect(storedRecord(pool, id).sessionIds).toEqual(['good'])
    expect(workspace.sessionIds).not.toContain('cwd-only')
  })

  it('rejects duplicate candidate ownership, duplicate paths, and initialized order drift', async () => {
    const first = await makeDir('corrupt-first')
    const second = await makeDir('corrupt-second')
    const firstId = '00000000-0000-4000-8000-000000000002'
    const secondId = '00000000-0000-4000-8000-000000000003'
    const duplicateSession = storedPool(
      [[firstId, record(first, ['dup'])], [secondId, record(second, ['dup'])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(secondId)] },
    )
    await expect(harness({ pool: duplicateSession })).rejects.toThrow(/accounted/)

    const duplicatePath = storedPool(
      [[firstId, record(first, [])], [secondId, record(first, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(secondId)] },
    )
    await expect(harness({ pool: duplicatePath })).rejects.toThrow(/claimed/)

    const orphan = storedPool(
      [[firstId, record(first, [])], [secondId, record(second, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: orphan })).rejects.toThrow(/absent from registry order/)

    const repeated = storedPool(
      [[firstId, record(first, [])]],
      { initialized: true, workspaceIds: [WorkspaceId(firstId), WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: repeated })).rejects.toThrow(/repeats workspace/)

    const missing = storedPool(
      [],
      { initialized: true, workspaceIds: [WorkspaceId(firstId)] },
    )
    await expect(harness({ pool: missing })).rejects.toThrow(/references missing workspace/)
  })

  it('fails list if the durable order and entity cache are externally diverged', async () => {
    const dir = await makeDir('cache-diverged')
    const result = await harness()
    const workspace = await result.registry.create(dir)
    const internals = result.registry as unknown as { entities: Map<WorkspaceId, unknown> }
    internals.entities.delete(workspace.id)
    expect(() => result.registry.list()).toThrow(/references missing workspace/)
  })

  it('recovers only an explicitly marked interrupted create or delete', async () => {
    const createDir = await makeDir('pending-create')
    const deleteDir = await makeDir('pending-delete')
    const createId = WorkspaceId('00000000-0000-4000-8000-000000000004')
    const deleteId = WorkspaceId('00000000-0000-4000-8000-000000000005')

    const interruptedCreate = storedPool(
      [[createId, record(createDir, [])]],
      {
        initialized: true,
        workspaceIds: [],
        pendingMutation: { operation: 'create', workspaceId: createId },
      },
    )
    const createRecovery = await harness({ pool: interruptedCreate })
    expect(createRecovery.registry.list()).toEqual([])
    expect(interruptedCreate.media.get('workspace')!.tables.get('workspaces')!.has(createId)).toBe(false)
    expect(storedState(interruptedCreate)).toEqual({ initialized: true, workspaceIds: [], archivedSessionIds: [] })

    const interruptedDelete = storedPool(
      [[deleteId, record(deleteDir, [])]],
      {
        initialized: true,
        workspaceIds: [],
        pendingMutation: { operation: 'delete', workspaceId: deleteId },
      },
    )
    const deleteRecovery = await harness({ pool: interruptedDelete })
    expect(deleteRecovery.registry.list()).toEqual([])
    expect(interruptedDelete.media.get('workspace')!.tables.get('workspaces')!.has(deleteId)).toBe(false)
    expect(storedState(interruptedDelete)).toEqual({ initialized: true, workspaceIds: [], archivedSessionIds: [] })

    const corruptPending = storedPool(
      [[deleteId, record(deleteDir, [])]],
      {
        initialized: true,
        workspaceIds: [deleteId],
        pendingMutation: { operation: 'delete', workspaceId: deleteId },
      },
    )
    await expect(harness({ pool: corruptPending })).rejects.toThrow(/still present in registry order/)
  })
})

describe('workspace mutation and status', () => {
  it('keeps createdAt stable, advances updatedAt, and preserves snapshot on write failure', async () => {
    const dir = await makeDir('timestamps')
    const result = await harness()
    const workspace = await result.registry.create(dir)
    const createdAt = workspace.createdAt
    expect(workspace.updatedAt).toBe(createdAt)
    await workspace.setTitle('kept')
    expect(workspace.createdAt).toBe(createdAt)
    expect(Date.parse(workspace.updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))
    result.pool.failNextWrites = 1
    await expect(workspace.setTitle('lost')).rejects.toThrow(/injected/)
    expect(workspace.title).toBe('kept')
  })

  it('reports directory disappearance without mutating the workspace', async () => {
    const dir = await makeDir('vanishing')
    const { registry } = await harness()
    const workspace = await registry.create(dir)
    expect(await workspace.status()).toBe('ok')
    await rm(dir, { recursive: true })
    expect(await workspace.status()).toBe('missing-dir')
    await writeFile(dir, 'now a file')
    expect(await workspace.status()).toBe('missing-dir')
    expect(registry.get(workspace.id)).toBe(workspace)
  })
})

describe('registry-global session archive', () => {
  it('archives durably in order, idempotently skips repeats, and leaves accounting untouched', async () => {
    const dir = await makeDir('archive-home')
    const result = await harness({ sessions: [header('kept', dir, 100), header('gone', dir, 200)] })
    const workspace = result.registry.list()[0]!
    expect(result.registry.archivedSessionIds).toEqual([])

    await result.registry.archiveSession(SessionId('gone'))
    expect(result.registry.archivedSessionIds).toEqual(['gone'])
    // Archiving is a display-set write: the workspace account keeps the id.
    expect(workspace.sessionIds).toContain('gone')
    expect(storedState(result.pool).archivedSessionIds).toEqual(['gone'])
    const changesAfterFirst = result.changes.filter(change => change.table === '').length

    await result.registry.archiveSession(SessionId('gone'))
    expect(result.registry.archivedSessionIds).toEqual(['gone'])
    // The idempotent repeat neither rewrites the medium nor emits a change.
    expect(result.changes.filter(change => change.table === '').length).toBe(changesAfterFirst)

    await result.registry.archiveSession(SessionId('kept'))
    expect(result.registry.archivedSessionIds).toEqual(['gone', 'kept'])
  })

  it('accepts unaccounted and live sessions but rejects unknown ids without writing', async () => {
    const dir = await makeDir('archive-strays')
    const live = await makeDir('archive-live')
    const result = await harness({
      sessions: [header('stray', dir, 100)],
      liveSessions: [header('live-only', live, 200)],
    })
    await result.registry.archiveSession(SessionId('stray'))
    await result.registry.archiveSession(SessionId('live-only'))
    expect(result.registry.archivedSessionIds).toEqual(['stray', 'live-only'])

    await expect(result.registry.archiveSession(SessionId('ghost')))
      .rejects.toThrow(/cannot archive session 'ghost'/)
    expect(storedState(result.pool).archivedSessionIds).toEqual(['stray', 'live-only'])
  })

  it('propagates a persistence-listing failure instead of reporting an unknown session', async () => {
    const result = await harness({ sessions: [] })
    result.list.mockRejectedValueOnce(new Error('persistence backend down'))
    // The storage fault is the error — never WorkspaceUnknownSessionError,
    // which the API layer would misreport as session-not-found.
    await expect(result.registry.archiveSession(SessionId('unlisted')))
      .rejects.toThrow(/persistence backend down/)
    expect(storedState(result.pool).archivedSessionIds).toEqual([])
  })

  it('restores the archive set across restarts and defaults it for pre-field media', async () => {
    const dir = await makeDir('archive-restart')
    const pool = new MemoryMediaPool()
    const first = await harness({ pool, sessions: [header('s1', dir, 100)] })
    await first.registry.archiveSession(SessionId('s1'))
    await first.fiber.dispose()

    const second = await harness({ pool, sessions: [header('s1', dir, 100)] })
    expect(second.registry.archivedSessionIds).toEqual(['s1'])
    await second.fiber.dispose()

    // A medium written before the field existed parses through the schema default.
    const legacyId = WorkspaceId('00000000-0000-4000-8000-00000000000a')
    const legacy = storedPool(
      [[legacyId, record(dir, [])]],
      { initialized: true, workspaceIds: [legacyId] },
    )
    const upgraded = await harness({ pool: legacy })
    expect(upgraded.registry.archivedSessionIds).toEqual([])
  })
})
