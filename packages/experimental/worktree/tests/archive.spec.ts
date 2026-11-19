import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ConfinedArgv, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { appendPluginRecord, type SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchPage, SessionSearchHit, SessionSearchPage } from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import type {} from '../src/archive.ts'
import WorktreeService, { CREATED_RECORD, worktreeProjection } from '../src/index.ts'
import { ENTERED_RECORD } from '../src/projection.ts'
import type { WorktreeCleanup } from '../src/index.ts'
import * as removal from '../src/removal.ts'
import { git, repository, UnusedSandbox } from './harness.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { brandString } from '@deepseek-ai/dsh-brand'

/** Archive tests only use the query service's listing and observation APIs. */
class ArchiveQueries extends SessionQueryEngine {
  searchSessions(): Promise<SessionSearchPage<SessionSearchHit>> { throw new Error('search is not used') }
  searchEvents(): Promise<SessionEventSearchPage> { throw new Error('search is not used') }
}

vi.mock('../src/removal.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/removal.ts')>()
  return { ...actual, removeCheckout: vi.fn(actual.removeCheckout) }
})

const removeCheckout = vi.mocked(removal.removeCheckout)
/** The unmocked removal step, for interceptors that delay or observe it. */
const actualRemoveCheckout = (await vi.importActual<typeof import('../src/removal.ts')>('../src/removal.ts')).removeCheckout

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeCheckout.mockReset()
  removeCheckout.mockImplementation(actualRemoveCheckout)
  vi.restoreAllMocks()
})

function agentFor(ctx: Context, session: Session): Agent {
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, session, options: {}, status: 'idle', ctx: scope.ctx, model: unsupportedModel(),
    inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  return agent
}

async function fixture(options: {
  cache?: boolean
  retainOnArchive?: boolean
  maxOutputBytes?: number
  mode?: SandboxMode
  /** Point the deployment's default directory inside the checkout the fixture creates. */
  defaultInWorktree?: boolean
} = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-archive-')))
  cleanups.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await repository(temporary)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(UnusedSandbox)
  // A confined default records each policy and runs the command unconfined.
  const confine = vi.spyOn(ctx.sandbox, 'confine')
  if (options.mode !== undefined) confine.mockImplementation(async argv => ({ argv: [...argv] }) as ConfinedArgv)
  await ctx.plugin(SandboxPolicyService, { mode: options.mode ?? 'danger-full-access', workspaceRoot: root })
  await ctx.plugin(WorkingDirectoryService, options.defaultInWorktree === true
    ? { defaultDirectory: join(root, '.agents', 'worktrees', 'archive-me') }
    : {})
  await ctx.plugin(SessionPersistence, { root: join(temporary, 'sessions'), compression: 'none' })
  await ctx.plugin(ArchiveQueries)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  if (options.cache === true) await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1_000, writeIntervalMs: 60_000 })
  await ctx.plugin(WorkspaceRegistry)
  const { cache: _cache, mode: _mode, defaultInWorktree: _defaultInWorktree, ...config } = options
  const worktrees = ctx.plugin(WorktreeService, config)
  await worktrees
  const session = ctx.sessions.create(brandString<SessionId>('archive-owner'), { meta: { cwd: root } })
  const agent = agentFor(ctx, session)
  await ctx.agents.register(agent)
  const worktree = await ctx.worktrees.create(agent, { name: 'archive-me' })
  return { ctx, root, session, agent, worktree, temporary, worktrees, confine }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** The settled attempt of `session`, or null when the service registered none. */
async function settled(f: Fixture, session: Session = f.session): Promise<WorktreeCleanup | null> {
  const scheduled = await f.ctx.worktrees.cleanupOf(session.id, null)
  return scheduled === null ? null : await f.ctx.worktrees.cleanupOf(session.id, scheduled.revision)
}

async function persisted(f: Fixture, session: Session): Promise<void> {
  const inherited = session.inheritedEventCount
  await using writer = await f.ctx.sessionPersistence.create(session.header, inherited === 0 ? {} : { inheritedEventCount: inherited })
  await writer.append(session.snapshotEvents())
  await writer.flush()
  await writer.close()
}

