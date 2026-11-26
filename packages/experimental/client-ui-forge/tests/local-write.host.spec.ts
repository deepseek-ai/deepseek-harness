/** Writes of the changes view through real Git repositories: staging, unstaging, restoring, and returning the index to an earlier tree. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitFailed } from '../src/git.ts'
import { localDiff } from '../src/local-diff.ts'
import type { DiffConfig } from '../src/local-diff.ts'
import { LocalChangesStale, LocalPathReplaced, localWrite } from '../src/local-write.ts'
import { FileLayers } from '../src/layers.ts'
import type { ForgeLocalWrite, ForgeLocalWriteFile, ForgeLocalWriteResult } from '../src/types.ts'
import { git, gitContext, plainSession, rejectionOf, repository, sandboxRecord, scratch } from './harness.ts'

const LAYERS = new FileLayers([], [])

const CONFIG: DiffConfig = {
  gitCommand: 'git', gitTimeoutMs: 10_000, graceMs: 500, maxOutputBytes: 1_048_576, maxDiffBytes: 1_048_576, maxUntrackedFiles: 100,
}

const posix = process.platform !== 'win32'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A repository whose one commit holds `tracked.txt`, with the context and Session that write it. */
async function setup(prepare: (root: string) => Promise<string> = repository, real = false) {
  const { path: root, remove } = await scratch('dsh-forge-write-')
  cleanups.push(remove)
  const repo = await prepare(root)
  const record = sandboxRecord()
  const ctx = await gitContext(record, repo, real)
  cleanups.push(() => ctx.fiber.dispose())
  const session = plainSession(repo)
  const signal = new AbortController().signal
  const config = { ...CONFIG }
  /** The files of the `unstaged` scope as a reader would name them in a write. */
  const seen = async (...paths: string[]): Promise<ForgeLocalWriteFile[]> => {
    const { files } = await localDiff(ctx, config, session, repo, null, { kind: 'unstaged' }, LAYERS, signal)
    return paths.map((path) => {
      const file = files.find(candidate => candidate.path === path)
      if (file === undefined) throw new Error(`${path} is not in the unstaged scope`)
      return { path, digest: file.digest }
    })
  }
  const write = (request: ForgeLocalWrite): Promise<ForgeLocalWriteResult> =>
    localWrite(ctx, config, session, repo, request, LAYERS, signal)
  /** `git status --short` lines, in Git's order; the branch line keeps the harness from trimming the first entry's column. */
  const status = async (): Promise<string[]> => (await git(repo, '-c', 'core.quotePath=false', 'status', '--short', '--branch')).split('\n').slice(1)
  return { root, repo, ctx, record, session, config, seen, write, status }
}

