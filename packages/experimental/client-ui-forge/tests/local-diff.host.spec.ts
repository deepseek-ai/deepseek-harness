/** Local changes through real Git repositories: fork points, the four scopes, untracked files, new-side text, and the card's size. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { gitIn, inspectCheckout } from '../src/git.ts'
import type { Inspection } from '../src/git.ts'
import {
  aheadOf, BaseMissing, baseBranches, chosenForkPoint, CommitsMissing, CommitsNotLinear, DiffTooLarge, forkPoint, localChanges,
  localCommits, localDiff, localOldText, localText, NoForkPoint,
} from '../src/local-diff.ts'
import type { DiffConfig, ForkPoint } from '../src/local-diff.ts'
import { FileLayers } from '../src/layers.ts'
import type { ForgeLocalScope, ForgeSessionWorktree } from '../src/types.ts'
import { git, gitContext, plainSession, repository, sandboxRecord, scratch } from './harness.ts'

const CONFIG: DiffConfig = {
  gitCommand: 'git', gitTimeoutMs: 10_000, graceMs: 500, maxOutputBytes: 1_048_576, maxDiffBytes: 1_048_576, maxUntrackedFiles: 100,
}

/** Text files form the `test` layer and JSON files the `interface` layer. */
const LAYERS = new FileLayers(['**/untracked.txt'], ['**/*.json'])

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory(): Promise<string> {
  const { path, remove } = await scratch('dsh-forge-diff-')
  cleanups.push(remove)
  return path
}

async function context(root: string): Promise<Context> {
  const ctx = await gitContext(sandboxRecord(), root)
  cleanups.push(() => ctx.fiber.dispose())
  return ctx
}

const signal = new AbortController().signal

async function configure(repo: string): Promise<void> {
  for (const [key, value] of [['core.autocrlf', 'false'], ['user.name', 'Forge fixture'], ['user.email', 'forge@example.invalid'], ['commit.gpgSign', 'false']]) {
    await git(repo, 'config', key as string, value as string)
  }
}

/**
 * A clone of a bare `origin` whose `origin/HEAD` names `main`, on branch `feat`
 * with `committed.txt` committed, `staged.txt` staged, `tracked.txt` changed in
 * the working tree, `untracked.txt` untracked, an excluded log file, and an
 * untracked nested repository.
 */
async function forked(root: string): Promise<{ readonly repo: string; readonly fork: string }> {
  const seed = await repository(root, 'seed')
  await git(root, 'init', '--quiet', '--bare', '-b', 'main', 'origin.git')
  await git(seed, 'push', '--quiet', join(root, 'origin.git'), 'main')
  await git(root, 'clone', '--quiet', join(root, 'origin.git'), 'repo')
  const repo = join(root, 'repo')
  await configure(repo)
  await git(repo, 'checkout', '--quiet', '-b', 'feat')
  const fork = await git(repo, 'rev-parse', 'HEAD')
  await writeFile(join(repo, 'committed.txt'), 'one\n')
  await git(repo, 'add', 'committed.txt')
  await git(repo, 'commit', '--quiet', '-m', 'committed')
  await writeFile(join(repo, 'staged.txt'), 'staged\n')
  await git(repo, 'add', 'staged.txt')
  await writeFile(join(repo, 'tracked.txt'), 'initial\nchanged\n')
  await writeFile(join(repo, 'untracked.txt'), 'new\nfile\n')
  await writeFile(join(repo, '.git', 'info', 'exclude'), '*.log\n')
  await writeFile(join(repo, 'debug.log'), 'ignored\n')
  await git(repo, 'init', '--quiet', 'nested')
  return { repo, fork }
}

async function inspected(ctx: Context, repo: string): Promise<Inspection> {
  const inspection = await inspectCheckout(ctx, CONFIG, plainSession(repo), repo, signal)
  if (inspection === undefined) throw new Error('not a checkout')
  return inspection
}

