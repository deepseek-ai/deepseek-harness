import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ForgeBaseBranch, ForgeLens, ForgeLensFrame, ForgeLensId, ForgeLensInput, ForgeLocalDiff, ForgeLocalScope,
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
async function project(): Promise<{ root: string; repo: string; first: string; second: string }> {
  const { path, remove } = await scratch('dsh-forge-head-')
  cleanups.push(remove)
  const repo = await repository(path)
  await git(repo, 'remote', 'add', 'origin', 'https://fake.test/octo/demo.git')
  await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
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
  return { root: path, repo, first, second }
}

/** A linked worktree of `repo` that has the existing `branch` checked out, with one staged, one modified, and one untracked file. */
async function worktree(root: string, repo: string, branch: string): Promise<string> {
  const path = join(root, `tree-${branch}`)
  await git(repo, 'worktree', 'add', '--quiet', path, branch)
  await writeFile(join(path, 'staged.txt'), 'staged\n')
  await git(path, 'add', 'staged.txt')
  await writeFile(join(path, 'tracked.txt'), `${branch}\n`)
  await writeFile(join(path, 'new.txt'), 'new\n')
  return path
}

const TOPIC = 'refs/heads/topic'
const whole = (head: string): ForgeLocalScope => ({ kind: 'branch', head, base: null, commits: null })