describe('localWrite stage', () => {
  it('stages changed, deleted, and untracked files, and names with pathspec characters', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'gone.txt'), 'gone\n')
    await git(b.repo, 'add', 'gone.txt')
    await git(b.repo, 'commit', '--quiet', '-m', 'gone')
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    await rm(join(b.repo, 'gone.txt'))
    await writeFile(join(b.repo, 'new.txt'), 'new\n')
    // Without literal pathspecs Git reads `:(top)` as pathspec magic and `[x]` as a character class. NTFS refuses a colon in a name.
    const odd = posix ? ':(top)odd [x].txt' : 'odd [x].txt'
    await writeFile(join(b.repo, odd), 'odd\n')
    await writeFile(join(b.repo, 'left.txt'), 'left\n')

    const result = await b.write({ kind: 'stage', files: await b.seen('tracked.txt', 'gone.txt', 'new.txt', odd) })

    expect(result.undo).toMatch(/^[0-9a-f]{40,64}$/)
    expect((await b.status()).sort()).toEqual([`A  "${odd}"`, 'D  gone.txt', 'A  new.txt', 'M  tracked.txt', '?? left.txt'].sort())
  })

  it('returns the index to the tree it reported, keeping what was staged before', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'tracked.txt'), 'initial\nstaged\n')
    await git(b.repo, 'add', 'tracked.txt')
    await writeFile(join(b.repo, 'tracked.txt'), 'initial\nstaged\nlater\n')
    await writeFile(join(b.repo, 'new.txt'), 'new\n')

    const { undo } = await b.write({ kind: 'stage', files: await b.seen('tracked.txt', 'new.txt') })
    expect(await b.status()).toEqual(['A  new.txt', 'M  tracked.txt'])
    if (undo === null) throw new Error('the stage reported no tree')
    await expect(b.write({ kind: 'reindex', tree: undo, paths: ['tracked.txt', 'new.txt'] })).resolves.toEqual({ undo: null })

    expect(await b.status()).toEqual(['MM tracked.txt', '?? new.txt'])
    expect(await git(b.repo, 'show', ':tracked.txt')).toBe('initial\nstaged')
  })

  it('stages a rename the index expects with the removal of its old path', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'tracked.txt'), 'one\ntwo\nthree\nfour\n')
    await git(b.repo, 'commit', '--quiet', '-am', 'longer')
    await git(b.repo, 'mv', 'tracked.txt', 'moved.txt')
    await git(b.repo, 'reset', '--quiet')
    await git(b.repo, 'add', '--intent-to-add', 'moved.txt')
    const files = await b.seen('moved.txt')

    await b.write({ kind: 'stage', files })

    expect(await b.status()).toEqual(['R  tracked.txt -> moved.txt'])
  })

  it('writes nothing when a file changed after it was read, or is gone from the scope', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    await writeFile(join(b.repo, 'new.txt'), 'new\n')
    const files = await b.seen('new.txt', 'tracked.txt')
    await writeFile(join(b.repo, 'tracked.txt'), 'changed again\n')

    await expect(b.write({ kind: 'stage', files })).rejects.toBeInstanceOf(LocalChangesStale)
    await expect(b.write({ kind: 'stage', files })).rejects.toThrow('tracked.txt changed since it was read')
    expect(await b.status()).toEqual([' M tracked.txt', '?? new.txt'])

    await git(b.repo, 'checkout', '--', 'tracked.txt')
    await expect(b.write({ kind: 'restore', files })).rejects.toBeInstanceOf(LocalChangesStale)
    expect(await b.status()).toEqual(['?? new.txt'])
  })

  it('stages beside unmerged entries without a tree to return to', async () => {
    const b = await setup()
    await git(b.repo, 'checkout', '--quiet', '-b', 'other')
    await writeFile(join(b.repo, 'tracked.txt'), 'theirs\n')
    await git(b.repo, 'commit', '--quiet', '-am', 'theirs')
    await git(b.repo, 'checkout', '--quiet', 'main')
    await writeFile(join(b.repo, 'tracked.txt'), 'ours\n')
    await git(b.repo, 'commit', '--quiet', '-am', 'ours')
    await git(b.repo, 'merge', 'other').catch(() => undefined)
    await writeFile(join(b.repo, 'new.txt'), 'new\n')

    await expect(b.write({ kind: 'stage', files: await b.seen('new.txt') })).resolves.toEqual({ undo: null })

    expect(await b.status()).toEqual(['A  new.txt', 'UU tracked.txt'])
  })

  it('splits the paths over as many commands as the command-line limit needs', async () => {
    const b = await setup()
    b.config.maxUntrackedFiles = 400
    // Short names keep every path under the 260 characters Windows allows by default.
    const names = Array.from({ length: 400 }, (_, index) => `${String(index).padStart(3, '0')}-${'n'.repeat(40)}.txt`)
    await Promise.all(names.map(name => writeFile(join(b.repo, name), 'new\n')))
    const files = await b.seen(...names)
    const spawned = vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn')

    await b.write({ kind: 'stage', files })

    // Each path is 48 characters, and one command takes 16,000 characters of paths and their separators.
    const adds = spawned.mock.calls.map(([spec]) => spec.argv).filter(argv => argv.includes('add'))
    expect(adds.map(argv => argv.filter(argument => argument.endsWith('.txt')).length)).toEqual([326, 74])
    expect(adds[0]).toEqual(expect.arrayContaining(['--literal-pathspecs', 'add', '--']))
    expect(await b.status()).toHaveLength(400)
  })
})

