/** The workspace-write boundary follows the Session's workspace root, and a linked checkout's Git administration directories join it. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'

const execute = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  })
  return result.stdout.trim()
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A scratch directory holding a committed repository and room for checkouts beside it. */
async function scratch(): Promise<{ base: string; repo: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-policy-root-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.name', 'Policy fixture')
  await git(repo, 'config', 'user.email', 'policy@example.invalid')
  await git(repo, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'tracked.txt'), 'initial\n')
  await git(repo, 'add', 'tracked.txt')
  await git(repo, 'commit', '-q', '-m', 'initial')
  return { base, repo }
}

async function mounted(base: string, config: { mode?: 'workspace-write'; additionalWritableRoots?: string[] } = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: base })
  await ctx.plugin(WorkingDirectoryService, {})
  const fiber = await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: base, ...config })
  return { ctx, fiber }
}

function agentFor(ctx: Context, session: Session): Agent {
  const scope = ctx.plugin(() => {})
  return {
    id: session.id, session, options: {}, status: 'idle', ctx: scope.ctx, model: unsupportedModel(),
    inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
}

/** Run the tool pre-execution waterfall the way the tool pipeline does for one Agent. */
async function preExecute(ctx: Context, agent: Agent): Promise<void> {
  const exec = { agent, signal: new AbortController().signal }
  await ctx.waterfall('tools/pre-execute', exec as never, () => Promise.resolve(undefined as never))
}

describe('workspace root as the write boundary', () => {
  it('follows the Session into a worktree and back to the original project', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const worktree = join(repo, '.agents', 'worktrees', 'topic')
    await mkdir(join(repo, '.agents', 'worktrees'), { recursive: true })
    await git(repo, 'worktree', 'add', '-q', '-b', 'topic', worktree)
    const session = ctx.sessions.create(SessionId('boundary'), { meta: { cwd: repo } })
    const agent = agentFor(ctx, session)
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)

    await ctx.workingDirectory.set(agent, join(repo, '.agents'))
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)

    await ctx.workingDirectory.relocate(agent, worktree)
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(worktree)
    // An agentless tool execution has no root to prepare and passes through.
    await ctx.waterfall('tools/pre-execute', { signal: new AbortController().signal } as never, () => Promise.resolve(undefined as never))
    await preExecute(ctx, agent)
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({
      mode: 'workspace-write', workspaceRoot: worktree, additionalWritableRoots: [join(repo, '.git')], sessionId: session.id,
    })

    await ctx.workingDirectory.set(agent, repo)
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({ mode: 'workspace-write', workspaceRoot: repo, sessionId: session.id })
  })

  it('falls back to the configured root for a Session without a recorded directory while the directory service is mounted', async () => {
    const { base } = await scratch()
    const { ctx } = await mounted(base)
    const session = ctx.sessions.create(SessionId('no-directory'))
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(base)
    expect(await ctx.sandboxPolicy.prepare(session)).toEqual([])
  })
})