describe('forkPoint', () => {
  it('forks the branch scope at the merge base with the default branch of the remote', async () => {
    const { repo, fork } = await forked(await directory())
    const ctx = await context(repo)
    const git = gitIn(ctx, CONFIG, plainSession(repo), repo, signal)

    await expect(forkPoint(git, await inspected(ctx, repo), null)).resolves.toEqual({ commit: fork, label: 'origin/main', worktree: false })
  })

  it('skips a remote without a default branch for the next one', async () => {
    const { repo, fork } = await forked(await directory())
    // The upstream's remote comes first, and this one names no default branch.
    await git(repo, 'remote', 'add', 'mirror', 'https://example.invalid/a/b.git')
    await git(repo, 'update-ref', 'refs/remotes/mirror/feat', 'HEAD')
    await git(repo, 'branch', '--quiet', '--set-upstream-to=mirror/feat', 'feat')
    const ctx = await context(repo)
    const inspection = await inspected(ctx, repo)

    expect(inspection.upstream).toBe('mirror/feat')
    await expect(forkPoint(gitIn(ctx, CONFIG, plainSession(repo), repo, signal), inspection, null)).resolves.toEqual({ commit: fork, label: 'origin/main', worktree: false })
  })

  it.each([
    ['its base branch', 'release', 'release'],
    ['the commit it started from', null, 'cccccc0'],
  ])('forks a worktree the Session created at its recorded base, named by %s', async (_label, from, label) => {
    const { repo } = await forked(await directory())
    const ctx = await context(repo)
    const created: ForgeSessionWorktree = { path: repo, branch: 'feat', from, baseCommit: `cccccc0${'1'.repeat(33)}`, repositoryRoot: repo }

    await expect(forkPoint(gitIn(ctx, CONFIG, plainSession(repo), repo, signal), await inspected(ctx, repo), created))
      .resolves.toEqual({ commit: created.baseCommit, label, worktree: true })
  })

  it('has no fork point without a remote default branch or a shared history', async () => {
    const root = await directory()
    const plain = await repository(root, 'plain')
    const ctx = await context(plain)
    const created: ForgeSessionWorktree = { path: join(root, 'elsewhere'), branch: 'x', from: null, baseCommit: 'a'.repeat(40), repositoryRoot: plain }
    const confined = gitIn(ctx, CONFIG, plainSession(plain), plain, signal)
    await expect(forkPoint(confined, await inspected(ctx, plain), created)).resolves.toBeNull()

    const { repo } = await forked(await directory())
    await git(repo, 'stash', '--quiet', '--include-untracked')
    await git(repo, 'checkout', '--quiet', '--orphan', 'solo')
    await git(repo, 'commit', '--quiet', '-m', 'solo')
    const orphan = await context(repo)
    const unrelated = gitIn(orphan, CONFIG, plainSession(repo), repo, signal)
    await expect(forkPoint(unrelated, await inspected(orphan, repo), null)).resolves.toBeNull()
  })
})

describe('chosenForkPoint', () => {
  it('forks the branch scope at the merge base of HEAD with a chosen remote-tracking or local branch', async () => {
    const { repo, fork } = await forked(await directory())
    await git(repo, 'branch', 'topic')
    const head = await git(repo, 'rev-parse', 'HEAD')
    const confined = gitIn(await context(repo), CONFIG, plainSession(repo), repo, signal)

    await expect(chosenForkPoint(confined, 'refs/remotes/origin/main')).resolves.toEqual({ commit: fork, label: 'origin/main', worktree: false })
    await expect(chosenForkPoint(confined, 'refs/heads/topic')).resolves.toEqual({ commit: head, label: 'topic', worktree: false })
  })

  it.each(['refs/heads/gone', 'refs/heads/feat@{1}', 'refs/remotes/origin/a..b'])('reports the missing base branch %s', async (ref) => {
    const { repo } = await forked(await directory())
    const confined = gitIn(await context(repo), CONFIG, plainSession(repo), repo, signal)

    await expect(chosenForkPoint(confined, ref)).rejects.toBeInstanceOf(BaseMissing)
  })

  it('has no fork point with a branch that shares no history with HEAD', async () => {
    const { repo } = await forked(await directory())
    await git(repo, 'stash', '--quiet', '--include-untracked')
    await git(repo, 'checkout', '--quiet', '--orphan', 'solo')
    await git(repo, 'commit', '--quiet', '-m', 'solo')
    const confined = gitIn(await context(repo), CONFIG, plainSession(repo), repo, signal)

    await expect(chosenForkPoint(confined, 'refs/heads/feat')).resolves.toBeNull()
  })

  it.each(['HEAD', 'main', 'refs/tags/v1', 'refs/heads/', '--output=x'])('refuses %j, which names no branch', async (ref) => {
    const { repo } = await forked(await directory())
    const confined = gitIn(await context(repo), CONFIG, plainSession(repo), repo, signal)

    await expect(chosenForkPoint(confined, ref)).rejects.toThrow('is not a branch ref')
  })
})