describe('forgePanel local changes of a branch no worktree has checked out', () => {
  it('reads the committed content of the branch and leaves the Session\'s working tree out', async () => {
    const { repo, first, second } = await project()
    await writeFile(join(repo, 'notes.md'), 'uncommitted\n')
    const opened = await open(repo)
    const { forgePanel } = opened.ctx

    // Without a chosen base the branch is compared with the Session's own branch.
    const automatic = await forgePanel.localDiff(opened.session, whole(TOPIC), signal)
    expect([automatic.base, paths(automatic), automatic.omitted, automatic.worktree]).toEqual(['main', ['more.txt', 'topic.txt'], 0, undefined])
    const chosen = await forgePanel.localDiff(opened.session, { kind: 'branch', head: TOPIC, base: 'refs/remotes/origin/release', commits: null }, signal)
    expect([chosen.base, paths(chosen)]).toEqual(['origin/release', ['more.txt']])
    const one: ForgeLocalScope = { kind: 'branch', head: TOPIC, base: null, commits: { from: first, to: first } }
    expect(paths(await forgePanel.localDiff(opened.session, one, signal))).toEqual(['topic.txt'])
    // Neither file exists in the Session's working tree, which holds `main`.
    await expect(forgePanel.localText(opened.session, whole(TOPIC), 'more.txt', signal)).resolves.toBe('two\n')
    await expect(forgePanel.localText(opened.session, one, 'topic.txt', signal)).resolves.toBe('one\n')
    expect(paths(await forgePanel.localDiff(opened.session, { kind: 'branch', base: null, commits: null }, signal))).toEqual(['notes.md'])

    const listed = await forgePanel.localCommits(opened.session, TOPIC, null, signal)
    expect([listed.headSha, listed.commits.map(commit => commit.title)]).toEqual([second, ['one', 'two']])
    await expect(forgePanel.localCommits(opened.session, TOPIC, 'refs/remotes/origin/release', signal))
      .resolves.toMatchObject({ commits: [{ title: 'two' }] })
    await expect(forgePanel.localCommits(opened.session, null, null, signal)).resolves.toMatchObject({ commits: [] })
    // A remote-tracking branch is never checked out, so it too is read from its commits.
    const remote = await forgePanel.localDiff(opened.session, whole('refs/remotes/origin/release'), signal)
    expect([paths(remote), remote.worktree]).toEqual([['topic.txt'], undefined])
  })

  it('has the branch scope alone', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const refused = { code: 'forgePanel/no-working-tree', message: 'No worktree has the branch checked out, so it has no working tree' }
    for (const kind of ['uncommitted', 'unstaged', 'staged'] as const) {
      await expect(opened.ctx.forgePanel.localDiff(opened.session, { kind, head: TOPIC }, signal), kind).rejects.toMatchObject(refused)
    }
    await expect(opened.ctx.forgePanel.localText(opened.session, { kind: 'unstaged', head: TOPIC }, 'topic.txt', signal)).rejects.toMatchObject(refused)
  })

  it('lists the bases of the branch without that branch and without the Session\'s branch, which is the automatic base', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const { forgePanel } = opened.ctx

    const local = await forgePanel.diffBases(opened.session, TOPIC, '', signal)
    expect([local.automatic, names(local.remote), names(local.local)])
      .toEqual([{ name: 'main', worktree: false }, ['origin/main', 'origin/release'], []])
    const remote = await forgePanel.diffBases(opened.session, 'refs/remotes/origin/release', '', signal)
    expect([remote.automatic, names(remote.remote), names(remote.local)]).toEqual([{ name: 'main', worktree: false }, ['origin/main'], ['topic']])
    // The Session's own checkout lists every branch but the one it has checked out, against the remote's default branch.
    const own = await forgePanel.diffBases(opened.session, null, '', signal)
    expect([own.automatic, names(own.remote), names(own.local)])
      .toEqual([{ name: 'origin/main', worktree: false }, ['origin/main', 'origin/release'], ['topic']])
  })

  it('compares a branch with the Session\'s own HEAD in a repository without a remote', async () => {
    const { path, remove } = await scratch('dsh-forge-head-')
    cleanups.push(remove)
    const repo = await repository(path)
    await git(repo, 'checkout', '--quiet', '-b', 'feature')
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, 'add', 'feature.txt')
    await git(repo, 'commit', '--quiet', '-m', 'feature')
    // `child` leaves `feature` after the Session's own commit there, as a delegated Session's worktree does.
    await git(repo, 'checkout', '--quiet', '-b', 'child')
    await writeFile(join(repo, 'child.txt'), 'child\n')
    await git(repo, 'add', 'child.txt')
    await git(repo, 'commit', '--quiet', '-m', 'child')
    await git(repo, 'checkout', '--quiet', 'feature')
    const opened = await open(repo)
    const { forgePanel } = opened.ctx
    const child = 'refs/heads/child'

    // No remote names a default branch, so the Session's own checkout has no automatic fork point.
    await expect(forgePanel.localDiff(opened.session, { kind: 'branch', base: null, commits: null }, signal))
      .rejects.toMatchObject({ code: 'forgePanel/no-fork-point' })
    // The other branch shows what it changed since it left the Session's branch, without the Session's own commit.
    const diff = await forgePanel.localDiff(opened.session, whole(child), signal)
    expect([diff.base, paths(diff)]).toEqual(['feature', ['child.txt']])
    await expect(forgePanel.localCommits(opened.session, child, null, signal)).resolves.toMatchObject({ commits: [{ title: 'child' }] })
    const bases = await forgePanel.diffBases(opened.session, child, '', signal)
    expect([bases.automatic, names(bases.local)]).toEqual([{ name: 'feature', worktree: false }, ['main']])
    // A chosen base still replaces the automatic one.
    const chosen = await forgePanel.localDiff(opened.session, { kind: 'branch', head: child, base: 'refs/heads/main', commits: null }, signal)
    expect([chosen.base, paths(chosen)]).toEqual(['main', ['child.txt', 'feature.txt']])
  })

  it('names the automatic base by its commit while the Session\'s HEAD is detached, and has none while its branch has no commit', async () => {
    const { repo } = await project()
    await git(repo, 'checkout', '--quiet', '--detach')
    const commit = (await git(repo, 'rev-parse', 'HEAD')).trim()
    const opened = await open(repo)
    const { forgePanel } = opened.ctx

    const detached = await forgePanel.localDiff(opened.session, whole(TOPIC), signal)
    expect([detached.base, paths(detached)]).toEqual([commit.slice(0, 7), ['more.txt', 'topic.txt']])
    // Nothing stands for the automatic base in the listing, so every other local branch shows.
    const bases = await forgePanel.diffBases(opened.session, TOPIC, '', signal)
    expect([bases.automatic, names(bases.local)]).toEqual([{ name: commit.slice(0, 7), worktree: false }, ['main']])

    // A branch without a commit gives the other branch nothing to be compared with, short of the remote's default branch.
    await git(repo, 'checkout', '--quiet', '--orphan', 'empty')
    const unborn = await forgePanel.localDiff(opened.session, whole(TOPIC), signal)
    expect([unborn.base, paths(unborn)]).toEqual(['origin/main', ['more.txt', 'topic.txt']])
  })

  it('has no automatic fork point for a branch that shares no history with the Session\'s HEAD', async () => {
    const { repo } = await project()
    await git(repo, 'checkout', '--quiet', '--orphan', 'apart')
    await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'apart')
    await git(repo, 'checkout', '--quiet', '--force', 'main')
    const opened = await open(repo)
    await expect(opened.ctx.forgePanel.localDiff(opened.session, whole('refs/heads/apart'), signal))
      .rejects.toMatchObject({ code: 'forgePanel/no-fork-point' })
  })

  it('lists every local branch as a base while the Session\'s HEAD is detached', async () => {
    const { repo } = await project()
    await git(repo, 'checkout', '--quiet', '--detach')
    const opened = await open(repo)
    const own = await opened.ctx.forgePanel.diffBases(opened.session, null, '', signal)
    expect([names(own.remote), names(own.local)]).toEqual([['origin/main', 'origin/release'], ['main', 'topic']])
  })

  it('classifies the branch with a lens, reading both sides from Git', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const reads: string[] = []
    const lens: ForgeLens = {
      id: 'fixture/reads' as ForgeLensId,
      version: '1',
      classify: async (input: ForgeLensInput) => {
        for (const file of input.files) {
          reads.push(`${file.path} ${JSON.stringify([await input.text('old', file.path, signal), await input.text('new', file.path, signal)])}`)
        }
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
    const gone = 'refs/heads/gone'
    const missing = { code: 'forgePanel/head-missing', message: 'The branch gone does not exist' }

    await expect(forgePanel.localDiff(opened.session, whole(gone), signal)).rejects.toMatchObject(missing)
    await expect(forgePanel.localText(opened.session, whole(gone), 'a.txt', signal)).rejects.toMatchObject(missing)
    await expect(forgePanel.localCommits(opened.session, gone, null, signal)).rejects.toMatchObject(missing)
    await expect(forgePanel.diffBases(opened.session, gone, '', signal)).rejects.toMatchObject(missing)
    // Revision syntax names no ref, and a name outside the two branch namespaces never reaches Git.
    await expect(forgePanel.diffBases(opened.session, 'refs/heads/topic@{0}', '', signal)).rejects.toMatchObject({ code: 'forgePanel/head-missing' })
    await expect(forgePanel.diffBases(opened.session, 'HEAD', '', signal)).rejects.toThrow('"HEAD" is not a branch ref')
  })
})

