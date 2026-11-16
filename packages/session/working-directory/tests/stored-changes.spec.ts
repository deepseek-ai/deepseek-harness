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
  it('keeps a stored directory inside the original project, so relative paths resolve where they did', async () => {
    await using f = await fixture()
    const session = f.stored()
    session.append('working-directory/change', { cwd: f.worktree })
    expect(f.directories(session)).toEqual([f.worktree, f.worktree, f.worktree])
    session.append('working-directory/change', { cwd: f.inside })
    expect(f.directories(session)).toEqual([f.inside, f.inside, f.inside])
    session.append('working-directory/change', { cwd: f.project })
    expect(f.directories(session)).toEqual([f.project, f.project, f.project])
  })

  it('returns the Session to its original project for a stored directory outside it', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(brandString<SessionId>('left-project'), {}, { cwd: f.project })
    agent.session.append('working-directory/change', { cwd: f.inside })
    for (const left of [f.outside, dirname(f.project), `${f.project}-sibling`]) {
      agent.session.append('working-directory/change', { cwd: left })
      expect(f.directories(agent.session)).toEqual([f.project, f.project, f.project])
    }
    // The next request tells the model, whose history still names the stored directory.
    expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent, scope: agent })))
      .toContain(`Current working directory: ${JSON.stringify(f.project)}.`)
    agent.session.append('working-directory/change', { cwd: f.inside })
    expect(f.directories(agent.session)).toEqual([f.inside, f.inside, f.inside])
  })

  it('lets a Host move leave the project, and reads stored changes against the project afterwards', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(brandString<SessionId>('host-moved'), {}, { cwd: f.project })
    agent.session.append('working-directory/change', { cwd: f.inside })
    // The stored directory is already the Session's directory: the Host move records nothing.
    await expect(f.ctx.workingDirectory.set(agent, f.inside)).resolves.toBe(f.inside)
    expect(agent.session.snapshotEvents().some(event => event.type === 'workspace-root/change')).toBe(false)
    expect(f.harness.claim(agent, 'next-step', 1)).toEqual([])

    await expect(f.ctx.workingDirectory.set(agent, f.outside)).resolves.toBe(f.outside)
    expect(f.directories(agent.session)).toEqual([f.outside, f.outside, f.outside])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'workspace-root/change').map(event => event.data)).toEqual([{ cwd: f.outside }])
    agent.session.append('working-directory/change', { cwd: f.outside })
    expect(f.directories(agent.session)).toEqual([f.project, f.project, f.project])
  })

  it('bounds a Session without origin metadata by its first recorded directory', async () => {
    await using f = await fixture()
    const stored = f.stored({})
    expect(f.ctx.sessionProjections.snapshot(stored).values.workingDirectory).toBeNull()
    stored.append('working-directory/change', { cwd: f.project })
    stored.append('working-directory/change', { cwd: f.inside })
    expect(f.directories(stored)).toEqual([f.inside, f.inside, f.inside])
    stored.append('working-directory/change', { cwd: f.outside })
    expect(f.directories(stored)).toEqual([f.project, f.project, f.project])

    const agent = await f.harness.create(brandString<SessionId>('without-origin'))
    const fallback = await f.ctx.workingDirectory.ensure(agent)
    agent.session.append('working-directory/change', { cwd: f.outside })
    expect(f.directories(agent.session)).toEqual([fallback, fallback, fallback])
  })

  it('compares a stored directory with the header as recorded, and records the canonical project on return', async () => {
    await using f = await fixture()
    const link = join(dirname(f.project), 'link')
    await symlink(f.project, link)
    const agent = await f.harness.create(brandString<SessionId>('linked-origin'), {}, { cwd: link })
    // The canonical spelling of a directory inside the project is outside the header's symlinked spelling.
    agent.session.append('working-directory/change', { cwd: f.inside })
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(link)
    agent.session.append('working-directory/change', { cwd: join(link, 'packages', 'foo') })
    expect(f.ctx.workingDirectory.get(agent.session)).toBe(join(link, 'packages', 'foo'))

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