describe('baseBranches', () => {
  it('lists the automatic fork point, remote-tracking branches without symbolic refs, and local branches but the checked-out one', async () => {
    const { repo } = await forked(await directory())
    await git(repo, 'branch', 'Release-2')
    await git(repo, 'update-ref', 'refs/remotes/origin/release/2.4', 'HEAD')
    await git(repo, 'tag', 'v1')
    const ctx = await context(repo)
    const confined = gitIn(ctx, CONFIG, plainSession(repo), repo, signal)
    const listed = await baseBranches(confined, await inspected(ctx, repo), null, '', 50)
    const names = (branches: readonly { readonly name: string }[]): string[] => branches.map(branch => branch.name).sort()

    expect(listed.automatic).toEqual({ name: 'origin/main', worktree: false })
    expect(names(listed.remote)).toEqual(['origin/main', 'origin/release/2.4'])
    expect(listed.remote).toContainEqual({ ref: 'refs/remotes/origin/release/2.4', name: 'origin/release/2.4' })
    expect(names(listed.local)).toEqual(['Release-2', 'main'])

    const searched = await baseBranches(confined, await inspected(ctx, repo), null, ' release ', 1)
    expect(searched.automatic).toEqual({ name: 'origin/main', worktree: false })
    expect([searched.remote, searched.local].map(names)).toEqual([['origin/release/2.4'], ['Release-2']])
  })

  it('names the start of the worktree the Session created, or no automatic fork point without one', async () => {
    const { repo } = await forked(await directory())
    const ctx = await context(repo)
    const created: ForgeSessionWorktree = { path: repo, branch: 'feat', from: 'main', baseCommit: 'a'.repeat(40), repositoryRoot: repo }
    const confined = gitIn(ctx, CONFIG, plainSession(repo), repo, signal)
    await expect(baseBranches(confined, await inspected(ctx, repo), created, '', 50)).resolves.toMatchObject({ automatic: { name: 'main', worktree: true } })

    const plain = await repository(await directory(), 'plain')
    const bare = await context(plain)
    await expect(baseBranches(gitIn(bare, CONFIG, plainSession(plain), plain, signal), await inspected(bare, plain), null, '', 50))
      .resolves.toEqual({ automatic: null, remote: [], local: [] })
  })
})

