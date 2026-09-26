/** Git command bounds, snapshot recovery, and diff failure reporting. */
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner, blobText, diffTrees, ignoredPaths, locateGitWorkspace, snapshotTree, treeBlob } from '../src/git.ts'
import { TurnRecorder } from '../src/recorder.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { git, scratchDir, startTurn, toolCall } from './support.ts'

/** An object directory factory under a scratch root. */
const objectsIn = (root: string) => () => Promise.resolve(join(root, 'objects'))

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function runner(limits = { timeoutMs: 30_000, outputMaxBytes: 1024 * 1024 }, executable = 'git') {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  return { ctx, git: new GitRunner(ctx.subprocess, await ctx.subprocess.resolveExecutable(executable).catch(() => executable), limits) }
}

const signal = new AbortController().signal

describe('GitRunner', () => {
  it('ignores ambient indexed Git configuration after the credential scrub', async () => {
    const cwd = await scratchDir('dsh-git-env-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    const { git: command } = await runner()
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true')
    try {
      const result = await command.run(['rev-parse', '--is-bare-repository'], { cwd, signal })
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('false')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports timeouts and external aborts as failures', async () => {
    const cwd = await scratchDir('dsh-git-runner-', cleanups)
    const { git: slow } = await runner({ timeoutMs: 1, outputMaxBytes: 1024 })
    await expect(slow.run(['--version'], { cwd, signal })).rejects.toThrow('timed out after 1ms')
    const { git: quick } = await runner()
    const aborted = new AbortController()
    setTimeout(() => { aborted.abort() }, 0)
    await expect(quick.run(['--version'], { cwd, signal: aborted.signal })).rejects.toThrow('git --version was aborted')
    const ok = await quick.run(['--version'], { cwd, signal })
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toContain('git version')
  })
})

describe('snapshots and diffs', () => {
  it('snapshots a repository whose index holds unmerged entries without touching that index', async () => {
    const cwd = await scratchDir('dsh-git-conflict-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await writeFile(join(cwd, 'f.txt'), 'base\n')
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'base')
    git(cwd, 'checkout', '-q', '-b', 'side')
    await writeFile(join(cwd, 'f.txt'), 'side\n')
    git(cwd, 'commit', '-q', '-am', 'side')
    git(cwd, 'checkout', '-q', 'main')
    await writeFile(join(cwd, 'f.txt'), 'main\n')
    git(cwd, 'commit', '-q', '-am', 'main')
    expect(() => git(cwd, 'merge', 'side')).toThrow()
    expect(git(cwd, 'status', '--porcelain')).toContain('UU f.txt')
    const { git: runnerGit } = await runner()
    const workspace = await locateGitWorkspace(runnerGit, cwd, objectsIn(await scratchDir('dsh-git-store-', cleanups)), signal)
    expect(workspace?.root).toBe(await realpath(cwd))
    const tree = await snapshotTree(runnerGit, workspace!, signal)
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(git(cwd, 'status', '--porcelain')).toContain('UU f.txt')
  })

  it('fails loudly when the addressed repository cannot be written or diffed', async () => {
    const cwd = await scratchDir('dsh-git-broken-', cleanups)
    const { git: runnerGit } = await runner()
    const store = objectsIn(await scratchDir('dsh-git-store-', cleanups))
    expect(await locateGitWorkspace(runnerGit, cwd, store, signal)).toBeNull()
    const broken = { root: cwd, gitDir: join(cwd, 'missing'), scratch: cwd, env: {}, excludes: [] }
    await expect(snapshotTree(runnerGit, broken, signal)).rejects.toThrow('git add in')
    await expect(ignoredPaths(runnerGit, broken, ['x'], signal)).rejects.toThrow('git check-ignore failed')
    expect(await ignoredPaths(runnerGit, broken, [], signal)).toEqual(new Set())
    git(cwd, 'init', '-q')
    const workspace = (await locateGitWorkspace(runnerGit, cwd, store, signal))!
    await expect(diffTrees(runnerGit, workspace, 'a'.repeat(40), 'b'.repeat(40), signal)).rejects.toThrow('git diff-tree failed')
    await writeFile(join(cwd, 'many.txt'), Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n'))
    const before = await snapshotTree(runnerGit, workspace, signal)
    await writeFile(join(cwd, 'many.txt'), 'gone')
    for (let index = 0; index < 20; index += 1) await writeFile(join(cwd, `file-${index}.txt`), 'x\n')
    const after = await snapshotTree(runnerGit, workspace, signal)
    const { git: tiny } = await runner({ timeoutMs: 30_000, outputMaxBytes: 16 })
    await expect(diffTrees(tiny, workspace, before, after, signal)).rejects.toThrow('exceeded')
    expect((await diffTrees(runnerGit, workspace, before, after, signal)).length).toBe(21)
  })

})

describe('repository edge cases', () => {
  it.skipIf(process.platform === 'win32')('snapshots past an unreadable file', async () => {
    const cwd = await scratchDir('dsh-git-unreadable-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await writeFile(join(cwd, 'ok.txt'), 'ok\n')
    await writeFile(join(cwd, 'locked.txt'), 'locked\n')
    await chmod(join(cwd, 'locked.txt'), 0o000)
    cleanups.push(() => chmod(join(cwd, 'locked.txt'), 0o644))
    const { git: runnerGit } = await runner()
    const store = objectsIn(await scratchDir('dsh-git-store-', cleanups))
    const workspace = (await locateGitWorkspace(runnerGit, cwd, store, signal))!
    expect(await snapshotTree(runnerGit, workspace, signal)).toMatch(/^[0-9a-f]{40,64}$/)
  })

  it('refuses an index that exists but cannot be copied instead of starting from an empty one', async () => {
    const cwd = await scratchDir('dsh-git-bad-index-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await mkdir(join(cwd, '.git', 'index'))
    const { git: runnerGit } = await runner()
    const store = objectsIn(await scratchDir('dsh-git-store-', cleanups))
    const workspace = (await locateGitWorkspace(runnerGit, cwd, store, signal))!
    await expect(snapshotTree(runnerGit, workspace, signal)).rejects.toThrow()
  })

  it('reports a repository git cannot read instead of treating it as absent', async () => {
    const cwd = await scratchDir('dsh-git-unsupported-', cleanups)
    git(cwd, 'init', '-q')
    const config = join(cwd, '.git', 'config')
    const original = await readFile(config, 'utf8')
    await writeFile(config, original.replace(/repositoryformatversion = \d+/, 'repositoryformatversion = 99'))
    const { git: runnerGit } = await runner()
    const store = objectsIn(await scratchDir('dsh-git-store-', cleanups))
    await expect(locateGitWorkspace(runnerGit, cwd, store, signal)).rejects.toThrow('git rev-parse failed')
    await writeFile(config, original)
    const blocked = join(cwd, 'store-file')
    await writeFile(blocked, 'not a directory')
    await expect(locateGitWorkspace(runnerGit, cwd, objectsIn(blocked), signal)).rejects.toThrow()
  })
})

describe('treeBlob and blobText', () => {
  it('locates a blob by its literal path, sizes it, reads it, and reports trees and missing paths as null', async () => {
    const cwd = await scratchDir('dsh-git-blob-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await mkdir(join(cwd, 'dir'))
    await writeFile(join(cwd, 'dir', 'inner.txt'), 'inner\n')
    await writeFile(join(cwd, 'a[1].txt'), 'bracket\n')
    await writeFile(join(cwd, 'a1.txt'), 'plain\n')
    const { git: runnerGit } = await runner()
    const workspace = await locateGitWorkspace(runnerGit, cwd, objectsIn(await scratchDir('dsh-git-store-', cleanups)), signal)
    if (workspace === null) throw new Error('repository not located')
    const tree = await snapshotTree(runnerGit, workspace, signal)
    const bracket = await treeBlob(runnerGit, workspace, tree, 'a[1].txt', signal)
    expect(bracket).toEqual({ oid: git(cwd, 'hash-object', 'a[1].txt').trim(), size: 8 })
    expect(await blobText(runnerGit, workspace, bracket!.oid, 64, signal)).toBe('bracket\n')
    expect(await treeBlob(runnerGit, workspace, tree, 'dir', signal)).toBeNull()
    expect(await treeBlob(runnerGit, workspace, tree, 'missing.txt', signal)).toBeNull()
    expect(await treeBlob(runnerGit, workspace, tree, 'dir/inner.txt', signal)).toMatchObject({ size: 6 })
  })
})

describe('TurnRecorder', () => {
  it('stays silent when disposed while git work is pending, and warns on failures otherwise', async () => {
    const cwd = await scratchDir('dsh-recorder-', cleanups)
    const { ctx, git: runnerGit } = await runner()
    const session = ctx.sessions.create(SessionId('recorder'), { meta: { cwd } })
    const warnings: string[] = []
    let release!: (runner: GitRunner | null) => void
    const gate = new Promise<GitRunner | null>((resolve) => { release = resolve })
    const tempRoot = await scratchDir('dsh-git-store-', cleanups)
    const env = { git: gate, tempRoot, maxFiles: 10, maxFileBytes: 1024, diffTimeoutMs: 100, warn: (m: string) => { warnings.push(m) } }
    const disposed = new TurnRecorder(session, cwd, env)
    disposed.start(1)
    await new Promise(resolve => setTimeout(resolve, 5))
    const disposal = disposed.dispose()
    release(runnerGit)
    await disposal
    disposed.start(2)
    await disposed.settled()
    expect(warnings).toEqual([])
    expect(disposed.summary(1)).toBeUndefined()

    const { git: missing } = await runner(undefined, '/nonexistent/git-binary')
    const failing = new TurnRecorder(session, cwd, { ...env, git: Promise.resolve(missing) })
    failing.start(1)
    await failing.settled()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('workspace-changes:')
  })

  it('removes its snapshot objects on disposal and never creates them outside a repository', async () => {
    const tempRoot = await scratchDir('dsh-git-store-', cleanups)
    const { ctx, git: runnerGit } = await runner()
    const env = {
      git: Promise.resolve(runnerGit), tempRoot, maxFiles: 10, maxFileBytes: 1024, diffTimeoutMs: 100,
      warn: (m: string) => { throw new Error(m) },
    }
    const plain = new TurnRecorder(ctx.sessions.create(SessionId('plain'), { meta: { cwd: tempRoot } }), tempRoot, env)
    plain.start(1)
    await plain.settled()
    await plain.dispose()
    const cwd = await scratchDir('dsh-recorder-repo-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    const repo = new TurnRecorder(ctx.sessions.create(SessionId('repo'), { meta: { cwd } }), cwd, env)
    repo.start(1)
    await repo.settled()
    const [objects, ...others] = (await readdir(tempRoot)).filter(entry => entry.startsWith('dsh-workspace-changes-'))
    expect(others).toEqual([])
    expect(objects).toBeDefined()
    await repo.dispose()
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('keeps its own directory out of the snapshots when the temporary root lies inside the work tree', async () => {
    const cwd = await scratchDir('dsh-recorder-tmp-in-tree-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await writeFile(join(cwd, 'tracked.txt'), 'one\n')
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'init')
    const tempRoot = join(cwd, 'tmp')
    await mkdir(tempRoot)
    const { ctx, git: runnerGit } = await runner()
    const session = ctx.sessions.create(SessionId('tmp-in-tree'), { meta: { cwd } })
    const env = {
      git: Promise.resolve(runnerGit), tempRoot, maxFiles: 10, maxFileBytes: 1024, diffTimeoutMs: 100,
      warn: (m: string) => { throw new Error(m) },
    }
    const recorder = new TurnRecorder(session, cwd, env)
    startTurn(session, 1)
    recorder.start(1)
    await recorder.settled()
    await writeFile(join(cwd, 'tracked.txt'), 'one\ntwo\n')
    recorder.observe(toolCall(session, 1, 'bash', { command: 'x' }))
    await recorder.stopping(1)
    const announced = session.snapshotEvents().find(event => event.type === 'workspace/changes')
    expect(recorder.summary(announced!.seq)?.files.map(file => file.display)).toEqual(['tracked.txt'])
    await recorder.dispose()
  })
})