describe('localWrite unstage', () => {
  it('returns index entries to HEAD and reports the tree before', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'tracked.txt'), 'one\ntwo\nthree\nfour\n')
    await git(b.repo, 'commit', '--quiet', '-am', 'longer')
    await writeFile(join(b.repo, 'new.txt'), 'new\n')
    await git(b.repo, 'mv', 'tracked.txt', 'moved.txt')
    await git(b.repo, 'add', 'new.txt')
    expect(await b.status()).toEqual(['R  tracked.txt -> moved.txt', 'A  new.txt'])

    const { undo } = await b.write({ kind: 'unstage', paths: ['tracked.txt', 'moved.txt', 'new.txt'] })
    expect(await b.status()).toEqual([' D tracked.txt', '?? moved.txt', '?? new.txt'])

    if (undo === null) throw new Error('the unstage reported no tree')
    await b.write({ kind: 'reindex', tree: undo, paths: ['tracked.txt', 'moved.txt', 'new.txt'] })
    expect(await b.status()).toEqual(['R  tracked.txt -> moved.txt', 'A  new.txt'])
  })

  it('unstages in a repository without a commit', async () => {
    const b = await setup(async (root) => {
      await git(root, 'init', '--quiet', '-b', 'main', 'repo')
      return join(root, 'repo')
    })
    await writeFile(join(b.repo, 'first.txt'), 'first\n')
    await git(b.repo, 'add', 'first.txt')

    await b.write({ kind: 'unstage', paths: ['first.txt'] })

    expect(await b.status()).toEqual(['?? first.txt'])
  })

  it('refuses a path outside the checkout and a tree that is not a full object name', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    await git(b.repo, 'add', 'tracked.txt')

    await expect(b.write({ kind: 'unstage', paths: ['tracked.txt', '../outside.txt'] })).rejects.toThrow('"../outside.txt" is not a path inside the checkout')
    await expect(b.write({ kind: 'reindex', tree: 'HEAD', paths: ['tracked.txt'] })).rejects.toThrow('is not a full object name')
    await expect(b.write({ kind: 'reindex', tree: 'a'.repeat(40), paths: ['/etc/passwd'] })).rejects.toThrow('is not a path inside the checkout')
    expect(await b.status()).toEqual(['M  tracked.txt'])
  })

  it('reports a tree Git no longer has as a Git failure', async () => {
    const b = await setup()

    const failure = await rejectionOf(b.write({ kind: 'reindex', tree: 'a'.repeat(40), paths: ['tracked.txt'] }))

    expect(failure).toBeInstanceOf(GitFailed)
  })
})

describe('localWrite restore', () => {
  it('returns changed and deleted files to their index entries and deletes untracked files', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'gone.txt'), 'gone\n')
    await git(b.repo, 'add', 'gone.txt')
    await git(b.repo, 'commit', '--quiet', '-m', 'gone')
    await writeFile(join(b.repo, 'tracked.txt'), 'initial\nstaged\n')
    await git(b.repo, 'add', 'tracked.txt')
    await writeFile(join(b.repo, 'tracked.txt'), 'initial\nstaged\nlater\n')
    await rm(join(b.repo, 'gone.txt'))
    await writeFile(join(b.repo, 'new.txt'), 'new\n')
    await writeFile(join(b.repo, 'kept.txt'), 'kept\n')

    await expect(b.write({ kind: 'restore', files: await b.seen('tracked.txt', 'gone.txt', 'new.txt') })).resolves.toEqual({ undo: null })

    expect(await b.status()).toEqual(['M  tracked.txt', '?? kept.txt'])
    expect(await readFile(join(b.repo, 'tracked.txt'), 'utf8')).toBe('initial\nstaged\n')
    expect(await readFile(join(b.repo, 'gone.txt'), 'utf8')).toBe('gone\n')
  })

  it('refuses a file the index tracks without content, whose restoration would empty it', async () => {
    const b = await setup()
    await writeFile(join(b.repo, 'intended.txt'), 'intended\n')
    await git(b.repo, 'add', '--intent-to-add', 'intended.txt')
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')

    await expect(b.write({ kind: 'restore', files: await b.seen('tracked.txt', 'intended.txt') })).rejects.toThrow('intended.txt is a submodule or has no index content, so it cannot be restored')

    expect(await readFile(join(b.repo, 'intended.txt'), 'utf8')).toBe('intended\n')
    expect(await readFile(join(b.repo, 'tracked.txt'), 'utf8')).toBe('changed\n')
  })
})

