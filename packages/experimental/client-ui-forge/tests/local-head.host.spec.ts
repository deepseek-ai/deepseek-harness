import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ForgeBaseBranch, ForgeLens, ForgeLensFrame, ForgeLensId, ForgeLensInput, ForgeLocalDiff, ForgeLocalHead, ForgeLocalScope,
} from '../src/index.ts'
import { lensVersion } from '../src/lens-version.ts'
import { bench, git, repository, scratch } from './harness.ts'
import type { Bench } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal

async function open(cwd: string): Promise<Bench> {
  const opened = await bench(cwd)
  cleanups.push(() => opened.ctx.fiber.dispose())
  return opened
}

const paths = (diff: ForgeLocalDiff): string[] => diff.files.map(file => file.path)
const names = (branches: readonly ForgeBaseBranch[]): string[] => branches.map(branch => branch.name).sort()

/**
 * A repository on `main` whose `origin/HEAD` names `main`, with a `topic` branch two commits ahead of it and a
 * remote-only `origin/release` at the first of those commits.
 */
async function project(): Promise<{ root: string; repo: string; base: string; first: string; second: string }> {
  const { path, remove } = await scratch('dsh-forge-head-')
  cleanups.push(remove)
  const repo = await repository(path)
  await git(repo, 'remote', 'add', 'origin', 'https://fake.test/octo/demo.git')
  await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const base = (await git(repo, 'rev-parse', 'HEAD')).trim()
  await git(repo, 'checkout', '--quiet', '-b', 'topic')
  const commits: string[] = []
  for (const [file, title] of [['topic.txt', 'one'], ['more.txt', 'two']] as const) {
    await writeFile(join(repo, file), `${title}\n`)
    await git(repo, 'add', file)
    await git(repo, 'commit', '--quiet', '-m', title)
    commits.push((await git(repo, 'rev-parse', 'HEAD')).trim())
  }
  const [first = '', second = ''] = commits
  await git(repo, 'update-ref', 'refs/remotes/origin/release', first)
  await git(repo, 'checkout', '--quiet', 'main')
  return { root: path, repo, base, first, second }
}

const TOPIC: ForgeLocalHead = { kind: 'branch', ref: 'refs/heads/topic' }

