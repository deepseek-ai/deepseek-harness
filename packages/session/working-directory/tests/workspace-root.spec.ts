/** Workspace roots: the root every recorded change moves with the directory, and the directory-only changes of earlier logs. */
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { brandString } from '@deepseek-ai/dsh-brand'

async function fixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-root-')))
  const root = join(scratch, 'repo')
  const worktree = join(scratch, 'elsewhere', 'wt')
  const outside = join(scratch, 'outside')
  await mkdir(join(root, 'packages', 'foo'), { recursive: true })
  await mkdir(join(worktree, 'src'), { recursive: true })
  await mkdir(outside)
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, {})
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(brandString<SessionId>('root-owner'), {}, { cwd: root })
    return {
      ctx, root, worktree, outside, agent, harness,
      notices: () => harness.claim(agent, 'next-step', 1).map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')),
      context: async () => renderContextSnapshot(await ctx.systemPrompt.assemble({ agent, scope: agent })),
      async [Symbol.asyncDispose]() {
        await ctx.fiber.dispose()
        await rm(scratch, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
}

/** Text of the notices one Agent has queued for its next step. */
function noticesOf(f: Awaited<ReturnType<typeof fixture>>, agent: Awaited<ReturnType<typeof fixture>>['agent']): string[] {
  return f.harness.claim(agent, 'next-step', 1).map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('Session workspace roots', () => {
  it('starts with the original project as the workspace root', async () => {
    await using f = await fixture()
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.ctx.workingDirectory.recordedRootOf(f.agent.session)).toBe(f.root)
    expect(f.ctx.sessionProjections.snapshot(f.agent.session).values.workspaceRoot).toBe(f.root)
    expect(await f.context()).toContain(`Current working directory: ${JSON.stringify(f.root)}.`)
  })

  it('moves the directory and the root together with one marked change per move', async () => {
    await using f = await fixture()
    await expect(f.ctx.workingDirectory.set(f.agent, f.worktree)).resolves.toBe(f.worktree)
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(f.worktree)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.worktree)
    expect(f.ctx.sessionProjections.snapshot(f.agent.session).values.workspaceRoot).toBe(f.worktree)
    expect(f.notices()).toEqual([`The working directory changed from ${JSON.stringify(f.root)} to ${JSON.stringify(f.worktree)}.`])

    await expect(f.ctx.workingDirectory.set(f.agent, f.outside)).resolves.toBe(f.outside)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.outside)
    await expect(f.ctx.workingDirectory.set(f.agent, f.root)).resolves.toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change').map(event => event.data)).toEqual([
      { cwd: f.worktree, workspace: true },
      { cwd: f.outside, workspace: true },
      { cwd: f.root, workspace: true },
    ])
    expect(await f.context()).toContain(`Current working directory: ${JSON.stringify(f.root)}.`)
  })

  it('records nothing for a move to the current workspace', async () => {
    await using f = await fixture()
    await expect(f.ctx.workingDirectory.set(f.agent, f.root)).resolves.toBe(f.root)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'working-directory/change')).toBe(false)
    expect(f.notices()).toEqual([])
  })

  it('returns the directory and the root to the original project when the workspace disappears', async () => {
    await using f = await fixture()
    await f.ctx.workingDirectory.set(f.agent, join(f.worktree, 'src'))
    f.notices()
    await rm(f.worktree, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(f.agent.session)).toBe(f.root)
    expect(f.notices()).toEqual([
      `The working directory ${JSON.stringify(join(f.worktree, 'src'))} is unavailable. The working directory is now ${JSON.stringify(f.root)}.`,
    ])
  })

  it('restores the root from the log, and a change without the marker moves only the directory', async () => {
    await using f = await fixture()
    await f.ctx.workingDirectory.set(f.agent, f.worktree)
    const restored = f.ctx.sessions.create(brandString<SessionId>('restored'), { meta: { cwd: f.root }, seed: f.agent.session.snapshotEvents() })
    expect(f.ctx.workingDirectory.rootOf(restored)).toBe(f.worktree)
    expect(f.ctx.sessionProjections.snapshot(restored).values.workspaceRoot).toBe(f.worktree)

    const unmarked = f.ctx.sessions.create(brandString<SessionId>('unmarked'), { meta: { cwd: f.root } })
    unmarked.append('working-directory/change', { cwd: join(f.worktree, 'src') })
    expect(f.ctx.workingDirectory.get(unmarked)).toBe(join(f.worktree, 'src'))
    expect(f.ctx.workingDirectory.rootOf(unmarked)).toBe(f.root)
    expect(f.ctx.sessionProjections.snapshot(unmarked).values.workspaceRoot).toBe(f.root)
  })

  it('moves the root onto a directory recorded without the marker, without a notice', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(brandString<SessionId>('unmarked-owner'), {}, { cwd: f.root })
    agent.session.append('working-directory/change', { cwd: f.worktree })
    await expect(f.ctx.workingDirectory.set(agent, f.worktree)).resolves.toBe(f.worktree)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.worktree)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change').map(event => event.data)).toEqual([
      { cwd: f.worktree },
      { cwd: f.worktree, workspace: true },
    ])
    expect(noticesOf(f, agent)).toEqual([])

    await f.ctx.workingDirectory.set(agent, f.root)
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.root)
  })

  it('uses the deployment default as the root of a Session without origin metadata until a change is recorded', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(brandString<SessionId>('without-origin'))
    const fallback = f.ctx.workingDirectory.defaultDirectory
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(fallback)
    expect(f.ctx.workingDirectory.recordedRootOf(agent.session)).toBeUndefined()
    expect(f.ctx.sessionProjections.snapshot(agent.session).values.workspaceRoot).toBeNull()
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(fallback)
    expect(f.ctx.workingDirectory.recordedRootOf(agent.session)).toBe(fallback)
    expect(f.ctx.sessionProjections.snapshot(agent.session).values.workspaceRoot).toBe(fallback)

    await f.ctx.workingDirectory.set(agent, join(f.worktree, 'src'))
    f.harness.claim(agent, 'next-step', 1)
    await rm(f.worktree, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(await realpath(fallback))
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(await realpath(fallback))
  })

  it('records the canonical project when a Session whose header spells it through a symlink returns or recovers', async () => {
    await using f = await fixture()
    const link = join(dirname(f.root), 'link')
    await symlink(f.root, link)
    const agent = await f.harness.create(brandString<SessionId>('linked-origin'), {}, { cwd: link })
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(link)
    await f.ctx.workingDirectory.set(agent, f.worktree)
    await expect(f.ctx.workingDirectory.set(agent, link)).resolves.toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.root)

    await f.ctx.workingDirectory.set(agent, join(f.worktree, 'src'))
    f.harness.claim(agent, 'next-step', 1)
    await rm(f.worktree, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(f.root)
    expect(f.ctx.workingDirectory.rootOf(agent.session)).toBe(f.root)
    expect(noticesOf(f, agent)).toEqual([
      `The working directory ${JSON.stringify(join(f.worktree, 'src'))} is unavailable. The working directory is now ${JSON.stringify(f.root)}.`,
    ])
  })
})