describe('localDiff', () => {
  it.each([
    [{ kind: 'branch', base: null, commits: null }, 'origin/main', ['committed.txt added', 'staged.txt added', 'tracked.txt modified', 'untracked.txt added untracked']],
    [{ kind: 'uncommitted' }, null, ['staged.txt added', 'tracked.txt modified', 'untracked.txt added untracked']],
    [{ kind: 'unstaged' }, null, ['tracked.txt modified', 'untracked.txt added untracked']],
    [{ kind: 'staged' }, null, ['staged.txt added']],
  ] as const)('reads the %o scope with untracked files last, leaving out ignored files and nested repositories', async (scope, base, files) => {
    const { repo, fork } = await forked(await directory())
    const ctx = await context(repo)
    const diff = await localDiff(ctx, CONFIG, plainSession(repo), repo, { commit: fork, label: 'origin/main', worktree: false }, scope, LAYERS, signal)

    expect(diff.base).toBe(base)
    expect(diff.omitted).toBe(0)
    expect(diff.files.map(file => `${file.path} ${file.status}${file.untracked ? ' untracked' : ''}`)).toEqual(files)
  })

  it('carries the hunks of tracked and untracked files', async () => {
    const { repo, fork } = await forked(await directory())
    const diff = await localDiff(await context(repo), CONFIG, plainSession(repo), repo, { commit: fork, label: 'origin/main', worktree: false }, { kind: 'unstaged' }, LAYERS, signal)

    expect(diff.files.map(file => [file.additions, file.deletions, file.hunks.flatMap(hunk => hunk.lines)])).toEqual([
      [1, 0, [' initial', '+changed']],
      [2, 0, ['+new', '+file']],
    ])
  })

  it('refuses the branch scope without a fork point', async () => {
    const { repo } = await forked(await directory())

    await expect(localDiff(await context(repo), CONFIG, plainSession(repo), repo, null, { kind: 'branch', base: null, commits: null }, LAYERS, signal)).rejects.toBeInstanceOf(NoForkPoint)
  })

  it('compares a branch without commits with the empty tree', async () => {
    const root = await directory()
    await git(root, 'init', '--quiet', '-b', 'main', 'fresh')
    const repo = join(root, 'fresh')
    await writeFile(join(repo, 'first.txt'), 'first\n')
    await git(repo, 'add', 'first.txt')
    const ctx = await context(repo)

    for (const kind of ['staged', 'uncommitted'] as const) {
      const diff = await localDiff(ctx, CONFIG, plainSession(repo), repo, null, { kind }, LAYERS, signal)
      expect(diff.files.map(file => [file.path, file.status])).toEqual([['first.txt', 'added']])
    }
  })

  it('reports a patch over maxDiffBytes', async () => {
    const { repo, fork } = await forked(await directory())
    await writeFile(join(repo, 'tracked.txt'), 'line\n'.repeat(400))

    await expect(localDiff(await context(repo), { ...CONFIG, maxDiffBytes: 512 }, plainSession(repo), repo, { commit: fork, label: 'x', worktree: false }, { kind: 'unstaged' }, LAYERS, signal))
      .rejects.toBeInstanceOf(DiffTooLarge)
  })

  it('lists at most maxUntrackedFiles untracked files, marking binary and oversized ones and skipping unreadable ones', async () => {
    const { repo, fork } = await forked(await directory())
    await mkdir(join(repo, 'more'))
    await writeFile(join(repo, 'more', 'big.txt'), 'x'.repeat(4096))
    await writeFile(join(repo, 'more', 'blob.bin'), Uint8Array.from([0, 1, 2]))
    await writeFile(join(repo, 'more', 'gone.txt'), 'gone\n')
    await writeFile(join(repo, 'zzz.txt'), 'last\n')
    const ctx = await context(repo)
    const read = ctx.fs.readBytes.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'readBytes').mockImplementation(async (target, readSignal, maxBytes) => {
      if (ctx.fs.processPath(target).endsWith('gone.txt')) throw new FsError('gone', 'FS_NOT_FOUND')
      return await read(target, readSignal, maxBytes)
    })
    const config = { ...CONFIG, maxDiffBytes: 2048, maxUntrackedFiles: 4 }
    const diff = await localDiff(ctx, config, plainSession(repo), repo, { commit: fork, label: 'x', worktree: false }, { kind: 'unstaged' }, LAYERS, signal)

    expect(diff.files.filter(file => file.untracked).map(file => [file.path, file.binary, file.oversized, file.additions])).toEqual([
      ['more/big.txt', false, true, 0],
      ['more/blob.bin', true, false, 0],
      ['untracked.txt', false, false, 2],
    ])
    expect(diff.omitted).toBe(1)
  })

  it('stops at a read failure that is not a filesystem refusal', async () => {
    const { repo, fork } = await forked(await directory())
    const ctx = await context(repo)
    vi.spyOn(ctx.fs, 'readBytes').mockRejectedValue(new Error('disk on fire'))

    await expect(localDiff(ctx, CONFIG, plainSession(repo), repo, { commit: fork, label: 'x', worktree: false }, { kind: 'unstaged' }, LAYERS, signal))
      .rejects.toThrow('disk on fire')
  })
})

describe('review layers', () => {
  it('classifies files by the globs and the root .gitattributes of the working tree, or of the index for the staged scope', async () => {
    const { repo, fork } = await forked(await directory())
    const point = { commit: fork, label: 'origin/main', worktree: false }
    await writeFile(join(repo, 'config.json'), '{}\n')
    await writeFile(join(repo, '.gitattributes'), 'tracked.txt linguist-generated\n')
    const ctx = await context(repo)
    const layers = async (scope: ForgeLocalScope): Promise<string[]> =>
      (await localDiff(ctx, CONFIG, plainSession(repo), repo, point, scope, LAYERS, signal)).files.map(file => `${file.path} ${file.layer}`)

    expect(await layers({ kind: 'unstaged' })).toEqual([
      'tracked.txt test', '.gitattributes implementation', 'config.json interface', 'untracked.txt test',
    ])
    await writeFile(join(repo, '.gitattributes'), 'staged.txt linguist-generated\n')
    await git(repo, 'add', '.gitattributes')
    await writeFile(join(repo, '.gitattributes'), '')
    expect(await layers({ kind: 'staged' })).toEqual(['.gitattributes implementation', 'staged.txt test'])
    expect(await layers({ kind: 'uncommitted' })).toEqual([
      '.gitattributes implementation', 'staged.txt implementation', 'tracked.txt implementation', 'config.json interface', 'untracked.txt test',
    ])
  })

  it('reads no attributes for a staged scope without .gitattributes and stops at an unreadable working tree file', async () => {
    const { repo, fork } = await forked(await directory())
    const ctx = await context(repo)
    const point = { commit: fork, label: 'origin/main', worktree: false }

    await expect(localDiff(ctx, CONFIG, plainSession(repo), repo, point, { kind: 'staged' }, LAYERS, signal))
      .resolves.toMatchObject({ files: [{ path: 'staged.txt', layer: 'implementation' }] })
    await writeFile(join(repo, '.gitattributes'), Uint8Array.from([0x74, 0, 0x74]))
    await expect(localDiff(ctx, CONFIG, plainSession(repo), repo, point, { kind: 'unstaged' }, LAYERS, signal))
      .resolves.toMatchObject({ files: [{ path: 'tracked.txt', layer: 'implementation' }, { path: '.gitattributes' }, { path: 'untracked.txt' }] })
    const read = ctx.fs.readBytes.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'readBytes').mockImplementation(async (target, readSignal, maxBytes) => {
      if (ctx.fs.processPath(target).endsWith('.gitattributes')) throw new FsError('denied', 'FS_PERMISSION_DENIED')
      return await read(target, readSignal, maxBytes)
    })
    await expect(localDiff(ctx, CONFIG, plainSession(repo), repo, point, { kind: 'unstaged' }, LAYERS, signal)).rejects.toThrow('denied')
  })
})

