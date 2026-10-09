/** Projection reads distinguish ordinary cold history from history that still needs migration. */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, {
  checkpointRecord,
  projectionCacheDomainSpec,
  type CheckpointRecord,
} from '@deepseek-ai/dsh-session-projection-cache'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { subagentCatalogProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/catalog.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionTestController } from './test-remote.ts'

const contexts: Context[] = []
const roots: string[] = []
const readAudits: Array<() => void> = []

afterEach(async () => {
  try {
    for (const audit of readAudits.splice(0)) audit()
  } finally {
    vi.restoreAllMocks()
    try {
      await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    } finally {
      await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
    }
  }
})

async function harness(withPersistence = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projection-discovery-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
  ctx.sessionProjections.register(titleProjectionDefinition)
  if (withPersistence) {
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
    const list = vi.spyOn(ctx.sessionPersistence, 'list').mockRejectedValue(new Error('unexpected corpus listing'))
    readAudits.push(() => {
      expect(list).not.toHaveBeenCalled()
    })
  }
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
    cwd: root,
  })
  const list = vi.spyOn(ctx.sessionQuery, 'listSessions').mockRejectedValue(new Error('unexpected Session listing'))
  readAudits.push(() => {
    expect(list).not.toHaveBeenCalled()
  })
  return { ctx, root, controller }
}

type Harness = Awaited<ReturnType<typeof harness>>

async function stored(
  fixture: Harness,
  id: SessionId,
  fields: Partial<Pick<SessionHeader, 'createdAt' | 'parentSession' | 'origin' | 'isSeeded'>> = {},
  version = SESSION_FORMAT_VERSION,
) {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 10,
    delegationDepth: 0,
    isSeeded: false,
    ...fields,
  }
  const path = join(fixture.root, 'logs', '_no-cwd', id, `session.v${version}.jsonl`)
  const bytes = `${JSON.stringify({ type: 'session', ...header, version })}\n`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return { header, path, bytes }
}

async function seedCache(
  fixture: Harness,
  header: SessionHeader,
  catalog: 'child' | 'empty' | 'absent',
  matchingIdentity = true,
) {
  const rows: CheckpointRecord['rows'] = {
    title: { ver: titleProjectionDefinition.stateVersion, seq: SessionSeq(50), val: 'cached title' },
  }
  if (catalog !== 'absent') {
    const empty = subagentCatalogProjectionDefinition.init(header, SessionLogOffset(0))
    const state = catalog === 'empty' ? empty : subagentCatalogProjectionDefinition.apply(empty, {
      type: 'subagent/catalog',
      seq: SessionSeq(0),
      time: 1,
      data: {
        version: 1,
        childId: SessionId('cached-child'),
        childCreatedAt: 2,
        mode: 'one-shot',
        label: 'cached child',
      },
    })
    const record = checkpointRecord.parse({
      identity: { createdAt: header.createdAt },
      rows: { subagentCatalog: { ver: subagentCatalogProjectionDefinition.stateVersion, seq: 50, val: state } },
    })
    Object.assign(rows, record.rows)
  }
  const record: CheckpointRecord = {
    identity: {
      formatVersion: SESSION_FORMAT_VERSION,
      createdAt: matchingIdentity ? header.createdAt : header.createdAt + 1,
      cwd: header.cwd,
      isSeeded: header.isSeeded,
      inheritedEventCount: SessionLogOffset(0),
    },
    rows,
  }
  const cacheRoot = join(fixture.root, 'cache')
  const path = join(cacheRoot, projectionCacheDomainSpec.name, 'sessions', `${header.id}.json`)
  const bytes = JSON.stringify({ version: projectionCacheDomainSpec.version, record })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  await fixture.ctx.plugin(Storage)
  await fixture.ctx.plugin(StorageJson, { root: cacheRoot })
  await fixture.ctx.plugin(StorageDomain, { backend: 'json' })
  await fixture.ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  const write = vi.spyOn(fixture.ctx.sessionProjectionCache, 'write').mockRejectedValue(new Error('unexpected cache write'))
  const hydrate = vi.spyOn(fixture.ctx.sessionProjectionCache, 'hydratePrepared').mockImplementation(() => {
    throw new Error('unexpected cached hydration')
  })
  readAudits.push(() => {
    expect(write).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })
  return { path, bytes }
}