describe('forgePanel local changes of a branch head', () => {
  it('reads the committed content of another branch and leaves the working tree out', async () => {
    const { repo, first, second } = await project()
    await writeFile(join(repo, 'notes.md'), 'uncommitted\n')
    const opened = await open(repo)
    const { forgePanel } = opened.ctx
    const whole: ForgeLocalScope = { kind: 'branch', head: TOPIC, base: null, commits: null }

    const automatic = await forgePanel.localDiff(opened.session, whole, signal)
    expect([automatic.base, paths(automatic), automatic.omitted]).toEqual(['origin/main', ['more.txt', 'topic.txt'], 0])
    const chosen = await forgePanel.localDiff(opened.session, { ...whole, base: 'refs/remotes/origin/release' }, signal)
    expect([chosen.base, paths(chosen)]).toEqual(['origin/release', ['more.txt']])
    const one: ForgeLocalScope = { ...whole, commits: { from: first, to: first } }
    expect(paths(await forgePanel.localDiff(opened.session, one, signal))).toEqual(['topic.txt'])
    // Neither file exists in the Session's working tree, which holds `main`.
    await expect(forgePanel.localText(opened.session, whole, 'more.txt', signal)).resolves.toBe('two\n')
    await expect(forgePanel.localText(opened.session, one, 'topic.txt', signal)).resolves.toBe('one\n')
    expect(paths(await forgePanel.localDiff(opened.session, { kind: 'branch', base: null, commits: null }, signal))).toEqual(['notes.md'])

    const listed = await forgePanel.localCommits(opened.session, TOPIC, null, signal)
    expect([listed.headSha, listed.commits.map(commit => commit.title)]).toEqual([second, ['one', 'two']])
    await expect(forgePanel.localCommits(opened.session, TOPIC, 'refs/remotes/origin/release', signal))
      .resolves.toMatchObject({ commits: [{ title: 'two' }] })
    await expect(forgePanel.localCommits(opened.session, null, null, signal)).resolves.toMatchObject({ commits: [] })
  })

  it('lists the bases of a branch head without that branch', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const { forgePanel } = opened.ctx

    const local = await forgePanel.diffBases(opened.session, TOPIC, '', signal)
    expect([local.automatic, names(local.remote), names(local.local)])
      .toEqual([{ name: 'origin/main', worktree: false }, ['origin/main', 'origin/release'], ['main']])
    const remote = await forgePanel.diffBases(opened.session, { kind: 'branch', ref: 'refs/remotes/origin/release' }, '', signal)
    expect([names(remote.remote), names(remote.local)]).toEqual([['origin/main'], ['main', 'topic']])
    // The Session's own checkout lists every branch but the one it has checked out.
    const own = await forgePanel.diffBases(opened.session, null, '', signal)
    expect([names(own.remote), names(own.local)]).toEqual([['origin/main', 'origin/release'], ['topic']])
  })

  it('lists every local branch as a base while the Session\'s HEAD is detached', async () => {
    const { repo } = await project()
    await git(repo, 'checkout', '--quiet', '--detach')
    const opened = await open(repo)
    const own = await opened.ctx.forgePanel.diffBases(opened.session, null, '', signal)
    expect([names(own.remote), names(own.local)]).toEqual([['origin/main', 'origin/release'], ['main', 'topic']])
  })

  it('classifies a branch head with a lens, reading both sides from Git', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const reads: string[] = []
    const lens: ForgeLens = {
      id: 'fixture/reads' as ForgeLensId,
      version: '1',
      classify: async (input: ForgeLensInput) => {
        for (const file of input.files) reads.push(`${file.path} ${JSON.stringify([await input.text('old', file.path, signal), await input.text('new', file.path, signal)])}`)
        return { files: {} }
      },
    }
    cleanups.push(opened.ctx.forgePanel.registerLens(lens))
    const scope: ForgeLocalScope = { kind: 'branch', head: TOPIC, base: 'refs/remotes/origin/release', commits: null }
    const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)

    const frames: ForgeLensFrame[] = []
    const request = { source: { kind: 'local' as const, scope }, version: lensVersion(files), lens: 'fixture/reads' }
    for await (const frame of opened.ctx.forgePanel.changesLens(opened.session, request, signal)) frames.push(frame)
    expect(frames.at(-1)).toEqual({ kind: 'result', files: {} })
    expect(reads).toEqual(['more.txt [null,"two\\n"]'])
  })

  it('refuses a head that is not an existing branch', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const { forgePanel } = opened.ctx
    const gone: ForgeLocalHead = { kind: 'branch', ref: 'refs/heads/gone' }
    const missing = { code: 'forgePanel/head-missing', message: 'The branch gone does not exist' }

    await expect(forgePanel.localDiff(opened.session, { kind: 'branch', head: gone, base: null, commits: null }, signal)).rejects.toMatchObject(missing)
    await expect(forgePanel.localText(opened.session, { kind: 'branch', head: gone, base: null, commits: null }, 'a.txt', signal)).rejects.toMatchObject(missing)
    await expect(forgePanel.localCommits(opened.session, gone, null, signal)).rejects.toMatchObject(missing)
    await expect(forgePanel.diffBases(opened.session, gone, '', signal)).rejects.toMatchObject(missing)
    // Revision syntax names no ref, and a name outside the two branch namespaces never reaches Git.
    await expect(forgePanel.diffBases(opened.session, { kind: 'branch', ref: 'refs/heads/topic@{0}' }, '', signal))
      .rejects.toMatchObject({ code: 'forgePanel/head-missing' })
    await expect(forgePanel.diffBases(opened.session, { kind: 'branch', ref: 'HEAD' }, '', signal)).rejects.toThrow('"HEAD" is not a branch ref')
  })
})

const LEAD = brandString<SessionId>('lead')
const id = (name: string): SessionId => brandString<SessionId>(name)

/** What the fake Session query knows of one Session. */
interface Recorded {
  readonly parent?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
  /** Projection values, or undefined for an observation without projections. */
  readonly values?: { readonly workingDirectory?: string | null; readonly worktree?: readonly unknown[] }
  /** A read failure other than an unknown Session. */
  readonly broken?: true
}