describe('Git administration directories of a linked checkout', () => {
  it('derives the common directory for a Session opened inside a linked worktree and merges configured extras', async () => {
    const { base, repo } = await scratch()
    const extra = join(base, 'extra')
    await mkdir(extra)
    const { ctx } = await mounted(base, { additionalWritableRoots: [extra] })
    const worktree = join(base, 'elsewhere', 'wt')
    await mkdir(join(base, 'elsewhere'))
    await git(repo, 'worktree', 'add', '-q', '-b', 'wt', worktree)
    const session = ctx.sessions.create(SessionId('linked'), { meta: { cwd: worktree } })
    // Session creation starts the derivation; a tool execution waits for it.
    await preExecute(ctx, agentFor(ctx, session))
    const policy = ctx.sandboxPolicy.resolve({ session })
    expect(policy.workspaceRoot).toBe(worktree)
    expect(policy.additionalWritableRoots).toEqual([extra, join(repo, '.git')])
    expect(Object.isFrozen(policy.additionalWritableRoots)).toBe(true)
    expect(await ctx.sandboxPolicy.prepare(session)).toEqual([join(repo, '.git')])
    expect(ctx.sandboxPolicy.resolve()).toEqual({ mode: 'workspace-write', workspaceRoot: base, additionalWritableRoots: [extra] })
  })

  it('adds nothing for a checkout whose .git is a directory and retries a root that has no .git entry yet', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const plain = ctx.sessions.create(SessionId('plain'), { meta: { cwd: repo } })
    expect(await ctx.sandboxPolicy.prepare(plain)).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session: plain })).toEqual({ mode: 'workspace-write', workspaceRoot: repo, sessionId: plain.id })

    const later = join(base, 'later')
    const session = ctx.sessions.create(SessionId('later'), { meta: { cwd: later } })
    expect(await ctx.sandboxPolicy.prepare(session)).toEqual([])
    await git(repo, 'worktree', 'add', '-q', '-b', 'later', later)
    expect(await ctx.sandboxPolicy.prepare(session)).toEqual([join(repo, '.git')])
    expect(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots).toEqual([join(repo, '.git')])
  })

  it('keeps only existing directories outside the root and tolerates malformed pointer files', async () => {
    const { base } = await scratch()
    const { ctx } = await mounted(base)
    const administration = join(base, 'administration')
    await mkdir(administration)
    const handmade = join(base, 'handmade')
    await mkdir(handmade)
    await writeFile(join(handmade, '.git'), `gitdir: ${administration}\n`)
    const handmadeSession = ctx.sessions.create(SessionId('handmade'), { meta: { cwd: handmade } })
    expect(await ctx.sandboxPolicy.prepare(handmadeSession)).toEqual([administration])

    const blank = join(base, 'blank-common')
    await mkdir(blank)
    await writeFile(join(blank, 'commondir'), '')
    const blankSession = ctx.sessions.create(SessionId('blank-common'), { meta: { cwd: join(base, 'blank-checkout') } })
    await mkdir(join(base, 'blank-checkout'))
    await writeFile(join(base, 'blank-checkout', '.git'), `gitdir: ${blank}\n`)
    expect(await ctx.sandboxPolicy.prepare(blankSession)).toEqual([blank])

    const dangling = join(base, 'dangling')
    await mkdir(dangling)
    await writeFile(join(dangling, '.git'), `gitdir: ${join(base, 'missing-administration')}\n`)
    expect(await ctx.sandboxPolicy.prepare(ctx.sessions.create(SessionId('dangling'), { meta: { cwd: dangling } }))).toEqual([])

    const missingCommon = join(base, 'missing-common')
    await mkdir(join(missingCommon, 'admin'), { recursive: true })
    await writeFile(join(missingCommon, 'admin', 'commondir'), '../nowhere\n')
    await writeFile(join(missingCommon, '.git'), 'gitdir: admin\n')
    expect(await ctx.sandboxPolicy.prepare(ctx.sessions.create(SessionId('missing-common'), { meta: { cwd: missingCommon } }))).toEqual([])

    const malformed = join(base, 'malformed')
    await mkdir(malformed)
    await writeFile(join(malformed, '.git'), 'not a pointer\n')
    expect(await ctx.sandboxPolicy.prepare(ctx.sessions.create(SessionId('malformed'), { meta: { cwd: malformed } }))).toEqual([])
  })

  it('logs a failed read, grants nothing for it, and derives again on the next call', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const worktree = join(base, 'retry')
    await git(repo, 'worktree', 'add', '-q', '-b', 'retry', worktree)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const lstat = vi.spyOn(ctx.fs, 'lstat').mockRejectedValueOnce(new Error('disk unavailable'))
    try {
      const session = ctx.sessions.create(SessionId('retry'), { meta: { cwd: worktree } })
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(1) })
      expect(warn.mock.calls[0]?.[0]).toContain('could not derive the Git administration directories')
      expect(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots).toBeUndefined()
      expect(await ctx.sandboxPolicy.prepare(session)).toEqual([join(repo, '.git')])
    } finally {
      lstat.mockRestore()
      warn.mockRestore()
    }
  })

  it('shares one derivation between concurrent callers and rejects callers when the service is disposed first', async () => {
    const { base, repo } = await scratch()
    const { ctx, fiber } = await mounted(base)
    const worktree = join(base, 'shared')
    await git(repo, 'worktree', 'add', '-q', '-b', 'shared', worktree)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const lstat = ctx.fs.lstat.bind(ctx.fs)
    const probe = vi.spyOn(ctx.fs, 'lstat').mockImplementation(async (path, opts, signal) => {
      entered.resolve(undefined)
      await release.promise
      signal?.throwIfAborted()
      return lstat(path, opts, signal)
    })
    try {
      const session = ctx.sessions.create(SessionId('shared'), { meta: { cwd: worktree } })
      await entered.promise
      const first = ctx.sandboxPolicy.prepare(session)
      const second = ctx.sandboxPolicy.prepare(session)
      expect(probe).toHaveBeenCalledTimes(1)
      const disposal = fiber.dispose()
      release.resolve(undefined)
      await expect(first).rejects.toThrow('sandbox-policy service disposed')
      await expect(second).rejects.toThrow('sandbox-policy service disposed')
      await disposal
    } finally {
      release.resolve(undefined)
      probe.mockRestore()
    }
  })

  it('derives nothing without a filesystem provider', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/fallback' })
    const session = ctx.sessions.create(SessionId('no-fs'), { meta: { cwd: '/projects/current' } })
    expect(await ctx.sandboxPolicy.prepare(session)).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({ mode: 'workspace-write', workspaceRoot: '/projects/current', sessionId: session.id })
  })
})