describe('commits of the branch scope', () => {
  /** {@link forked} with two more commits on `feat`, `second.txt` and then `.gitattributes` with a generated `third.json`. */
  async function committed(): Promise<{ readonly repo: string; readonly point: ForkPoint; readonly shas: readonly string[] }> {
    const { repo, fork } = await forked(await directory())
    await git(repo, 'commit', '--quiet', '-m', 'staged')
    await writeFile(join(repo, 'second.txt'), 'two\n')
    await git(repo, 'add', 'second.txt')
    await git(repo, 'commit', '--quiet', '-m', 'second')
    await writeFile(join(repo, '.gitattributes'), 'third.json linguist-generated\n')
    await writeFile(join(repo, 'third.json'), '{}\n')
    await git(repo, 'add', '.gitattributes', 'third.json')
    await git(repo, 'commit', '--quiet', '-m', 'third')
    const shas = (await git(repo, 'rev-list', '--reverse', `${fork}..HEAD`)).split('\n')
    return { repo, point: { commit: fork, label: 'origin/main', worktree: false }, shas }
  }

  it('lists the commits between the fork point and HEAD oldest first, keeping the newest ones over the limit', async () => {
    const { repo, point, shas } = await committed()
    const ctx = await context(repo)
    const runner = gitIn(ctx, CONFIG, plainSession(repo), repo, signal)

    const listed = await localCommits(runner, point, 10)
    expect(listed).toMatchObject({ headSha: shas.at(-1), truncated: false })
    expect(listed.commits.map(commit => [commit.title, commit.author])).toEqual([
      ['committed', 'Forge fixture'], ['staged', 'Forge fixture'], ['second', 'Forge fixture'], ['third', 'Forge fixture'],
    ])
    expect(listed.commits.map(commit => commit.sha)).toEqual(shas)
    expect(listed.commits.map(commit => commit.parent)).toEqual([point.commit, ...shas.slice(0, -1)])
    expect(Date.parse(listed.commits[0]?.authoredAt ?? '')).not.toBeNaN()
    await expect(localCommits(runner, point, 2)).resolves.toMatchObject({ truncated: true, commits: [{ title: 'second' }, { title: 'third' }] })
    await expect(localCommits(runner, point, 4)).resolves.toMatchObject({ truncated: false, commits: { length: 4 } })
  })

  it('lists signed commits while the repository asks Git to show signatures', async () => {
    const { repo, point, shas } = await committed()
    const head = shas.at(-1) ?? ''
    // A signature Git cannot verify still makes `log.showSignature` print verification text before each signed commit.
    const tree = await git(repo, 'rev-parse', 'HEAD^{tree}')
    const signed = join(repo, '.git', 'signed-commit')
    await writeFile(signed, [
      `tree ${tree}`, `parent ${head}`, 'author Forge fixture <forge@example.invalid> 1700000000 +0000',
      'committer Forge fixture <forge@example.invalid> 1700000000 +0000',
      'gpgsig -----BEGIN SSH SIGNATURE-----', ' AAAA', ' -----END SSH SIGNATURE-----', '', 'signed', '',
    ].join('\n'))
    const sha = await git(repo, 'hash-object', '-t', 'commit', '-w', signed)
    await git(repo, 'reset', '--quiet', '--soft', sha)
    await git(repo, 'config', 'log.showSignature', 'true')
    await git(repo, 'config', 'gpg.ssh.program', join(repo, 'missing-ssh-keygen'))
    const ctx = await context(repo)

    const listed = await localCommits(gitIn(ctx, CONFIG, plainSession(repo), repo, signal), point, 10)
    expect(listed.commits.map(commit => [commit.sha, commit.title])).toEqual([
      ...shas.map((commit, index) => [commit, ['committed', 'staged', 'second', 'third'][index]]), [sha, 'signed'],
    ])
  })

  it('reads the committed changes of consecutive commits with the attributes of the last one, without working tree changes', async () => {
    const { repo, point, shas } = await committed()
    const ctx = await context(repo)
    const range = async (from: number, to: number): Promise<string[]> => {
      const diff = await localDiff(ctx, CONFIG, plainSession(repo), repo, point,
        { kind: 'branch', base: null, commits: { from: shas[from] ?? '', to: shas[to] ?? '' } }, LAYERS, signal)
      expect(diff).toMatchObject({ base: 'origin/main', omitted: 0 })
      return diff.files.map(file => `${file.path} ${file.layer}`)
    }

    expect(await range(2, 2)).toEqual(['second.txt implementation'])
    expect(await range(1, 3)).toEqual(['.gitattributes implementation', 'second.txt implementation', 'staged.txt implementation', 'third.json test'])
    await expect(localText(ctx, CONFIG, plainSession(repo), repo,
      { kind: 'branch', base: null, commits: { from: shas[2] ?? '', to: shas[2] ?? '' } }, 'second.txt', signal)).resolves.toBe('two\n')
  })

  it('compares a first commit without a parent with the empty tree', async () => {
    const { repo, point } = await committed()
    await git(repo, 'checkout', '--quiet', '--orphan', 'other')
    await git(repo, 'rm', '--quiet', '-r', '-f', '--cached', '.')
    await writeFile(join(repo, 'orphan.txt'), 'root\n')
    await git(repo, 'add', 'orphan.txt')
    await git(repo, 'commit', '--quiet', '-m', 'orphan')
    const orphan = await git(repo, 'rev-parse', 'HEAD')
    await git(repo, 'checkout', '--quiet', '--force', 'feat')
    await git(repo, 'merge', '--quiet', '--allow-unrelated-histories', '--no-edit', 'other')
    const ctx = await context(repo)

    const listed = await localCommits(gitIn(ctx, CONFIG, plainSession(repo), repo, signal), point, 10)
    expect(listed.commits.find(commit => commit.sha === orphan)?.parent).toBeNull()
    const diff = await localDiff(ctx, CONFIG, plainSession(repo), repo, point,
      { kind: 'branch', base: null, commits: { from: orphan, to: orphan } }, LAYERS, signal)
    expect(diff.files.map(file => [file.path, file.status])).toEqual([['orphan.txt', 'added']])
  })

  it('refuses a run of commits whose first parents leave it, and reads one that follows them', async () => {
    const { repo, fork } = await forked(await directory())
    await git(repo, 'commit', '--quiet', '-m', 'staged')
    await git(repo, 'checkout', '--quiet', '-b', 'side', fork)
    for (const name of ['side-one', 'side-two']) {
      await writeFile(join(repo, `${name}.txt`), `${name}\n`)
      await git(repo, 'add', `${name}.txt`)
      await git(repo, 'commit', '--quiet', '-m', name)
    }
    await git(repo, 'checkout', '--quiet', 'feat')
    await git(repo, 'merge', '--quiet', '--no-ff', '--no-edit', 'side')
    const point: ForkPoint = { commit: fork, label: 'origin/main', worktree: false }
    const ctx = await context(repo)
    const listed = (await localCommits(gitIn(ctx, CONFIG, plainSession(repo), repo, signal), point, 10)).commits
    const read = (from: string, to: string): Promise<{ readonly files: readonly { readonly path: string }[] }> =>
      localDiff(ctx, CONFIG, plainSession(repo), repo, point, { kind: 'branch', base: null, commits: { from, to } }, LAYERS, signal)
    // Two branches from the fork point list their commits one after the other, so one pair of neighbours is unrelated.
    const leaving = listed.findIndex((commit, index) => index > 0 && commit.parent !== listed[index - 1]?.sha)
    const before = listed[leaving - 1]?.sha ?? ''
    const after = listed[leaving]?.sha ?? ''

    expect(leaving).toBeGreaterThan(0)
    await expect(read(before, after)).rejects.toBeInstanceOf(CommitsNotLinear)
    const side = listed.filter(commit => commit.title.startsWith('side-'))
    expect((await read(side[0]?.sha ?? '', side[1]?.sha ?? '')).files.map(file => file.path)).toEqual(['side-one.txt', 'side-two.txt'])
  })

  it('refuses commits that are not full object names, not on the branch, or out of order', async () => {
    const { repo, point, shas } = await committed()
    const ctx = await context(repo)
    const read = (from: string, to: string): Promise<unknown> =>
      localDiff(ctx, CONFIG, plainSession(repo), repo, point, { kind: 'branch', base: null, commits: { from, to } }, LAYERS, signal)
    const [first = '', second = ''] = shas

    await expect(read('HEAD', second)).rejects.toBeInstanceOf(CommitsMissing)
    await expect(read(first, '--output=x')).rejects.toBeInstanceOf(CommitsMissing)
    await expect(read(point.commit, second)).rejects.toThrow('The chosen commits are no longer on the branch')
    await expect(read(second, first)).rejects.toThrow('The chosen commits are no longer on the branch')
    await expect(localText(ctx, CONFIG, plainSession(repo), repo,
      { kind: 'branch', base: null, commits: { from: first, to: 'HEAD' } }, 'second.txt', signal)).rejects.toBeInstanceOf(CommitsMissing)
  })
})