/** A live Session whose store entry the test detaches itself, leaving only its persisted log. */
function detachable(
  f: Fixture, id: string, meta: { cwd?: string; isSeeded?: boolean }, fork?: Session,
): { session: Session; detach: () => void } {
  const seed = fork?.snapshotEvents()
  const session = f.ctx.sessions.prepare(brandString<SessionId>(id), {
    meta, ...seed === undefined ? {} : { seed, inheritedEventCount: SessionLogOffset(seed.length) },
  })
  const detach = f.ctx.sessions.enter(session)
  f.ctx.sessions.announce(session)
  return { session, detach }
}

/**
 * A Session that created a checkout, optionally recorded a sandbox mode, and
 * went cold: persisted, its Agent unregistered, and its store entry detached.
 */
async function coldCreator(f: Fixture, id: string, options: { mode?: SandboxMode; cache?: boolean } = {}) {
  const owner = detachable(f, id, { cwd: f.root })
  const agent = agentFor(f.ctx, owner.session)
  const registration = f.ctx.agents.register(agent)
  await registration
  const worktree = await f.ctx.worktrees.create(agent, { name: id })
  if (options.mode !== undefined) owner.session.append('sandbox/mode', { mode: options.mode })
  if (options.cache === true) await f.ctx.sessionProjectionCache.write(owner.session)
  await persisted(f, owner.session)
  await registration()
  owner.detach()
  expect(f.ctx.sessions.get(owner.session.id)).toBeUndefined()
  return { session: owner.session, worktree }
}

