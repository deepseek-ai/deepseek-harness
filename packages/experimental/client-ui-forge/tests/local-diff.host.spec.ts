/** Local changes through real Git repositories: fork points, the four scopes, untracked files, new-side text, and the card's size. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { gitIn, inspectCheckout } from '../src/git.ts'
import type { Inspection } from '../src/git.ts'
import { aheadOf, DiffTooLarge, forkPoint, localChanges, localDiff, localText, NoForkPoint } from '../src/local-diff.ts'
import type { DiffConfig } from '../src/local-diff.ts'
import type { ForgeLocalScope, ForgeSessionWorktree } from '../src/types.ts'
import { git, gitContext, plainSession, repository, sandboxRecord, scratch } from './harness.ts'

const CONFIG: DiffConfig = {
  gitCommand: 'git', gitTimeoutMs: 10_000, graceMs: 500, maxOutputBytes: 1_048_576, maxDiffBytes: 1_048_576, maxUntrackedFiles: 100,
}

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

    await expect(forkPoint(git, await inspected(ctx, repo), null)).resolves.toEqual({ commit: fork, label: 'origin/main' })
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
    await expect(forkPoint(gitIn(ctx, CONFIG, plainSession(repo), repo, signal), inspection, null)).resolves.toEqual({ commit: fork, label: 'origin/main' })
  })

  it.each([
    ['its base branch', 'release', 'release'],
    ['the commit it started from', null, 'cccccc0'],
  ])('forks a worktree the Session created at its recorded base, named by %s', async (_label, from, label) => {
    const { repo } = await forked(await directory())
    const ctx = await context(repo)
    const created: ForgeSessionWorktree = { path: repo, branch: 'feat', from, baseCommit: `cccccc0${'1'.repeat(33)}`, repositoryRoot: repo }

    await expect(forkPoint(gitIn(ctx, CONFIG, plainSession(repo), repo, signal), await inspected(ctx, repo), created))
      .resolves.toEqual({ commit: created.baseCommit, label })
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

describe('localDiff', () => {
  it.each([
    [{ kind: 'branch' }, 'origin/main', ['committed.txt added', 'staged.txt added', 'tracked.txt modified', 'untracked.txt added untracked']],
    [{ kind: 'uncommitted' }, null, ['staged.txt added', 'tracked.txt modified', 'untracked.txt added untracked']],
    [{ kind: 'unstaged' }, null, ['tracked.txt modified', 'untracked.txt added untracked']],
    [{ kind: 'staged' }, null, ['staged.txt added']],
  ] as const)('reads the %o scope with untracked files last, leaving out ignored files and nested repositories', async (scope, base, files) => {
    const { repo, fork } = await forked(await directory())
    const ctx = await context(repo)
    const diff = await localDiff(ctx, CONFIG, plainSession(repo), repo, { commit: fork, label: 'origin/main' }, scope, signal)

    expect(diff.base).toBe(base)
    expect(diff.omitted).toBe(0)
    expect(diff.files.map(file => `${file.path} ${file.status}${file.untracked ? ' untracked' : ''}`)).toEqual(files)
  })

  it('carries the hunks of tracked and untracked files', async () => {
    const { repo, fork } = await forked(await directory())
    const diff = await localDiff(await context(repo), CONFIG, plainSession(repo), repo, { commit: fork, label: 'origin/main' }, { kind: 'unstaged' }, signal)

    expect(diff.files.map(file => [file.additions, file.deletions, file.hunks.flatMap(hunk => hunk.lines)])).toEqual([
      [1, 0, [' initial', '+changed']],
      [2, 0, ['+new', '+file']],
    ])
  })

  it('refuses the branch scope without a fork point', async () => {
    const { repo } = await forked(await directory())

    await expect(localDiff(await context(repo), CONFIG, plainSession(repo), repo, null, { kind: 'branch' }, signal)).rejects.toBeInstanceOf(NoForkPoint)
  })

  it('compares a branch without commits with the empty tree', async () => {
    const root = await directory()
    await git(root, 'init', '--quiet', '-b', 'main', 'fresh')
    const repo = join(root, 'fresh')
    await writeFile(join(repo, 'first.txt'), 'first\n')
    await git(repo, 'add', 'first.txt')
    const ctx = await context(repo)

    for (const kind of ['staged', 'uncommitted'] as const) {
      const diff = await localDiff(ctx, CONFIG, plainSession(repo), repo, null, { kind }, signal)
      expect(diff.files.map(file => [file.path, file.status])).toEqual([['first.txt', 'added']])
    }
  })

  it('reports a patch over maxDiffBytes', async () => {
    const { repo, fork } = await forked(await directory())
    await writeFile(join(repo, 'tracked.txt'), 'line\n'.repeat(400))

    await expect(localDiff(await context(repo), { ...CONFIG, maxDiffBytes: 512 }, plainSession(repo), repo, { commit: fork, label: 'x' }, { kind: 'unstaged' }, signal))
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
    const diff = await localDiff(ctx, config, plainSession(repo), repo, { commit: fork, label: 'x' }, { kind: 'unstaged' }, signal)

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

    await expect(localDiff(ctx, CONFIG, plainSession(repo), repo, { commit: fork, label: 'x' }, { kind: 'unstaged' }, signal))
      .rejects.toThrow('disk on fire')
  })
})

describe('localText', () => {
  const branch: ForgeLocalScope = { kind: 'branch' }

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