describe('localWrite on a path Git reads as more than one file', () => {
  it('refuses a deleted file whose path holds a directory, leaving the files in it unstaged and in place', async () => {
    const b = await setup()
    await rm(join(b.repo, 'tracked.txt'))
    await mkdir(join(b.repo, 'tracked.txt'))
    await writeFile(join(b.repo, 'tracked.txt', 'inner.md'), 'inner\n')
    await writeFile(join(b.repo, 'tracked.txt', 'other.md'), 'other\n')
    const files = await b.seen('tracked.txt')

    // Git would stage the two files with the deletion, and would delete them to restore the file.
    for (const kind of ['stage', 'restore'] as const) {
      const failure = await rejectionOf(b.write({ kind, files }))
      expect(failure).toBeInstanceOf(LocalPathReplaced)
      expect(failure).toMatchObject({ message: 'tracked.txt is a directory now; stage or restore the files in it instead' })
    }
    expect(await git(b.repo, 'diff', '--cached', '--name-only')).toBe('')
    expect(await readFile(join(b.repo, 'tracked.txt', 'inner.md'), 'utf8')).toBe('inner\n')

    // Staging a file inside the directory stages the deletion with it, since the index holds no file above a file.
    await b.write({ kind: 'stage', files: await b.seen('tracked.txt/inner.md') })
    expect((await git(b.repo, 'diff', '--cached', '--name-status')).split('\n')).toEqual(['D\ttracked.txt', 'A\ttracked.txt/inner.md'])
  })

  it('stages and unstages a submodule at another commit, and offers it no restore', async () => {
    const b = await setup()
    // A nested repository recorded at its first commit and checked out at its second.
    const nested = await repository(b.repo, 'sub')
    const recorded = await git(nested, 'rev-parse', 'HEAD')
    await writeFile(join(nested, 'tracked.txt'), 'second\n')
    await git(nested, 'commit', '--quiet', '-am', 'second')
    await git(b.repo, 'update-index', '--add', '--cacheinfo', `160000,${recorded},sub`)
    await git(b.repo, 'commit', '--quiet', '-m', 'record the submodule')
    const files = await b.seen('sub')
    const { files: unstaged } = await localDiff(b.ctx, b.config, b.session, b.repo, null, { kind: 'unstaged' }, LAYERS, new AbortController().signal)
    expect(unstaged.map(file => [file.path, file.status, file.submodule])).toEqual([['sub', 'modified', true]])

    // `git restore` would exit with success and leave the second commit checked out.
    await expect(b.write({ kind: 'restore', files })).rejects.toThrow('sub is a submodule or has no index content, so it cannot be restored')
    expect(await git(nested, 'log', '-1', '--format=%s')).toBe('second')

    await b.write({ kind: 'stage', files })
    expect(await b.status()).toEqual(['M  sub'])
    await b.write({ kind: 'unstage', paths: ['sub'] })
    expect(await b.status()).toEqual([' M sub'])
  })
})

describe('localWrite authority', () => {
  it('writes under a read-only Session, confining the reread of the scope and none of the writing commands', async () => {
    const b = await setup()
    setSandboxMode(b.session, 'read-only')
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    const files = await b.seen('tracked.txt')
    b.record.calls.length = 0

    await b.write({ kind: 'stage', files })

    const confined = b.record.calls.map(call => call.argv)
    expect(confined.some(argv => argv.includes('diff'))).toBe(true)
    expect(confined.filter(argv => argv.includes('add') || argv.includes('write-tree'))).toEqual([])
    expect(b.record.calls.every(call => call.policy.mode === 'read-only')).toBe(true)
    expect(await b.status()).toEqual(['M  tracked.txt'])
  })

  it('restores without entering submodules, whatever the repository configures', async () => {
    const b = await setup()
    await git(b.repo, 'config', 'submodule.recurse', 'true')
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    const spawned = vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn')

    await b.write({ kind: 'restore', files: await b.seen('tracked.txt') })

    const restore = spawned.mock.calls.map(([spec]) => spec.argv).find(argv => argv.includes('restore'))
    expect(restore).toEqual(expect.arrayContaining(['--literal-pathspecs', 'restore', '--worktree', '--no-recurse-submodules', '--', 'tracked.txt']))
    expect(await b.status()).toEqual([])
  })
})

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('localWrite beside the platform sandbox', () => {
  it('stages for a read-only Session, whose own commands the sandbox keeps from the index', async ({ skip }) => {
    const b = await setup(repository, true)
    await writeFile(join(b.repo, 'tracked.txt'), 'changed\n')
    setSandboxMode(b.session, 'read-only')
    let files: ForgeLocalWriteFile[]
    try {
      files = await b.seen('tracked.txt')
    } catch (error) {
      if (!(error instanceof SandboxUnavailableError)) throw error
      skip() // Hosts without an enforcing backend retain the recording-sandbox coverage above.
      return
    }

    await b.write({ kind: 'stage', files })

    expect(await b.status()).toEqual(['M  tracked.txt'])
  })
})