describe('archive-triggered worktree cleanup', () => {
  it('removes the clean checkout the archived Session created and keeps its branch and commits', async () => {
    const f = await fixture()
    await writeFile(join(f.worktree.path, 'local.txt'), 'not pushed\n')
    await git(f.worktree.path, 'add', 'local.txt')
    await git(f.worktree.path, 'commit', '-m', 'local commit')
    const head = await git(f.worktree.path, 'rev-parse', 'HEAD')
    const statuses: WorktreeCleanup['status'][] = []
    f.ctx.on('worktree/cleanup', ({ cleanup }) => { statuses.push(cleanup.status) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session.id, null)).toMatchObject({ status: 'scheduled' })
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    expect(statuses).toEqual(['scheduled', 'removed'])
    await expect(access(f.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(f.root, 'rev-parse', f.worktree.branch)).toBe(head)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    // The creator's root is the checkout being removed.
    expect(f.ctx.workingDirectory.get(f.session)).toBe(f.worktree.path)
  })

  it('removes a clean checkout whose file listing exceeds maxOutputBytes', async () => {
    const f = await fixture({ maxOutputBytes: 1_024 })
    for (let index = 0; index < 64; index++) {
      await writeFile(join(f.worktree.path, `file-${String(index).padStart(3, '0')}-${'x'.repeat(24)}.txt`), `${index}\n`)
    }
    await git(f.worktree.path, 'add', '.')
    await git(f.worktree.path, 'commit', '-m', 'many files')
    expect((await git(f.worktree.path, 'ls-files', '-z')).length).toBeGreaterThan(1_024)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await expect(access(f.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a checkout whose status output exceeds maxOutputBytes instead of failing', async () => {
    const f = await fixture({ maxOutputBytes: 1_024 })
    for (let index = 0; index < 64; index++) {
      await writeFile(join(f.worktree.path, `untracked-${String(index).padStart(3, '0')}-${'x'.repeat(24)}.txt`), `${index}\n`)
    }
    expect((await git(f.worktree.path, 'status', '--porcelain', '-z', '--untracked-files=all')).length).toBeGreaterThan(1_024)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(join(f.worktree.path, 'untracked-000-xxxxxxxxxxxxxxxxxxxxxxxx.txt'))
  })

  it('removes a clean checkout when the worktree listing exceeds maxOutputBytes', async () => {
    const f = await fixture({ maxOutputBytes: 1_024 })
    for (let index = 0; index < 8; index++) await git(f.root, 'worktree', 'add', '--detach', join(f.temporary, `extra-${index}`))
    expect((await git(f.root, 'worktree', 'list', '--porcelain', '-z')).length).toBeGreaterThan(1_024)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await expect(access(f.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns from admission before the inspection runs', async () => {
    const f = await fixture()
    const release = Promise.withResolvers<undefined>()
    const list = f.ctx.sessionQuery.listSessions.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'listSessions').mockImplementation(async (...args) => {
      await release.promise
      return await list(...args)
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session.id, null)).toMatchObject({ status: 'scheduled' })
    release.resolve(undefined)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('removes the checkout after the Session moved elsewhere, and the ordinary ensure contract holds afterwards', async () => {
    const f = await fixture()
    await f.ctx.workingDirectory.set(f.agent, f.root)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await f.ctx.worktrees.restore(f.agent, f.worktree)
    await f.ctx.workingDirectory.set(f.agent, f.worktree.path)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    // The directory is gone: ensure recovers the original project as it documents, with no cleanup-specific failure.
    expect(await f.ctx.workingDirectory.ensure(f.agent)).toBe(f.root)
  })

  it('retains an untracked file but not ignored files', async () => {
    const f = await fixture()
    await writeFile(join(f.worktree.path, 'keep.txt'), 'keep')
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await rm(join(f.worktree.path, 'keep.txt'))
    await git(f.worktree.path, 'config', 'core.excludesFile', join(f.root, 'exclude'))
    await writeFile(join(f.root, 'exclude'), '.env\n')
    await writeFile(join(f.worktree.path, '.env'), 'private fixture')
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('registers nothing for a Session that created no checkout or only inherited one', async () => {
    const f = await fixture()
    const other = f.ctx.sessions.create(brandString<SessionId>('no-checkout'), { meta: { cwd: f.root } })
    await f.ctx.workspaceRegistry.archiveSession(other.id)
    expect(await f.ctx.worktrees.cleanupOf(other.id, null)).toBeNull()
    const seed = f.session.snapshotEvents()
    const fork = f.ctx.sessions.create(brandString<SessionId>('fork'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root },
    })
    await f.ctx.workspaceRegistry.archiveSession(fork.id)
    expect(await f.ctx.worktrees.cleanupOf(fork.id, null)).toBeNull()
    await access(f.worktree.path)
  })

  it('retains a checkout while a fork or a directory borrower is unarchived, and does not reconsider when they archive', async () => {
    const f = await fixture()
    const seed = f.session.snapshotEvents()
    const fork = f.ctx.sessions.create(brandString<SessionId>('fork'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root },
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.archiveSession(fork.id)
    expect(await f.ctx.worktrees.cleanupOf(fork.id, null)).toBeNull()
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    const borrower = f.ctx.sessions.create(brandString<SessionId>('borrower'), { meta: { cwd: f.worktree.path } })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await f.ctx.workspaceRegistry.archiveSession(borrower.id)
    await access(f.worktree.path)
  })

  it('treats a subagent child beneath the archived Session as archived', async () => {
    const f = await fixture()
    const child = f.ctx.sessions.create(brandString<SessionId>('child'), {
      meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: f.session.id },
    })
    const grandchild = f.ctx.sessions.create(brandString<SessionId>('grandchild'), {
      meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: child.id },
    })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(child.id)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(grandchild.id)
  })

  it('retains a checkout for an unrelated subagent child that works inside it', async () => {
    const f = await fixture()
    const other = f.ctx.sessions.create(brandString<SessionId>('other-parent'), { meta: { cwd: f.root } })
    f.ctx.sessions.create(brandString<SessionId>('other-child'), { meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: other.id } })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
  })

  it.each([
    ['its log', false],
    ['the projection cache', true],
  ])('removes a cold creator\'s checkout through one observation from %s without attaching it', async (_source, cache) => {
    const f = await fixture({ cache })
    const owner = await coldCreator(f, 'cold-owner', { cache })
    const bystander = detachable(f, 'cold-bystander', { cwd: f.root })
    if (cache) await f.ctx.sessionProjectionCache.write(bystander.session)
    await persisted(f, bystander.session)
    bystander.detach()
    const attached: SessionId[] = []
    f.ctx.on('session/created', (session) => { attached.push(session.id) })
    f.ctx.on('worktree/cleanup', () => { attached.push(...f.ctx.sessions.get(owner.session.id) === undefined ? [] : [owner.session.id]) })
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    await f.ctx.workspaceRegistry.archiveSession(owner.session.id)
    expect(await settled(f, owner.session)).toMatchObject({ status: 'removed' })
    // The creator is observed once for its creations. An uncached bystander is observed once by the
    // eligibility check and once by the locked recheck; a cached one never is.
    const reads = cache ? [] : Array<SessionId>(2).fill(bystander.session.id)
    expect(observe.mock.calls.map(call => call[0])).toEqual([owner.session.id, ...reads])
    expect(attached).toEqual([])
    expect(f.ctx.sessions.get(owner.session.id)).toBeUndefined()
    expect(f.ctx.agents.list().some(agent => agent.session.id === owner.session.id)).toBe(false)
    await expect(access(owner.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['a live', false],
    ['a cold', true],
  ])('removes %s creator\'s checkout unconfined even under a recorded read-only mode and a confined default', async (_kind, cold) => {
    const f = await fixture({ mode: 'read-only' })
    if (!cold) f.session.append('sandbox/mode', { mode: 'read-only' })
    const owner = cold ? await coldCreator(f, 'cold-read-only', { mode: 'read-only' }) : f
    f.confine.mockClear()
    await f.ctx.workspaceRegistry.archiveSession(owner.session.id)
    expect(await settled(f, owner.session)).toMatchObject({ status: 'removed' })
    expect(f.confine).not.toHaveBeenCalled()
    await expect(access(owner.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a checkout while a cold fork still carries its creation', async () => {
    const f = await fixture()
    const fork = detachable(f, 'cold-fork', { cwd: f.root, isSeeded: true }, f.session)
    await persisted(f, fork.session)
    fork.detach()
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    await access(f.worktree.path)
  })

  it('retains a checkout while a live fork that moved elsewhere still carries its creation', async () => {
    const f = await fixture()
    const seed = f.session.snapshotEvents()
    const fork = f.ctx.sessions.create(brandString<SessionId>('fork-elsewhere'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, cwd: f.root },
    })
    const agent = agentFor(f.ctx, fork)
    await f.ctx.agents.register(agent)
    await f.ctx.workingDirectory.set(agent, f.root)
    expect(f.ctx.workingDirectory.get(fork)).toBe(f.root)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    expect(removeCheckout).not.toHaveBeenCalled()
  })

  it.each([
    ['cached', true],
    ['uncached', false],
  ])('treats a %s cold Session that recorded no directory as working nowhere, not in the default directory', async (_source, cache) => {
    // The default directory lies inside the checkout, so reading it for an unrecorded directory would retain the checkout.
    const f = await fixture({ cache, defaultInWorktree: true })
    expect(f.ctx.workingDirectory.defaultDirectory).toBe(f.worktree.path)
    const nowhere = detachable(f, 'cold-nowhere', {})
    if (cache) await f.ctx.sessionProjectionCache.write(nowhere.session)
    await persisted(f, nowhere.session)
    nowhere.detach()
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('reads a cold Session from its log without the cache', async () => {
    const f = await fixture()
    const borrower = detachable(f, 'cold-borrower', { cwd: f.worktree.path })
    await persisted(f, borrower.session)
    borrower.detach()
    expect(f.ctx.sessions.get(borrower.session.id)).toBeUndefined()
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
  })

  it('does not wait for the archived Session\'s own stopping work', async () => {
    const f = await fixture()
    f.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'turn' }, ...await next()])
    await f.ctx.workspaceRegistry.archiveSession(f.session.id, { stopActivity: true })
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('keeps the archive and reports a failed removal', async () => {
    const f = await fixture()
    const warning = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    removeCheckout.mockRejectedValue(new Error('checkout removal denied'))
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'failed' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    expect(warning).toHaveBeenCalledOnce()
    await access(f.worktree.path)
  })

  it('cancels an unadmitted removal on unarchive and waits for an admitted one', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    removeCheckout.mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return await actualRemoveCheckout(...args)
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const unarchive = f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(f.session.id)
    release.resolve(undefined)
    await unarchive
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session.id, null)).toBeNull()
    await access(f.worktree.path)
    expect(await f.ctx.workingDirectory.ensure(f.agent)).toBe(f.worktree.path)
  })

  it('holds directory entry into a checkout being removed and leaves other paths alone', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    removeCheckout.mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return await actualRemoveCheckout(...args)
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workingDirectory.set(f.agent, f.root)
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const other = f.ctx.sessions.create(brandString<SessionId>('elsewhere'), { meta: { cwd: f.root } })
    const otherAgent = agentFor(f.ctx, other)
    await f.ctx.agents.register(otherAgent)
    expect(await f.ctx.workingDirectory.ensure(otherAgent)).toBe(f.root)
    let settledEntry = false
    const entering = f.ctx.workingDirectory.set(otherAgent, f.worktree.path)
      .then(() => { settledEntry = true }, () => { settledEntry = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settledEntry).toBe(false)
    release.resolve(undefined)
    await entering
    expect(await settled(f)).toMatchObject({ status: 'removed' })
    // Entry ran after removal, against a directory that no longer exists.
    expect(f.ctx.workingDirectory.get(other)).toBe(f.root)
  })

  it('registers nothing for a cold Session without creations and ignores an unarchive without an attempt', async () => {
    const f = await fixture()
    const cold = detachable(f, 'cold-empty', { cwd: f.root })
    await persisted(f, cold.session)
    cold.detach()
    await f.ctx.workspaceRegistry.archiveSession(cold.session.id)
    // A cold Session's creations are only known once its log or cache was read, so the placeholder settles to nothing.
    expect(await settled(f, cold.session)).toBeNull()
    expect(await f.ctx.worktrees.cleanupOf(cold.session.id, null)).toBeNull()
    await f.ctx.workspaceRegistry.unarchiveSession(cold.session.id)
    expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(cold.session.id)
  })

  it('retains a checkout for a borrower that appeared between the eligible inspection and the locked recheck', async () => {
    const f = await fixture()
    const list = f.ctx.sessionQuery.listSessions.bind(f.ctx.sessionQuery)
    vi.spyOn(f.ctx.sessionQuery, 'listSessions').mockImplementationOnce(async (...args) => {
      const records = await list(...args)
      f.ctx.sessions.create(brandString<SessionId>('late-borrower'), { meta: { cwd: f.worktree.path } })
      return records
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
    expect(removeCheckout).not.toHaveBeenCalled()
    await access(f.worktree.path)
  })

  it('treats a subagent child whose parent is unknown to the corpus as unarchived', async () => {
    const f = await fixture()
    f.ctx.sessions.create(brandString<SessionId>('orphan-child'), {
      meta: { cwd: f.worktree.path, origin: 'subagent', parentSession: brandString<SessionId>('never-existed') },
    })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'retained' })
  })

  it('skips a creation record whose payload fails validation', async () => {
    const f = await fixture()
    const handle = await f.ctx.sessionProjections.register(worktreeProjection)
    const before = handle.stateOf(f.session).created
    appendPluginRecord(f.session, CREATED_RECORD, { path: '', branch: 'x', baseCommit: 'y', repositoryRoot: 'z' })
    expect(handle.stateOf(f.session).created).toEqual(before)
  })

  it('keeps one entry per entered directory, skips an entry record whose payload fails validation, and reclaims only creations', async () => {
    const f = await fixture()
    const handle = await f.ctx.sessionProjections.register(worktreeProjection)
    const visitor = f.ctx.sessions.create(brandString<SessionId>('visitor'), { meta: { cwd: f.root } })
    appendPluginRecord(visitor, ENTERED_RECORD, { path: f.worktree.path, branch: 'first', repositoryRoot: f.root })
    appendPluginRecord(visitor, ENTERED_RECORD, { path: f.worktree.path, repositoryRoot: f.root })
    const state = handle.stateOf(visitor)
    expect(state).toMatchObject({ created: [], entered: [{ path: f.worktree.path, repositoryRoot: f.root }] })
    appendPluginRecord(visitor, ENTERED_RECORD, { path: '', repositoryRoot: f.root })
    expect(handle.stateOf(visitor)).toBe(state)
    expect(f.ctx.sessionProjections.snapshot(visitor).values.worktree).toEqual([])

    await f.ctx.workspaceRegistry.archiveSession(visitor.id)
    expect(await f.ctx.worktrees.cleanupOf(visitor.id, null)).toBeNull()
    await access(f.worktree.path)
  })

  it('registers no attempt while retainOnArchive is set, and resumes once it is cleared', async () => {
    const f = await fixture({ retainOnArchive: true })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await f.ctx.worktrees.cleanupOf(f.session.id, null)).toBeNull()
    await access(f.worktree.path)
    await f.ctx.workspaceRegistry.unarchiveSession(f.session.id)
    await f.worktrees.update({ retainOnArchive: false })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    expect(await settled(f)).toMatchObject({ status: 'removed' })
  })

  it('withdraws listeners before draining, so disposal neither fails unrelated access nor serves a stale result', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    removeCheckout.mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
      return false
    })
    cleanups.push(async () => { release.resolve(undefined) })
    await f.ctx.workspaceRegistry.archiveSession(f.session.id)
    await entered.promise
    const scheduled = await f.ctx.worktrees.cleanupOf(f.session.id, null)
    const result = f.ctx.worktrees.cleanupOf(f.session.id, scheduled!.revision)
    const disposing = f.ctx.fiber.dispose()
    release.resolve(undefined)
    await disposing
    expect(await result).toBeNull()
    await access(f.worktree.path)
  })
})