describe('Session projection discovery', () => {
  it('defers V3 migration without reading child bodies or publishing a successor', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('parent'), {}, 3)
    const child = await stored(fixture, SessionId('child'), { origin: 'subagent', parentSession: parent.header.id, createdAt: 20 }, 3)
    const grandchild = await stored(fixture, SessionId('grandchild'), { origin: 'subagent', parentSession: child.header.id, createdAt: 30 }, 3)
    const fork = await stored(fixture, SessionId('ordinary-fork'), { parentSession: parent.header.id, isSeeded: true }, 3)
    const unrelated = await stored(fixture, SessionId('unrelated'), { origin: 'subagent', parentSession: SessionId('another-parent') }, 3)
    const open = vi.spyOn(fixture.ctx.sessionPersistence, 'open')
    const observe = vi.spyOn(fixture.ctx.sessionQuery, 'observeSession')

    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal)).resolves.toEqual({
      kind: 'migration-required',
      values: {},
    })
    expect(open).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(await fixture.ctx.sessionPersistence.stat(parent.header.id)).toMatchObject({
      formatStatus: 'migration-required',
    })
    expect(fixture.ctx.sessions.list()).toEqual([])
    for (const source of [parent, child, grandchild, fork, unrelated]) {
      expect(await readFile(source.path, 'utf8')).toBe(source.bytes)
      expect(await readdir(dirname(source.path))).toEqual(['session.v3.jsonl'])
    }
  })

  it.each(['child', 'empty'] as const)('serves a valid %s catalog cache when migration is required', async (catalog) => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('cached-parent'), {}, 3)
    const cache = await seedCache(fixture, parent.header, catalog)
    const list = vi.spyOn(fixture.ctx.sessionQuery, 'listSessions').mockRejectedValue(new Error('unexpected fallback'))
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal)).resolves.toEqual({
      kind: 'migration-required',
      values: {
        title: 'cached title',
        subagentCatalog: catalog === 'empty' ? [] : [{ id: 'cached-child', createdAt: 2, mode: 'one-shot', label: 'cached child' }],
      },
    })
    expect(list).not.toHaveBeenCalled()
    expect(await readFile(cache.path, 'utf8')).toBe(cache.bytes)
  })

  it('serves other cached hints without inventing a missing catalog', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('title-parent'), {}, 3)
    await stored(fixture, SessionId('title-child'), { origin: 'subagent', parentSession: parent.header.id })
    const cache = await seedCache(fixture, parent.header, 'absent')
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal)).resolves.toEqual({
      kind: 'migration-required',
      values: { title: 'cached title' },
    })
    expect(fixture.ctx.sessionProjectionCache.cachedSnapshot(parent.header)?.values).toEqual({ title: 'cached title' })
    expect(await readFile(cache.path, 'utf8')).toBe(cache.bytes)
  })

  it('returns no hints from an unrelated cache identity', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('recreated-parent'), {}, 3)
    await seedCache(fixture, parent.header, 'child', false)
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal)).resolves.toEqual({
      kind: 'migration-required', values: {},
    })
  })

  it.each([true, false])('returns null for an absent Session (persistence mounted: %s)', async (withPersistence) => {
    const fixture = await harness(withPersistence)
    const list = vi.spyOn(fixture.ctx.sessionQuery, 'listSessions')
    await expect(fixture.controller.projections({ sessionId: SessionId('missing') }, new AbortController().signal)).resolves.toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('reads a current-format cold catalog from disk when its cache is absent', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('current-cold'))
    const event = {
      type: 'subagent/catalog', seq: 0, time: 1,
      data: { version: 1, childId: 'current-child', childCreatedAt: 2, mode: 'continuable', label: 'worker' },
    }
    await writeFile(parent.path, `${parent.bytes}${JSON.stringify(event)}\n`)
    const open = vi.spyOn(fixture.ctx.sessionPersistence, 'open')
    const observe = vi.spyOn(fixture.ctx.sessionQuery, 'observeSession')
    const signal = new AbortController().signal

    await expect(fixture.controller.projections({ sessionId: parent.header.id }, signal)).resolves.toMatchObject({
      kind: 'sequenced', asOfSeq: 0,
      values: { subagentCatalog: [{ id: 'current-child', mode: 'continuable', label: 'worker' }] },
    })
    expect(observe).toHaveBeenCalledWith(parent.header.id, { signal })
    expect(open).toHaveBeenCalledWith(parent.header.id, 'read', { signal })
    expect(fixture.ctx.sessions.get(parent.header.id)).toBeUndefined()
    expect(fixture.ctx.agents.get(parent.header.id)).toBeUndefined()
  })

  it('reports read-prepared historical files as migration-required until a successor is published', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('prepared-cold'), {}, 3)
    const observation = await fixture.ctx.sessionQuery.observeSession(parent.header.id)
    observation[Symbol.dispose]()
    const open = vi.spyOn(fixture.ctx.sessionPersistence, 'open').mockRejectedValue(new Error('unexpected body reread'))

    expect(await fixture.ctx.sessionPersistence.stat(parent.header.id)).toMatchObject({
      formatStatus: 'migration-required',
    })
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal))
      .resolves.toEqual({ kind: 'migration-required', values: {} })
    expect(open).not.toHaveBeenCalled()
    expect(fixture.ctx.sessions.get(parent.header.id)).toBeUndefined()
    expect(await readFile(parent.path, 'utf8')).toBe(parent.bytes)
    expect(await readdir(dirname(parent.path))).toEqual(['session.v3.jsonl'])
  })

  it('reads sequenced projections after write publication replaces the disk format status', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('published-cold'), {}, 3)
    using observation = await fixture.ctx.sessionQuery.observeSession(parent.header.id)
    const expected = observation.projections
    const signal = new AbortController().signal
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, signal))
      .resolves.toEqual({ kind: 'migration-required', values: {} })

    const writer = await fixture.ctx.sessionPersistence.open(parent.header.id, 'write')
    try {
      await writer.flush()
    } finally {
      await writer.close()
    }

    expect(await fixture.ctx.sessionPersistence.stat(parent.header.id)).toMatchObject({
      formatStatus: 'current',
    })
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, signal))
      .resolves.toEqual({ kind: 'sequenced', ...expected })
    expect(fixture.ctx.sessions.get(parent.header.id)).toBeUndefined()
    expect(await readFile(parent.path, 'utf8')).toBe(parent.bytes)
    // POSIX retains the write-lock inode after close; Windows uses a semaphore.
    expect((await readdir(dirname(parent.path))).filter(name => name !== 'session.lock').sort())
      .toEqual(['session.v3.jsonl', `session.v${SESSION_FORMAT_VERSION}.jsonl`].sort())
  })

  it('reports unsupported current-format events instead of deferring migration', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('corrupt-current'))
    await writeFile(parent.path, `${parent.bytes}${JSON.stringify({ type: 'missing/plugin-event', seq: 0, time: 1, data: {} })}\n`)
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('reports unavailable projections from an otherwise readable observation', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('without-projections'))
    using source = await fixture.ctx.sessionQuery.observeSession(parent.header.id)
    const { projections: _projections, ...observation } = source
    vi.spyOn(fixture.ctx.sessionQuery, 'observeSession').mockResolvedValueOnce(observation)

    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/projections-unavailable' })
  })

  it.each([false, true])('rechecks live history when the stored source disappears after preflight (attached: %s)', async (attached) => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('missing-after-preflight'))
    const snapshot = await fixture.ctx.sessionPersistence.stat(parent.header.id)
    vi.spyOn(fixture.ctx.sessionPersistence, 'stat')
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => {
        if (attached) fixture.ctx.sessions.create(parent.header.id, { meta: parent.header })
        return Promise.resolve(undefined)
      })

    const result = await fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal)
    expect(result).toEqual(attached
      ? { kind: 'sequenced', ...fixture.ctx.sessionProjections.snapshot(fixture.ctx.sessions.get(parent.header.id)!) }
      : null)
  })

  it('serves the live registry cut instead of a conflicting cached hint', async () => {
    const fixture = await harness()
    const live = fixture.ctx.sessions.create(SessionId('live'), { meta: { cwd: fixture.root } })
    live.append('turn/start', { turn: 1 })
    const expected = fixture.ctx.sessionProjections.snapshot(live)
    await seedCache(fixture, live.header, 'child')
    const cached = vi.spyOn(fixture.ctx.sessionProjectionCache, 'cachedSnapshot')
    const stat = vi.spyOn(fixture.ctx.sessionPersistence, 'stat').mockRejectedValue(new Error('metadata unavailable'))
    await expect(fixture.controller.projections({ sessionId: live.id }, new AbortController().signal)).resolves.toEqual({
      kind: 'sequenced', ...expected,
    })
    expect(stat).not.toHaveBeenCalled()
    expect(cached).not.toHaveBeenCalled()
  })

  it.each([true, false])('prefers a Session attached during stat (stored header present: %s)', async (present) => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('stat-race'), {}, 3)
    const snapshot = await fixture.ctx.sessionPersistence.stat(parent.header.id)
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<SessionPersistenceSnapshot | undefined>()
    vi.spyOn(fixture.ctx.sessionPersistence, 'stat').mockImplementation(() => {
      entered.resolve(undefined)
      return finish.promise
    })
    const operation = fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal)
    try {
      await entered.promise
      const live = fixture.ctx.sessions.create(parent.header.id, { meta: parent.header })
      live.append('turn/start', { turn: 1 })
      finish.resolve(present ? snapshot : undefined)
      await expect(operation).resolves.toEqual({ kind: 'sequenced', ...fixture.ctx.sessionProjections.snapshot(live) })
    } finally {
      finish.resolve(undefined)
      await Promise.allSettled([operation])
    }
  })

  it('reports target metadata I/O failures instead of an empty result', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('failed-metadata'))
    const failure = new Error('target metadata unavailable')
    vi.spyOn(fixture.ctx.sessionPersistence, 'stat').mockRejectedValue(failure)
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/internal', cause: failure })
  })

  it('honors cancellation while waiting for target metadata', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('cancelled-metadata'))
    const snapshot = await fixture.ctx.sessionPersistence.stat(parent.header.id)
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    vi.spyOn(fixture.ctx.sessionPersistence, 'stat').mockImplementation(async () => {
      entered.resolve(undefined)
      await finish.promise
      return snapshot
    })
    const abort = new AbortController()
    const operation = fixture.controller.projections({ sessionId: parent.header.id }, abort.signal)
    try {
      await entered.promise
      abort.abort(new Error('cancelled by caller'))
      finish.resolve(undefined)
      await expect(operation).rejects.toMatchObject({ code: 'gateway/cancelled' })
    } finally {
      finish.resolve(undefined)
      await Promise.allSettled([operation])
    }
  })

  it('rejects an already-cancelled read before metadata access', async () => {
    const fixture = await harness()
    const stat = vi.spyOn(fixture.ctx.sessionPersistence, 'stat')
    await expect(fixture.controller.projections({ sessionId: SessionId('cancelled') }, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(stat).not.toHaveBeenCalled()
  })

  it('preserves Remote failures while reading the migration cache metadata', async () => {
    const fixture = await harness()
    const parent = await stored(fixture, SessionId('typed-failures'), {}, 3)
    const failure = new RemoteError('gateway/internal', 'metadata failure', {})
    vi.spyOn(fixture.ctx.sessionPersistence, 'stat').mockRejectedValueOnce(failure)
    await expect(fixture.controller.projections({ sessionId: parent.header.id }, new AbortController().signal)).rejects.toBe(failure)
  })

  it('rejects an empty identity without querying metadata', async () => {
    const fixture = await harness()
    const stat = vi.spyOn(fixture.ctx.sessionPersistence, 'stat')
    await expect(fixture.controller.projections({ sessionId: SessionId('') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(stat).not.toHaveBeenCalled()
  })
})
