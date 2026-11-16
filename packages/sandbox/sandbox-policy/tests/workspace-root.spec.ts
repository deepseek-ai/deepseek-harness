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
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'

const execute = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_DIR: undefined, GIT_WORK_TREE: undefined,
      // Commits need an identity the host cannot infer once global configuration is disabled.
      GIT_AUTHOR_NAME: 'Policy fixture', GIT_AUTHOR_EMAIL: 'policy@example.invalid',
      GIT_COMMITTER_NAME: 'Policy fixture', GIT_COMMITTER_EMAIL: 'policy@example.invalid',
    },
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
  await git(repo, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'tracked.txt'), 'initial\n')
  await git(repo, 'add', 'tracked.txt')
  await git(repo, 'commit', '-q', '-m', 'initial')
  return { base, repo }
}

async function mounted(
  base: string, config: { mode?: 'workspace-write'; additionalWritableRoots?: string[] } = {}, defaultDirectory?: string,
) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: base })
  await ctx.plugin(WorkingDirectoryService, defaultDirectory === undefined ? {} : { defaultDirectory })
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
    const session = ctx.sessions.create(brandString<SessionId>('boundary'), { meta: { cwd: repo } })
    const agent = agentFor(ctx, session)
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)

    // A working-directory/change, as earlier logs hold, moves the boundary only to a directory inside the project.
    session.append('working-directory/change', { cwd: join(repo, '.agents') })
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(join(repo, '.agents'))
    session.append('working-directory/change', { cwd: base })
    expect(ctx.workingDirectory.get(session)).toBe(repo)
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)

    await ctx.workingDirectory.set(agent, worktree)
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

  it('bounds a Host operation to another checkout on request and derives that checkout\'s Git administration', async () => {
    const { base, repo } = await scratch()
    const extra = join(base, 'extra')
    await mkdir(extra)
    const { ctx } = await mounted(base, { additionalWritableRoots: [extra] })
    const worktree = join(base, 'wt')
    await git(repo, 'worktree', 'add', '-q', '-b', 'wt', worktree)
    const other = join(base, 'other')
    await git(repo, 'worktree', 'add', '-q', '-b', 'other', other)
    const session = ctx.sessions.create(brandString<SessionId>('maintenance'), { meta: { cwd: worktree } })
    expect(await ctx.sandboxPolicy.prepare({ session })).toEqual([join(repo, '.git')])
    // The source checkout keeps its Git directory inside itself, so nothing is derived for it.
    expect(await ctx.sandboxPolicy.prepare({ session, root: repo })).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session, root: repo })).toEqual({
      mode: 'workspace-write', workspaceRoot: repo, additionalWritableRoots: [extra], sessionId: session.id,
    })
    expect(await ctx.sandboxPolicy.prepare({ session, root: other })).toEqual([join(repo, '.git')])
    expect(ctx.sandboxPolicy.resolve({ session, root: other }).additionalWritableRoots).toEqual([extra, join(repo, '.git')])
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(worktree)
    expect(() => ctx.sandboxPolicy.resolve({ session, root: 'relative' })).toThrow('absolute execution-world path')
    await expect(ctx.sandboxPolicy.prepare({ session, root: 'relative' })).rejects.toThrow('absolute execution-world path')
  })

  it('bounds a Session without a recorded directory by the directory service\'s default directory', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base, {}, repo)
    const session = ctx.sessions.create(brandString<SessionId>('no-directory'))
    // Relative paths of such a Session resolve from that default, so it is the boundary; the policy's
    // configured root serves agentless calls.
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)
    expect(ctx.sandboxPolicy.resolve().workspaceRoot).toBe(base)
    expect(await ctx.sandboxPolicy.prepare({ session: session })).toEqual([])
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
    const session = ctx.sessions.create(brandString<SessionId>('linked'), { meta: { cwd: worktree } })
    // Session creation starts the derivation; a tool execution waits for it.
    await preExecute(ctx, agentFor(ctx, session))
    const policy = ctx.sandboxPolicy.resolve({ session })
    expect(policy.workspaceRoot).toBe(worktree)
    expect(policy.additionalWritableRoots).toEqual([extra, join(repo, '.git')])
    expect(Object.isFrozen(policy.additionalWritableRoots)).toBe(true)
    expect(await ctx.sandboxPolicy.prepare({ session: session })).toEqual([join(repo, '.git')])
    expect(ctx.sandboxPolicy.resolve()).toEqual({ mode: 'workspace-write', workspaceRoot: base, additionalWritableRoots: [extra] })
  })

  it('settles a root once its layout was read and reads it again only when a Host operation moves a workspace into it', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const plain = ctx.sessions.create(brandString<SessionId>('plain'), { meta: { cwd: repo } })
    expect(await ctx.sandboxPolicy.prepare({ session: plain })).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session: plain })).toEqual({ mode: 'workspace-write', workspaceRoot: repo, sessionId: plain.id })

    // A directory that is no checkout yet settles as granting nothing; a worktree created there afterwards
    // does not widen the policy of a Session already working in it, nor can a pointer written by the model.
    const later = join(base, 'later')
    const early = ctx.sessions.create(brandString<SessionId>('early'), { meta: { cwd: later } })
    expect(await ctx.sandboxPolicy.prepare({ session: early })).toEqual([])
    await git(repo, 'worktree', 'add', '-q', '-b', 'later', later)
    expect(await ctx.sandboxPolicy.prepare({ session: early })).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session: early }).additionalWritableRoots).toBeUndefined()

    // A Host move of a workspace into the checkout reads its layout again.
    const entering = ctx.sessions.create(brandString<SessionId>('entering'), { meta: { cwd: repo } })
    await ctx.workingDirectory.set(agentFor(ctx, entering), later)
    expect(await ctx.sandboxPolicy.prepare({ session: entering })).toEqual([join(repo, '.git')])
    expect(await ctx.sandboxPolicy.prepare({ session: early })).toEqual([join(repo, '.git')])
  })

  it('grants nothing for pointer files the checkout itself could have written', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const sessionIn = (name: string) => ctx.sessions.create(brandString<SessionId>(name), { meta: { cwd: join(base, name) } })
    const checkout = async (name: string, pointer: string) => {
      await mkdir(join(base, name), { recursive: true })
      await writeFile(join(base, name, '.git'), pointer)
      return sessionIn(name)
    }

    // A pointer to the filesystem root, to the home of the workspace, or to any directory outside Git's
    // worktree layout names no administration directory.
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('root-pointer', 'gitdir: /\n') })).toEqual([])
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('base-pointer', `gitdir: ${base}\n`) })).toEqual([])
    const administration = join(base, 'administration')
    await mkdir(administration)
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('handmade', `gitdir: ${administration}\n`) })).toEqual([])

    // A forged worktree layout whose commondir escapes, or whose administration directory does not point
    // back at the checkout, grants nothing; a layout whose common directory contains the root grants nothing.
    const forgedCommon = join(base, 'forged', 'worktrees', 'x')
    await mkdir(forgedCommon, { recursive: true })
    await writeFile(join(forgedCommon, 'commondir'), '/\n')
    await writeFile(join(forgedCommon, 'gitdir'), `${join(base, 'escaping', '.git')}\n`)
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('escaping', `gitdir: ${forgedCommon}\n`) })).toEqual([])
    await writeFile(join(forgedCommon, 'commondir'), '../..\n')
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('unlinked', `gitdir: ${forgedCommon}\n`) })).toEqual([])
    const enclosing = join(base, 'worktrees', 'inner')
    await mkdir(enclosing, { recursive: true })
    await writeFile(join(enclosing, 'commondir'), '../..\n')
    await writeFile(join(enclosing, 'gitdir'), `${join(base, 'enclosed', '.git')}\n`)
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('enclosed', `gitdir: ${enclosing}\n`) })).toEqual([])

    // A missing commondir or gitdir file, a commondir that is a directory, and a missing gitdir text grant nothing.
    const partial = join(base, 'partial', 'worktrees', 'z')
    await mkdir(join(partial, 'commondir'), { recursive: true })
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('partial-checkout', `gitdir: ${partial}\n`) })).toEqual([])
    const noBack = join(base, 'no-back', 'worktrees', 'w')
    await mkdir(noBack, { recursive: true })
    await writeFile(join(noBack, 'commondir'), '../..\n')
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('no-back-checkout', `gitdir: ${noBack}\n`) })).toEqual([])
    await writeFile(join(noBack, 'gitdir'), '\n')
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('blank-back-checkout', `gitdir: ${noBack}\n`) })).toEqual([])

    // Dangling, blank, and malformed pointers grant nothing either.
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('dangling', `gitdir: ${join(base, 'missing-administration')}\n`) })).toEqual([])
    const blank = join(base, 'blank', 'worktrees', 'y')
    await mkdir(blank, { recursive: true })
    await writeFile(join(blank, 'commondir'), '')
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('blank-checkout', `gitdir: ${blank}\n`) })).toEqual([])
    expect(await ctx.sandboxPolicy.prepare({ session: await checkout('malformed', 'not a pointer\n') })).toEqual([])

    // The layout Git writes still grants the common directory, and nothing else.
    const worktree = join(base, 'genuine')
    await git(repo, 'worktree', 'add', '-q', '-b', 'genuine', worktree)
    expect(await ctx.sandboxPolicy.prepare({ session: sessionIn('genuine') })).toEqual([join(repo, '.git')])
  })

  it('derives again when a derived directory disappears and keeps confinement resolvable', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const worktree = join(base, 'orphaned')
    await git(repo, 'worktree', 'add', '-q', '-b', 'orphaned', worktree)
    const session = ctx.sessions.create(brandString<SessionId>('orphaned'), { meta: { cwd: worktree } })
    expect(await ctx.sandboxPolicy.prepare({ session: session })).toEqual([join(repo, '.git')])
    await rm(repo, { recursive: true, force: true })
    expect(await ctx.sandboxPolicy.prepare({ session: session })).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots).toBeUndefined()

    // An uninspectable directory invalidates the settled result the same way, and the derivation runs again.
    const again = join(base, 'again')
    await mkdir(join(base, 'again-repo'))
    await git(join(base, 'again-repo'), 'init', '-q', '-b', 'main')
    await git(join(base, 'again-repo'), 'commit', '-q', '--allow-empty', '-m', 'initial')
    await git(join(base, 'again-repo'), 'worktree', 'add', '-q', '-b', 'again', again)
    const other = ctx.sessions.create(brandString<SessionId>('again'), { meta: { cwd: again } })
    const common = join(base, 'again-repo', '.git')
    expect(await ctx.sandboxPolicy.prepare({ session: other })).toEqual([common])
    const probe = vi.spyOn(ctx.fs, 'lstat').mockImplementationOnce(async () => { throw new Error('inspection denied') })
    try {
      expect(await ctx.sandboxPolicy.prepare({ session: other })).toEqual([common])
      expect(probe.mock.calls[0]?.[0]).toBe(common)
      expect(probe.mock.calls.length).toBeGreaterThan(1)
    } finally {
      probe.mockRestore()
    }
  })

  it('renders the configured extra directories to the model, never the derived Git directories', async () => {
    const { base, repo } = await scratch()
    const extra = join(base, 'extra')
    await mkdir(extra)
    const worktree = join(base, 'rendered')
    await git(repo, 'worktree', 'add', '-q', '-b', 'rendered', worktree)
    for (const additionalWritableRoots of [undefined, [extra]]) {
      const { ctx } = await mounted(base, additionalWritableRoots === undefined ? {} : { additionalWritableRoots })
      const session = ctx.sessions.create(brandString<SessionId>(`rendered-${additionalWritableRoots === undefined ? 'plain' : 'extra'}`), { meta: { cwd: worktree } })
      const agent = agentFor(ctx, session)
      await preExecute(ctx, agent)
      expect(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots).toEqual([...additionalWritableRoots ?? [], join(repo, '.git')])
      const text = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent, scope: agent }))
      expect(text).toContain(`may modify files under the session workspace: ${JSON.stringify(worktree)}.`)
      expect(text).not.toContain(join(repo, '.git'))
      if (additionalWritableRoots === undefined) expect(text).not.toContain('Additional writable directories')
      else expect(text).toContain(`Additional writable directories: ${JSON.stringify(additionalWritableRoots)}.`)
    }
  })

  it('logs a failed read once per root, grants nothing for it, and derives again on the next call', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const worktree = join(base, 'retry')
    await git(repo, 'worktree', 'add', '-q', '-b', 'retry', worktree)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const lstat = vi.spyOn(ctx.fs, 'lstat')
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockRejectedValueOnce(new Error('disk unavailable'))
    try {
      const session = ctx.sessions.create(brandString<SessionId>('retry'), { meta: { cwd: worktree } })
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(1) })
      expect(warn.mock.calls[0]?.[0]).toContain('could not derive the Git administration directories')
      expect(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots).toBeUndefined()
      expect(await ctx.sandboxPolicy.prepare({ session: session })).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(await ctx.sandboxPolicy.prepare({ session: session })).toEqual([join(repo, '.git')])
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
      const session = ctx.sessions.create(brandString<SessionId>('shared'), { meta: { cwd: worktree } })
      await entered.promise
      const first = ctx.sandboxPolicy.prepare({ session: session })
      const second = ctx.sandboxPolicy.prepare({ session: session })
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
    const session = ctx.sessions.create(brandString<SessionId>('no-fs'), { meta: { cwd: '/projects/current' } })
    expect(await ctx.sandboxPolicy.prepare({ session: session })).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({ mode: 'workspace-write', workspaceRoot: '/projects/current', sessionId: session.id })
  })
})
