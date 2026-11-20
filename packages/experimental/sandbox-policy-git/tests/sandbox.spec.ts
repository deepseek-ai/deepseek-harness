/** The grant under the local process sandbox: Git in a linked worktree writes its repository, and a forged pointer gains nothing. */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import * as sandboxPolicyGit from '../src/index.ts'
import { announced, cleanup, compose, extraRoots, git, scratch, worktree } from './harness.ts'

const execute = promisify(execFile)
const DENIED = /permission denied|operation not permitted|read-only file system/i

const sandboxUsable = await (async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false
  const probe = new Context()
  try {
    await probe.plugin(LocalSandbox)
    await probe.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally {
    await probe.fiber.dispose()
  }
})()

afterEach(cleanup)

/** Repositories live in the source tree: temporary directories are writable under `workspace-write` by themselves. */
async function mounted(
  additionalWritableRoots: (base: string) => string[] = () => [],
): Promise<{ ctx: Context; base: string; repo: string }> {
  const { base, repo } = await scratch(process.cwd())
  const ctx = await compose(base, additionalWritableRoots(base))
  await ctx.plugin(LocalSandbox)
  await ctx.plugin(sandboxPolicyGit)
  return { ctx, base, repo }
}

/** Run an argv in `cwd` confined by the Session's current policy. */
async function confined(ctx: Context, agent: Agent, cwd: string, ...argv: string[]): Promise<void> {
  const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
  if (policy.mode !== 'workspace-write') throw new Error(`unexpected mode ${policy.mode}`)
  const wrapped = await ctx.sandbox.confine(argv, { ...policy, mode: policy.mode })
  await execute(wrapped.argv[0]!, wrapped.argv.slice(1), {
    cwd,
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_DIR: undefined, GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_AUTHOR_NAME: 'Grant fixture', GIT_AUTHOR_EMAIL: 'grant@example.invalid',
      GIT_COMMITTER_NAME: 'Grant fixture', GIT_COMMITTER_EMAIL: 'grant@example.invalid',
    },
  })
}

const COMMIT = ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'from the worktree']
const WRITE = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "written\\n")']

describe.skipIf(!sandboxUsable)('linked worktree grant under the process sandbox', () => {
  it('lets a Session commit in the worktree it works in, and no longer once it works elsewhere', async () => {
    const { ctx, base, repo } = await mounted()
    const linked = await worktree(repo, base, 'linked')
    await mkdir(join(base, 'elsewhere'))
    const { agent } = await announced(ctx, linked, 'committing')

    await confined(ctx, agent, linked, ...COMMIT)
    expect(await git(linked, 'log', '-1', '--format=%s')).toBe('from the worktree')

    await ctx.workingDirectory.set(agent, join(base, 'elsewhere'))
    await expect(confined(ctx, agent, linked, ...COMMIT)).rejects.toThrow(DENIED)
    expect(await git(linked, 'rev-list', '--count', 'HEAD')).toBe('2')
  })

  it('leaves a repository unwritable for a checkout whose pointer names another worktree\'s administration directory', async () => {
    const { ctx, base, repo } = await mounted()
    await worktree(repo, base, 'victim')
    const thief = join(base, 'thief')
    await mkdir(thief)
    await writeFile(join(thief, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'victim')}\n`)
    const { agent } = await announced(ctx, thief, 'forging')

    expect(extraRoots(ctx, agent)).toBeUndefined()
    await confined(ctx, agent, thief, ...WRITE, join(thief, 'inside.txt'))
    await expect(confined(ctx, agent, thief, ...WRITE, join(repo, '.git', 'forged'))).rejects.toThrow(DENIED)
  })

  it('leaves the parent unwritable when the pointer files lie in a directory the deployment granted', async () => {
    const { ctx, base } = await mounted(scratchBase => [join(scratchBase, 'code', 'worktrees', 'granted')])
    const parent = join(base, 'code')
    const granted = join(parent, 'worktrees', 'granted')
    const root = join(base, 'project')
    await mkdir(granted, { recursive: true })
    await mkdir(root)
    await writeFile(join(root, '.git'), `gitdir: ${granted}\n`)
    await writeFile(join(granted, 'commondir'), '../..\n')
    await writeFile(join(granted, 'gitdir'), `${join(root, '.git')}\n`)
    const { agent } = await announced(ctx, root, 'granted-elsewhere')

    expect(extraRoots(ctx, agent)).toEqual([granted])
    await confined(ctx, agent, root, ...WRITE, join(granted, 'inside.txt'))
    await expect(confined(ctx, agent, root, ...WRITE, join(parent, 'outside.txt'))).rejects.toThrow(DENIED)
  })
})