describe('localOldText', () => {
  it('reads the old side at the fork point, HEAD, the index, or before the first chosen commit', async () => {
    const { repo, fork } = await forked(await directory())
    await writeFile(join(repo, 'staged.txt'), 'edited after staging\n')
    const ctx = await context(repo)
    const point: ForkPoint = { commit: fork, label: 'origin/main', worktree: false }
    const committed = await git(repo, 'rev-parse', 'HEAD')
    const read = (scope: ForgeLocalScope, path: string, at: ForkPoint | null = null): Promise<string | null> =>
      localOldText(ctx, CONFIG, plainSession(repo), repo, scope, at, path, signal)

    await expect(read({ kind: 'branch', base: null, commits: null }, 'tracked.txt', point)).resolves.toBe('initial\n')
    await expect(read({ kind: 'branch', base: null, commits: null }, 'committed.txt', point)).resolves.toBeNull()
    await expect(read({ kind: 'uncommitted' }, 'committed.txt')).resolves.toBe('one\n')
    await expect(read({ kind: 'staged' }, 'staged.txt')).resolves.toBeNull()
    await expect(read({ kind: 'unstaged' }, 'staged.txt')).resolves.toBe('staged\n')
    await expect(read({ kind: 'branch', base: null, commits: { from: committed, to: committed } }, 'tracked.txt', point)).resolves.toBe('initial\n')
  })

  it('reads binary content and the parent of a root commit as missing', async () => {
    const { repo } = await forked(await directory())
    await writeFile(join(repo, 'blob.bin'), Uint8Array.from([0x61, 0, 0x62]))
    await git(repo, 'add', 'blob.bin')
    await git(repo, 'commit', '--quiet', '-m', 'blob')
    const ctx = await context(repo)
    const root = await git(repo, 'rev-list', '--max-parents=0', 'HEAD')

    await expect(localOldText(ctx, CONFIG, plainSession(repo), repo, { kind: 'unstaged' }, null, 'blob.bin', signal)).resolves.toBeNull()
    await expect(localOldText(ctx, CONFIG, plainSession(repo), repo, { kind: 'branch', base: null, commits: { from: root, to: root } },
      { commit: root, label: 'root', worktree: false }, 'tracked.txt', signal)).resolves.toBeNull()
  })

  it('refuses a path outside the checkout, a branch without a fork point, and a chosen commit that is not an object name', async () => {
    const { repo, fork } = await forked(await directory())
    const ctx = await context(repo)
    const point: ForkPoint = { commit: fork, label: 'origin/main', worktree: false }

    await expect(localOldText(ctx, CONFIG, plainSession(repo), repo, { kind: 'unstaged' }, null, '../outside.txt', signal))
      .rejects.toThrow('is not a path inside the checkout')
    await expect(localOldText(ctx, CONFIG, plainSession(repo), repo, { kind: 'branch', base: null, commits: null }, null, 'tracked.txt', signal))
      .rejects.toBeInstanceOf(NoForkPoint)
    await expect(localOldText(ctx, CONFIG, plainSession(repo), repo, { kind: 'branch', base: null, commits: { from: 'HEAD', to: 'HEAD' } }, point,
      'tracked.txt', signal)).rejects.toBeInstanceOf(CommitsMissing)
  })
})

