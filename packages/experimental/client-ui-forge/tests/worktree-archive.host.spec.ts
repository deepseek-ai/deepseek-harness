import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { appendPluginRecord, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchPage, SessionSearchPage, SessionSearchHit } from '@deepseek-ai/dsh-session-query'
import TerminalService, { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ForgePanelController from '../src/index.ts'
import { WorktreeArchives } from '../src/worktree-archive.ts'
import { forgeWorktreeRetentionProjection, WORKTREE_RECORD } from '../src/worktree.ts'
import { repository, runtime, scratch, testAgent } from './harness.ts'

/** Archive tests only use the query service's live and persisted observation APIs. */
class ArchiveQueries extends SessionQueryEngine {
  searchSessions(): Promise<SessionSearchPage<SessionSearchHit>> { throw new Error('search is not used') }
  searchEvents(): Promise<SessionEventSearchPage> { throw new Error('search is not used') }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture() {
  const temporary = await scratch('archive-worktree-')
  cleanups.push(temporary.remove)
  const root = await repository(temporary.path)
  const f = await runtime(root, { worktrees: true })
  cleanups.push(() => f.ctx.fiber.dispose())
  const ctx = f.ctx
  await ctx.plugin(SessionPersistence, { root: join(temporary.path, 'sessions'), compression: 'none' })
  await ctx.plugin(ArchiveQueries)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  await ctx.plugin(WorkspaceRegistry)
  const retention = await ctx.sessionProjections.register(forgeWorktreeRetentionProjection)
  const archives = new WorktreeArchives(ctx, retention)
  appendPluginRecord(f.session, WORKTREE_RECORD, { action: 'request', from: null })
  const worktree = { ...await ctx.worktrees.create(f.agent, { name: 'archive-ui' }), from: null }
  appendPluginRecord(f.session, WORKTREE_RECORD, { action: 'created', worktree })
  return { ...f, root, worktree, archives, retention }
}

async function completed(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await f.archives.result(f.session, null)
  return first === null ? null : await f.archives.result(f.session, first.revision)
}

describe('UI worktree archive cleanup', () => {
  it('cleans a UI checkout after the Session moved elsewhere and blocks implicit fallback on restore', async () => {
    const f = await fixture()
    await f.ctx.workingDirectory.set(f.agent, f.root)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toMatchObject({ status: 'removed' })
    await expect(access(f.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await f.ctx.worktrees.restore(f.agent, f.worktree)
    await f.ctx.workingDirectory.set(f.agent, f.worktree.path)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toMatchObject({ status: 'removed' })
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await expect(f.ctx.workingDirectory.ensure(f.agent)).rejects.toThrow('restore it')
    expect(f.ctx.workingDirectory.get(f.session)).toBe(f.worktree.path)
  })

  it('retains a shared checkout until the last fork archives, without transferring creation ownership', async () => {
    const f = await fixture()
    using observation = await f.ctx.sessionQuery.observeSession(f.session.id)
    const fork = f.ctx.sessions.create(SessionId('archive-fork'), {
      seed: observation.events, inheritedEventCount: SessionLogOffset(observation.events.length),
      meta: { cwd: f.root, isSeeded: true },
    })
    const agent = testAgent(f.ctx, fork)
    await f.ctx.agents.register(agent)
    expect(f.retention.stateOf(f.session).owned).toBe(true)
    expect(f.retention.stateOf(fork).owned).toBe(false)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toBeNull()
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.archiveSession(fork.id)
    const first = await f.archives.result(fork, null)
    expect(first).not.toBeNull()
    expect(await f.archives.result(fork, first!.revision)).toMatchObject({ status: 'removed' })
  })

  it('silently retains untracked files and never cleans a tool-only worktree', async () => {
    const f = await fixture()
    await writeFile(join(f.worktree.path, 'keep.txt'), 'keep')
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toBeNull()
    await access(f.worktree.path)
    const other = f.ctx.sessions.create(SessionId('tool-created'), { meta: { cwd: f.root } })
    const agent = testAgent(f.ctx, other)
    await f.ctx.agents.register(agent)
    const worktree = await f.ctx.worktrees.create(agent, { name: 'tool-only' })
    await f.ctx.workspaceRegistry.archiveSession(other.id)
    expect(await f.archives.result(other, null)).toBeNull()
    await access(worktree.path)
  })

  it('retains the checkout until cancelled work actually stops', async () => {
    const f = await fixture()
    f.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'turn' }, ...await next()])
    await f.ctx.workspaceRegistry.archiveSession(f.session.id, { stopActivity: true })
    expect(await completed(f)).toBeNull()
    await access(f.worktree.path)
  })

  it('keeps archival successful and reports a failed removal', async () => {
    const f = await fixture()
    const warning = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(f.ctx.worktrees, 'remove').mockRejectedValue(new Error('checkout removal denied'))
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toMatchObject({ status: 'failed' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    expect(warning).toHaveBeenCalled()
    await access(f.worktree.path)
  })

  it('cancels queued deletion before letting the Session resume', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remove = f.ctx.worktrees.remove.bind(f.ctx.worktrees)
    vi.spyOn(f.ctx.worktrees, 'remove').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return await remove(...args)
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const unarchive = f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    release.resolve(undefined)
    await unarchive
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(f.session.id)
    expect(await f.ctx.workingDirectory.ensure(f.agent)).toBe(f.worktree.path)
    await access(f.worktree.path)
  })

  it('cleans a persisted UI checkout without loading its Agent', async () => {
    const f = await fixture()
    const id = SessionId('cold-archive-owner')
    const session = Session.create(id, [], { ...f.session.header, id })
    const agent = testAgent(f.ctx, session)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
    const worktree = { ...await f.ctx.worktrees.create(agent, { name: 'cold-ui' }), from: null }
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree })
    await using writer = await f.ctx.sessionPersistence.create(session.header)
    await writer.append(session.snapshotEvents())
    await writer.flush()
    await writer.close()
    expect(f.ctx.sessions.get(id)).toBeUndefined()
    await f.ctx.workspaceRegistry.archiveSession(id)
    const status = await f.archives.result(session, null)
    expect(status).not.toBeNull()
    expect(await f.archives.result(session, status!.revision)).toMatchObject({ status: 'removed' })
    expect(f.ctx.sessions.get(id)).toBeUndefined()
    expect(f.ctx.agents.list().some(item => item.session.id === id)).toBe(false)
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconsiders cleanup when a Session that entered the checkout by directory is archived last', async () => {
    const f = await fixture()
    const other = f.ctx.sessions.create(SessionId('directory-user'), { meta: { cwd: f.worktree.path } })
    const agent = testAgent(f.ctx, other)
    await f.ctx.agents.register(agent)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toBeNull()
    await f.ctx.workspaceRegistry.archiveSession(other.id)
    const status = await f.archives.result(other, null)
    expect(status).not.toBeNull()
    expect(await f.archives.result(other, status!.revision)).toMatchObject({ status: 'removed' })
  })


  it('retains a worktree during restoration or under its creator’s read-only policy', async () => {
    const f = await fixture()
    appendPluginRecord(f.session, WORKTREE_RECORD, { action: 'restoring' })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toBeNull()
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    appendPluginRecord(f.session, WORKTREE_RECORD, { action: 'restored' })
    f.session.append('sandbox/mode', { mode: 'read-only' })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toBeNull()
    await access(f.worktree.path)
  })

  it.each(['job', 'terminal'] as const)('retains a checkout when a %s can still use its old directory', async (kind) => {
    const f = await fixture()
    if (kind === 'job') f.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'job' }, ...await next()])
    else {
      await f.ctx.plugin(TerminalService)
      vi.spyOn(f.ctx.terminals, 'list').mockReturnValue([{ sessionId: TerminalSessionId('persistent'), type: 'shell', status: { kind: 'running' } }])
    }
    await f.ctx.workspaceRegistry.archiveSession(f.session.id, { stopActivity: true })
    expect(await completed(f)).toBeNull()
    await access(f.worktree.path)
  })

  it('retains a checkout on uncertain inspection and still allows unarchive when the log becomes unreadable', async () => {
    const f = await fixture()
    const warning = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(f.ctx.worktrees, 'canRemove').mockRejectedValueOnce(new Error('Git unavailable'))
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toBeNull()
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toMatchObject({ status: 'removed' })
    vi.spyOn(f.ctx.sessionQuery, 'inspectSession').mockRejectedValueOnce(new Error('log unavailable'))
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(f.session.id)
    expect(warning).toHaveBeenCalledTimes(2)
  })

  it('rechecks references acquired after the eligible inspection', async () => {
    const f = await fixture()
    const inspect = f.ctx.worktrees.canRemove.bind(f.ctx.worktrees)
    vi.spyOn(f.ctx.worktrees, 'canRemove').mockImplementationOnce(async (...args) => {
      const eligible = await inspect(...args)
      f.ctx.sessions.create(SessionId('arriving-reference'), { meta: { cwd: f.worktree.path } })
      return eligible
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toMatchObject({ status: 'retained' })
    expect(await f.archives.result(f.session, -1)).toBeNull()
    await access(f.worktree.path)
  })

  it('retains a checkout for a live user that appeared after corpus listing', async () => {
    const f = await fixture()
    const list = f.ctx.sessionQuery.listSessions.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'listSessions').mockImplementationOnce(async (...args) => {
      const records = await list(...args)
      const late = f.ctx.sessions.create(SessionId('late-live-user'), { meta: { cwd: f.worktree.path } })
      await f.ctx.agents.register(testAgent(f.ctx, late))
      return records
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toBeNull()
    await access(f.worktree.path)
  })

  it('does not infer ownership from a fork whose creator is absent', async () => {
    const f = await fixture()
    const worktree = { ...await f.ctx.worktrees.create(f.agent, { name: 'missing-owner' }), from: null }
    await f.ctx.workingDirectory.set(f.agent, f.root)
    const source = Session.create(SessionId('absent-owner'), [], { ...f.session.header, id: SessionId('absent-owner') })
    appendPluginRecord(source, WORKTREE_RECORD, { action: 'request', from: null })
    source.append('working-directory/change', { cwd: worktree.path })
    appendPluginRecord(source, WORKTREE_RECORD, { action: 'created', worktree })
    const seed = source.snapshotEvents()
    const fork = f.ctx.sessions.create(SessionId('orphan-fork'), { seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root } })
    await f.ctx.workspaceRegistry.archiveSession(fork.id)
    expect(await f.archives.result(fork, null)).toBeNull()
    await access(worktree.path)
  })

  it('does not cancel an unrelated cleanup when another Session is unarchived', async () => {
    const f = await fixture()
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await completed(f)).toMatchObject({ status: 'removed' })
    const other = f.ctx.sessions.create(SessionId('unrelated'), { meta: { cwd: f.root } })
    await f.ctx.workspaceRegistry.archiveSession(other.id)
    await f.ctx.workspaceRegistry.unarchiveSession(other.id)
    const blank = f.ctx.sessions.create(SessionId('without-directory'))
    await f.ctx.workspaceRegistry.archiveSession(blank.id)
    await f.ctx.workspaceRegistry.unarchiveSession(blank.id)
    expect(await completed(f)).toMatchObject({ status: 'removed' })
  })

  it('drains an admitted cleanup on disposal and withdraws its pending result', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(f.ctx.worktrees, 'remove').mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
      return false
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const status = await f.archives.result(f.session, null)
    const result = f.archives.result(f.session, status!.revision)
    const disposal = f.archives.dispose()
    release.resolve(undefined)
    await disposal
    expect(await result).toBeNull()
    await access(f.worktree.path)
  })


  it('mounts archive cleanup with its optional providers and serves the Remote result', async () => {
    const f = await fixture()
    await f.archives.dispose()
    const mounted = await f.ctx.plugin(ForgePanelController, {})
    const controller = f.ctx.forgePanel
    expect(await controller.worktreeCleanup(f.session, null)).toBeNull()
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    const status = await controller.worktreeCleanup(f.session, null)
    expect(status).not.toBeNull()
    expect(await controller.worktreeCleanup(f.session, status!.revision)).toMatchObject({ status: 'removed' })
    await mounted.dispose()
    expect(await controller.worktreeCleanup(f.session, null)).toBeNull()
  })

})
