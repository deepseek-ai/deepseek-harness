/** The workspace-write boundary follows the Session's working directory. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
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

async function mounted(base: string, defaultDirectory?: string) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: base })
  await ctx.plugin(WorkingDirectoryService, defaultDirectory === undefined ? {} : { defaultDirectory })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: base })
  return { ctx }
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

describe('workspace root as the write boundary', () => {
  it('follows the Session into a linked worktree and back, granting only what is configured or registered', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base)
    const worktree = join(repo, '.agents', 'worktrees', 'topic')
    await mkdir(join(repo, '.agents', 'worktrees'), { recursive: true })
    await git(repo, 'worktree', 'add', '-q', '-b', 'topic', worktree)
    const session = ctx.sessions.create(brandString<SessionId>('boundary'), { meta: { cwd: repo } })
    const agent = agentFor(ctx, session)
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)

    // A working-directory/change, as earlier logs hold, moves neither the directory nor the boundary.
    session.append('working-directory/change', { cwd: join(repo, '.agents') })
    expect(ctx.workingDirectory.get(session)).toBe(repo)
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)

    // The repository's Git directory lies outside the worktree, and the policy reads no Git layout to grant it.
    await ctx.workingDirectory.set(agent, worktree)
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({ mode: 'workspace-write', workspaceRoot: worktree, sessionId: session.id })
    const revoke = ctx.sandboxPolicy.registerWritableRoot(session, join(repo, '.git'))
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({
      mode: 'workspace-write', workspaceRoot: worktree, additionalWritableRoots: [join(repo, '.git')], sessionId: session.id,
    })
    revoke()

    await ctx.workingDirectory.set(agent, repo)
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual({ mode: 'workspace-write', workspaceRoot: repo, sessionId: session.id })
  })

  it('bounds a Session without a recorded directory by the directory service\'s default directory', async () => {
    const { base, repo } = await scratch()
    const { ctx } = await mounted(base, repo)
    const session = ctx.sessions.create(brandString<SessionId>('no-directory'))
    // Relative paths of such a Session resolve from that default, so it is the boundary; the policy's
    // configured root serves agentless calls.
    expect(ctx.sandboxPolicy.resolve({ session }).workspaceRoot).toBe(repo)
    expect(ctx.sandboxPolicy.resolve().workspaceRoot).toBe(base)
  })
})