describe('localText', () => {
  const branch: ForgeLocalScope = { kind: 'branch', base: null, commits: null }

  it('reads the working tree, or the index for the staged scope', async () => {
    const { repo } = await forked(await directory())
    await writeFile(join(repo, 'staged.txt'), 'edited after staging\n')
    const ctx = await context(repo)

    await expect(localText(ctx, CONFIG, plainSession(repo), repo, branch, 'tracked.txt', signal)).resolves.toBe('initial\nchanged\n')
    await expect(localText(ctx, CONFIG, plainSession(repo), repo, { kind: 'staged' }, 'staged.txt', signal)).resolves.toBe('staged\n')
    await expect(localText(ctx, CONFIG, plainSession(repo), repo, { kind: 'unstaged' }, 'staged.txt', signal)).resolves.toBe('edited after staging\n')
  })

  it.each(['', '/etc/passwd', 'C:\\Windows\\win.ini', '../outside.txt', 'a/../../b', 'a\\..\\b', 'nul\0name'])(
    'refuses the path %j outside the checkout', async (path) => {
      const { repo } = await forked(await directory())

      await expect(localText(await context(repo), CONFIG, plainSession(repo), repo, branch, path, signal)).rejects.toThrow('is not a path inside the checkout')
    },
  )

  it('refuses binary content in the working tree and in the index', async () => {
    const { repo } = await forked(await directory())
    await writeFile(join(repo, 'blob.bin'), Uint8Array.from([0x61, 0, 0x62]))
    await git(repo, 'add', 'blob.bin')
    const ctx = await context(repo)

    await expect(localText(ctx, CONFIG, plainSession(repo), repo, branch, 'blob.bin', signal)).rejects.toThrow('blob.bin is binary')
    await expect(localText(ctx, CONFIG, plainSession(repo), repo, { kind: 'staged' }, 'blob.bin', signal)).rejects.toThrow('blob.bin is binary')
  })

  it('reports a file over maxDiffBytes from either side, and passes other read failures on', async () => {
    const { repo } = await forked(await directory())
    await writeFile(join(repo, 'staged.txt'), 'x'.repeat(4096))
    await git(repo, 'add', 'staged.txt')
    const ctx = await context(repo)
    const config = { ...CONFIG, maxDiffBytes: 1024 }

    await expect(localText(ctx, config, plainSession(repo), repo, branch, 'staged.txt', signal)).rejects.toBeInstanceOf(DiffTooLarge)
    await expect(localText(ctx, config, plainSession(repo), repo, { kind: 'staged' }, 'staged.txt', signal)).rejects.toBeInstanceOf(DiffTooLarge)
    await expect(localText(ctx, config, plainSession(repo), repo, branch, 'missing.txt', signal)).rejects.toBeInstanceOf(FsError)
    await expect(localText(ctx, config, plainSession(repo), repo, { kind: 'staged' }, 'missing.txt', signal)).rejects.toThrow(/^git show failed/)
  })
})

