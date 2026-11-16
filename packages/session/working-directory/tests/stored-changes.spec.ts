/** Directory changes that earlier releases stored, read beside the Host moves this release records. */
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { brandString } from '@deepseek-ai/dsh-brand'

async function fixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-stored-changes-')))
  const project = join(scratch, 'repo')
  const inside = join(project, 'packages', 'foo')
  const worktree = join(project, '.agents', 'worktrees', 'topic')
  const outside = join(scratch, 'outside')
  for (const directory of [inside, worktree, outside, `${project}-sibling`]) await mkdir(directory, { recursive: true })
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkingDirectory, {})
    const harness = await mountAgentLoopTestHarness(ctx)
    let sessions = 0
    return {
      ctx, project, inside, worktree, outside, harness,
      /** A Session opened in the project, as an earlier release stored it. */
      stored: (meta: { cwd?: string } = { cwd: project }) => ctx.sessions.create(brandString<SessionId>(`stored-${sessions++}`), { meta }),
      /** The directory as the service, a replay of the same log, and Session observations report it. */
      directories(session: Session) {
        const replayed = ctx.sessions.create(brandString<SessionId>(`replayed-${sessions++}`), {
          ...session.header.cwd === undefined ? {} : { meta: { cwd: session.header.cwd } }, seed: session.snapshotEvents(),
        })
        const observed = ctx.sessionProjections.snapshot(session).values.workingDirectory
        return [ctx.workingDirectory.get(session), ctx.workingDirectory.get(replayed), observed]
      },
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

describe('stored working-directory/change events', () => {
  it('ignores a stored directory change, inside or outside the original project', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(brandString<SessionId>('stored-changes'), {}, { cwd: f.project })
    for (const stored of [f.worktree, f.inside, f.outside, dirname(f.project)]) {
      agent.session.append('working-directory/change', { cwd: stored })
      expect(f.directories(agent.session)).toEqual([f.project, f.project, f.project])
    }
    // The next request tells the model, whose history still names the stored directory.
    expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent, scope: agent })))
      .toContain(`Current working directory: ${JSON.stringify(f.project)}.`)
  })

  it('follows Host moves in a log that also holds stored changes', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(brandString<SessionId>('host-moved'), {}, { cwd: f.project })
    agent.session.append('working-directory/change', { cwd: f.inside })
    // The stored change moved nothing, so a Host move to the same directory is a change of its own.
    await expect(f.ctx.workingDirectory.set(agent, f.inside)).resolves.toBe(f.inside)
    expect(f.harness.claim(agent, 'next-step', 1)).toHaveLength(1)
    await expect(f.ctx.workingDirectory.set(agent, f.outside)).resolves.toBe(f.outside)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'workspace-root/change').map(event => event.data))
      .toEqual([{ cwd: f.inside }, { cwd: f.outside }])
    agent.session.append('working-directory/change', { cwd: f.project })
    expect(f.directories(agent.session)).toEqual([f.outside, f.outside, f.outside])
  })

  it('leaves a Session without origin metadata on the deployment default until a Host operation records a directory', async () => {
    await using f = await fixture()
    const stored = f.stored({})
    stored.append('working-directory/change', { cwd: f.inside })
    expect(f.ctx.sessionProjections.snapshot(stored).values.workingDirectory).toBeNull()
    expect(f.ctx.workingDirectory.get(stored)).toBe(f.ctx.workingDirectory.defaultDirectory)

    const agent = await f.harness.create(brandString<SessionId>('without-origin'))
    agent.session.append('working-directory/change', { cwd: f.inside })
    const fallback = await f.ctx.workingDirectory.ensure(agent)
    expect(fallback).toBe(f.ctx.workingDirectory.defaultDirectory)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'workspace-root/change').map(event => event.data))
      .toEqual([{ cwd: fallback }])
    expect(f.directories(agent.session)).toEqual([fallback, fallback, fallback])
  })

  it('records the canonical project when a Host move or a recovery returns to a symlinked header directory', async () => {
    await using f = await fixture()
    const link = join(dirname(f.project), 'link')
    await symlink(f.project, link)
    const agent = await f.harness.create(brandString<SessionId>('linked-origin'), {}, { cwd: link })
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(link)

    await f.ctx.workingDirectory.set(agent, f.outside)
    await expect(f.ctx.workingDirectory.set(agent, link)).resolves.toBe(f.project)
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(f.project)
    await f.ctx.workingDirectory.set(agent, f.worktree)
    f.harness.claim(agent, 'next-step', 1)
    await rm(f.worktree, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(f.project)
    expect(f.harness.claim(agent, 'next-step', 1).map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))).toEqual([
      `The working directory ${JSON.stringify(f.worktree)} is unavailable. The working directory is now ${JSON.stringify(f.project)}.`,
    ])
  })
})