describe('forgePanel local changes of a branch a worktree has checked out', () => {
  it('reads every scope in that worktree, with its uncommitted and untracked files', async () => {
    const { root, repo, second } = await project()
    const tree = await worktree(root, repo, 'topic')
    const opened = await open(repo)
    const { forgePanel } = opened.ctx
    const read = async (scope: ForgeLocalScope): Promise<[string[], string | undefined]> => {
      const diff = await forgePanel.localDiff(opened.session, scope, signal)
      return [paths(diff), diff.worktree]
    }

    // The `branch` scope adds the worktree's uncommitted files to the branch's two commits.
    const branch = await forgePanel.localDiff(opened.session, whole(TOPIC), signal)
    expect([branch.base, paths(branch), branch.worktree]).toEqual(['main', ['more.txt', 'staged.txt', 'topic.txt', 'tracked.txt', 'new.txt'], tree])
    await expect(read({ kind: 'uncommitted', head: TOPIC })).resolves.toEqual([['staged.txt', 'tracked.txt', 'new.txt'], tree])
    await expect(read({ kind: 'unstaged', head: TOPIC })).resolves.toEqual([['tracked.txt', 'new.txt'], tree])
    await expect(read({ kind: 'staged', head: TOPIC })).resolves.toEqual([['staged.txt'], tree])
    await expect(forgePanel.localText(opened.session, { kind: 'unstaged', head: TOPIC }, 'tracked.txt', signal)).resolves.toBe('topic\n')
    await expect(forgePanel.localText(opened.session, whole(TOPIC), 'new.txt', signal)).resolves.toBe('new\n')
    await expect(forgePanel.localCommits(opened.session, TOPIC, null, signal))
      .resolves.toMatchObject({ headSha: second, commits: [{ title: 'one' }, { title: 'two' }] })
    // The Session's own working tree is untouched by the worktree.
    await expect(read({ kind: 'uncommitted' })).resolves.toEqual([[], undefined])

    // The bases of the worktree's branch leave out `main`, which the automatic base stands for.
    const bases = await forgePanel.diffBases(opened.session, TOPIC, '', signal)
    expect([bases.automatic, bases.local]).toEqual([{ name: 'main', worktree: false }, []])
    // A listed branch names its worktree's directory as Git registered it, which separates with `/` on Windows too;
    // the reads above report the directory they confirmed, in the spelling of the process.
    const own = await forgePanel.diffBases(opened.session, null, '', signal)
    expect(own.local).toEqual([{ ref: TOPIC, name: 'topic', worktree: tree.replaceAll('\\', '/') }])
  })

  it('reads the Session\'s own checkout when the head names its checked-out branch', async () => {
    const { repo } = await project()
    await writeFile(join(repo, 'notes.md'), 'uncommitted\n')
    const opened = await open(repo)
    const diff = await opened.ctx.forgePanel.localDiff(opened.session, { kind: 'uncommitted', head: 'refs/heads/main' }, signal)
    expect([paths(diff), diff.worktree]).toEqual([['notes.md'], undefined])
  })

  it('falls back to the branch\'s commits once the worktree holds another branch or its directory is gone', async () => {
    const { root, repo } = await project()
    const tree = await worktree(root, repo, 'topic')
    const opened = await open(repo)
    const { forgePanel } = opened.ctx

    // Git still registers a worktree whose directory was deleted, until it is pruned.
    await rm(tree, { recursive: true })
    const removed = await forgePanel.localDiff(opened.session, whole(TOPIC), signal)
    expect([paths(removed), removed.worktree]).toEqual([['more.txt', 'topic.txt'], undefined])
    await expect(forgePanel.localDiff(opened.session, { kind: 'unstaged', head: TOPIC }, signal)).rejects.toMatchObject({ code: 'forgePanel/no-working-tree' })
    expect((await forgePanel.diffBases(opened.session, null, '', signal)).local).toEqual([{ ref: TOPIC, name: 'topic' }])
  })

  it('reads the branch from its commits when another repository took the place of its worktree', async () => {
    const { root, repo } = await project()
    const tree = await worktree(root, repo, 'topic')
    // Git keeps listing a worktree while its directory holds a `.git`, whichever repository that belongs to.
    await rm(tree, { recursive: true })
    const other = await repository(root, 'tree-topic')
    await git(other, 'checkout', '--quiet', '-b', 'topic')
    await writeFile(join(other, 'elsewhere.txt'), 'elsewhere\n')
    const opened = await open(repo)
    const { forgePanel } = opened.ctx

    expect((await forgePanel.diffBases(opened.session, null, '', signal)).local)
      .toEqual([{ ref: TOPIC, name: 'topic', worktree: tree.replaceAll('\\', '/') }])
    // The read finds a checkout of `topic` there, but of another repository, and leaves its files out.
    const diff = await forgePanel.localDiff(opened.session, whole(TOPIC), signal)
    expect([paths(diff), diff.worktree]).toEqual([['more.txt', 'topic.txt'], undefined])
    await expect(forgePanel.localDiff(opened.session, { kind: 'unstaged', head: TOPIC }, signal)).rejects.toMatchObject({ code: 'forgePanel/no-working-tree' })
  })

  // A directory's name cannot hold a line break on Windows.
  it.skipIf(process.platform === 'win32')('reads the branch from its commits unless the listed directory holds a checkout of it', async () => {
    const { root, repo } = await project()
    // Git's listing ends each of these paths at the line break: at a missing directory, at one outside every
    // checkout, and at one inside the Session's checkout, which holds `main`.
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'missing', join(root, 'missing\nx'))
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'plain', join(root, 'plain\nx'))
    await mkdir(join(root, 'plain'))
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'inside', join(repo, 'inside\nx'))
    await mkdir(join(repo, 'inside'))
    // And at another repository that has a branch of the same name checked out.
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'shared', join(root, 'other\nx'))
    const other = await repository(root, 'other')
    await git(other, 'checkout', '--quiet', '-b', 'shared')
    await writeFile(join(other, 'elsewhere.txt'), 'elsewhere\n')
    const opened = await open(repo)
    const { forgePanel } = opened.ctx

    for (const branch of ['missing', 'plain', 'inside', 'shared']) {
      const head = `refs/heads/${branch}`
      const diff = await forgePanel.localDiff(opened.session, whole(head), signal)
      expect([paths(diff), diff.worktree], branch).toEqual([[], undefined])
      await expect(forgePanel.localDiff(opened.session, { kind: 'unstaged', head }, signal), branch).rejects.toMatchObject({ code: 'forgePanel/no-working-tree' })
    }
  })
})