describe('aheadOf', () => {
  it('counts the commits the checkout has beyond a head on the same branch, if that head is present', async () => {
    const { repo, fork } = await forked(await directory())
    const runner = gitIn(await context(repo), CONFIG, plainSession(repo), repo, signal)

    await expect(aheadOf(runner, 'feat', fork)).resolves.toBe(1)
    await expect(aheadOf(runner, 'main', fork)).resolves.toBeNull()
    await expect(aheadOf(runner, 'feat', 'e'.repeat(40))).resolves.toBeNull()
  })

  it('counts nothing outside a checkout', async () => {
    const outside = await directory()

    await expect(aheadOf(gitIn(await context(outside), CONFIG, plainSession(outside), outside, signal), 'feat', 'e'.repeat(40))).resolves.toBeNull()
  })
})

describe('localChanges', () => {
  it('measures the branch scope with untracked files last, or nothing without a fork point', async () => {
    const { repo } = await forked(await directory())
    const ctx = await context(repo)

    await expect(localChanges(ctx, CONFIG, plainSession(repo), await inspected(ctx, repo), null, signal)).resolves.toEqual({
      base: 'origin/main',
      files: [
        { path: 'committed.txt', additions: 1, deletions: 0, binary: false },
        { path: 'staged.txt', additions: 1, deletions: 0, binary: false },
        { path: 'tracked.txt', additions: 1, deletions: 0, binary: false },
        { path: 'untracked.txt', additions: 2, deletions: 0, binary: false },
      ],
    })

    const plain = await repository(await directory(), 'plain')
    const other = await context(plain)
    await expect(localChanges(other, CONFIG, plainSession(plain), await inspected(other, plain), null, signal)).resolves.toBeNull()
  })
})