/** Serve fixed records as the Session query service and fixed rows as the subagent service. */
function provideRelated(opened: Bench, records: Readonly<Record<string, Recorded>>, rows: readonly object[]): void {
  opened.ctx.provide('sessionQuery', {
    observeSession: async (sessionId: SessionId) => {
      const found = records[sessionId]
      if (found === undefined) throw Object.assign(new Error(`no Session ${sessionId}`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      if (found.broken === true) throw new Error(`the records of ${sessionId} cannot be read`)
      return {
        header: { id: sessionId, cwd: found.cwd, origin: found.origin, parentSession: found.parent },
        projections: found.values === undefined ? undefined : { values: found.values },
        [Symbol.dispose]() {},
      }
    },
  } as never)
  opened.ctx.provide('subagents', { listDescendants: async () => rows } as never)
}

/** A linked worktree of `repo` on a new branch, with one modified and one untracked file. */
async function worktree(root: string, repo: string, branch: string): Promise<string> {
  const path = join(root, branch)
  await git(repo, 'worktree', 'add', '--quiet', '-b', branch, path, 'main')
  await writeFile(join(path, 'tracked.txt'), `${branch}\n`)
  await writeFile(join(path, 'new.txt'), 'new\n')
  return path
}

describe('forgePanel local changes of a related Session', () => {
  it('lists the checkouts delegated Sessions work in, one entry per checkout', async () => {
    const { root, repo } = await project()
    const child = await worktree(root, repo, 'child')
    const plain = join(root, 'plain')
    await mkdir(plain)
    const opened = await open(repo)
    const lead = opened.session.id
    const warn = vi.spyOn(opened.ctx.logger, 'warn')
    provideRelated(opened, {
      one: { parent: lead, origin: 'subagent', cwd: repo, values: { workingDirectory: child } },
      // Without a projected directory the header names where the Session works.
      two: { parent: id('one'), origin: 'subagent', cwd: child },
      same: { parent: lead, origin: 'subagent', cwd: repo, values: { workingDirectory: null } },
      gone: { parent: lead, origin: 'subagent', cwd: join(root, 'removed') },
      outside: { parent: lead, origin: 'subagent', cwd: plain },
      nowhere: { parent: lead, origin: 'subagent' },
      broken: { parent: lead, origin: 'subagent', broken: true },
      hidden: { parent: lead, origin: 'subagent', cwd: child },
    }, [
      { kind: 'child', id: id('one'), mode: 'continuable', label: 'Fix the cache', name: 'cache' },
      { kind: 'child', id: id('two'), mode: 'one-shot', path: 'cache/helper' },
      { kind: 'child', id: id('same'), mode: 'continuable', label: 'In the lead checkout' },
      { kind: 'child', id: id('gone'), mode: 'continuable', label: 'Removed' },
      { kind: 'child', id: id('outside'), mode: 'continuable', label: 'Not a checkout' },
      { kind: 'child', id: id('nowhere'), mode: 'continuable', label: 'No directory' },
      { kind: 'child', id: id('broken'), mode: 'continuable', label: 'Unreadable' },
      { kind: 'child', id: id('unknown'), mode: 'continuable', label: 'No records' },
      { kind: 'child', id: id('hidden'), mode: 'continuable', label: 'Not readable by the caller' },
      { kind: 'child', id: id('remote'), mode: 'external', label: 'External' },
      { kind: 'diagnostic', id: id('lost'), reason: 'unavailable' },
    ])
    opened.ctx.provide('remoteAccess', { allows: ({ id: asked }: { id: SessionId }) => asked !== 'hidden' } as never)

    const listed = await opened.ctx.forgePanel.relatedCheckouts(opened.session, signal)
    expect(listed).toEqual([{
      sessionId: 'one', root: child, branch: 'child', commit: (await git(child, 'rev-parse', '--short', 'HEAD')).trim(),
      labels: ['Fix the cache', 'cache/helper'],
    }])
    expect(warn.mock.calls.map(([message]) => String(message)).filter(message => message.startsWith('forge-panel:'))).toEqual([
      'forge-panel: inspecting the checkout of Session broken failed: Error: the records of broken cannot be read',
    ])
  })

  it('names a Session by its id where its catalog row has neither description nor name', async () => {
    const { root, repo } = await project()
    const child = await worktree(root, repo, 'child')
    const opened = await open(repo)
    provideRelated(opened, { bare: { parent: opened.session.id, origin: 'subagent', cwd: child } }, [{ kind: 'child', id: id('bare'), mode: 'one-shot' }])
    await expect(opened.ctx.forgePanel.relatedCheckouts(opened.session, signal)).resolves.toMatchObject([{ sessionId: 'bare', labels: ['bare'] }])
  })

  it('lists nothing without the subagent or the Session query service', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    await expect(opened.ctx.forgePanel.relatedCheckouts(opened.session, signal)).resolves.toEqual([])
    opened.ctx.provide('subagents', { listDescendants: async () => [] } as never)
    await expect(opened.ctx.forgePanel.relatedCheckouts(opened.session, signal)).resolves.toEqual([])
  })

  it('stops listing when the request is cancelled', async () => {
    const { root, repo } = await project()
    const opened = await open(repo)
    const stop = new AbortController()
    opened.ctx.provide('sessionQuery', { observeSession: async () => { stop.abort(new Error('closed')); throw new Error('cancelled read') } } as never)
    opened.ctx.provide('subagents', { listDescendants: async () => [{ kind: 'child', id: id('one'), mode: 'continuable', label: 'x' }] } as never)
    void root
    await expect(opened.ctx.forgePanel.relatedCheckouts(opened.session, stop.signal)).rejects.toThrow('closed')
  })

  it('reads a related Session\'s working tree, forking where that Session created its worktree', async () => {
    const { root, repo, base } = await project()
    const child = await worktree(root, repo, 'child')
    const entered = await worktree(root, repo, 'entered')
    const opened = await open(repo)
    const lead = opened.session.id
    provideRelated(opened, {
      one: {
        parent: lead, origin: 'subagent', cwd: repo,
        values: { workingDirectory: child, worktree: [{ worktree: { path: child, branch: 'child', baseCommit: base, repositoryRoot: repo }, owned: true }] },
      },
      // A Session two levels down that entered a worktree it did not create.
      two: { parent: id('one'), origin: 'subagent', cwd: repo, values: { workingDirectory: entered } },
    }, [])
    const { forgePanel } = opened.ctx
    const one: ForgeLocalHead = { kind: 'session', sessionId: id('one') }
    const two: ForgeLocalHead = { kind: 'session', sessionId: id('two') }

    const created = await forgePanel.localDiff(opened.session, { kind: 'branch', head: one, base: null, commits: null }, signal)
    expect([created.base, paths(created)]).toEqual([base.slice(0, 7), ['tracked.txt', 'new.txt']])
    const joined = await forgePanel.localDiff(opened.session, { kind: 'branch', head: two, base: null, commits: null }, signal)
    expect([joined.base, paths(joined)]).toEqual(['origin/main', ['tracked.txt', 'new.txt']])
    expect(paths(await forgePanel.localDiff(opened.session, { kind: 'unstaged', head: one }, signal))).toEqual(['tracked.txt', 'new.txt'])
    expect(paths(await forgePanel.localDiff(opened.session, { kind: 'staged', head: one }, signal))).toEqual([])
    await expect(forgePanel.localText(opened.session, { kind: 'uncommitted', head: one }, 'tracked.txt', signal)).resolves.toBe('child\n')
    // The Session's own working tree is untouched by either worktree.
    expect(paths(await forgePanel.localDiff(opened.session, { kind: 'uncommitted' }, signal))).toEqual([])

    const bases = await forgePanel.diffBases(opened.session, one, '', signal)
    expect([bases.automatic, names(bases.local)]).toEqual([{ name: base.slice(0, 7), worktree: true }, ['entered', 'main', 'topic']])
    await expect(forgePanel.localCommits(opened.session, one, null, signal)).resolves.toMatchObject({ commits: [] })
  })

  it('refuses a Session that is not delegated from the reading one, is unreadable, or has no checkout', async () => {
    const { root, repo } = await project()
    const child = await worktree(root, repo, 'child')
    const plain = join(root, 'plain')
    await mkdir(plain)
    const removed = await worktree(root, repo, 'removed')
    await rm(removed, { recursive: true })
    const opened = await open(repo)
    const lead = opened.session.id
    const { forgePanel } = opened.ctx
    const read = async (name: string): Promise<ForgeLocalDiff> =>
      await forgePanel.localDiff(opened.session, { kind: 'uncommitted', head: { kind: 'session', sessionId: id(name) } }, signal)

    // Without the Session query service no related Session can be found.
    await expect(read('one')).rejects.toMatchObject({ code: 'forgePanel/head-missing' })
    provideRelated(opened, {
      one: { parent: lead, origin: 'subagent', cwd: child },
      stranger: { parent: LEAD, origin: 'subagent', cwd: child },
      [LEAD]: { cwd: repo },
      forked: { parent: lead, cwd: child },
      loop: { parent: id('pool'), origin: 'subagent', cwd: child },
      pool: { parent: id('loop'), origin: 'subagent', cwd: child },
      gone: { parent: lead, origin: 'subagent', cwd: removed },
      outside: { parent: lead, origin: 'subagent', cwd: plain },
      broken: { parent: lead, origin: 'subagent', broken: true },
      hidden: { parent: lead, origin: 'subagent', cwd: child },
    }, [])
    opened.ctx.provide('remoteAccess', { allows: ({ id: asked }: { id: SessionId }) => asked !== 'hidden' } as never)

    expect(paths(await read('one'))).toEqual(['tracked.txt', 'new.txt'])
    for (const [name, message] of [
      ['unknown', 'Session unknown has no records'],
      ['stranger', 'Session stranger was not delegated from this Session'],
      ['forked', 'Session forked was not delegated from this Session'],
      ['loop', 'Session loop was not delegated from this Session'],
      ['gone', 'The directory of Session gone is gone'],
      ['outside', 'The directory of Session outside is not inside a Git checkout'],
      ['hidden', 'The related Session cannot be read'],
    ] as const) {
      await expect(read(name), name).rejects.toMatchObject({ code: 'forgePanel/head-missing', message })
    }
    await expect(read('broken')).rejects.toThrow('the records of broken cannot be read')
  })
})
