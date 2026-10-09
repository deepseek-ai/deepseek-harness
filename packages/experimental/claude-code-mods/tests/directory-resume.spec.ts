/** Session-start payloads use the directory restored by the real persistence owner. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import ClaudeCodeMods, { defineMod } from '../src/index.ts'

it('reports the final committed cwd when a persisted Session resumes, retaining its original project', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mods-resume-directory-')))
  const origin = join(root, 'project')
  const current = join(origin, 'current')
  await mkdir(current, { recursive: true })
  const observed: Array<{ cwd: string; root: string; payload: string }> = []
  const contexts: Context[] = []
  const mount = async (): Promise<Context> => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: origin })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: origin })
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(ClaudeCodeMods)
    await ctx.plugin(defineMod({
      name: 'directory-observer',
      register(on) {
        on('session.start', async ($, event, next) => {
          observed.push({ cwd: await $.session.cwd(), root: await $.session.root(), payload: event.cwd })
          return next(event)
        })
      },
    }))
    return ctx
  }
  try {
    const first = await mount()
    const handle = await first.agents.create({ sessionId: SessionId('directory-resume'), meta: { cwd: origin } })
    await first.workingDirectory.set(handle.agent, current)
    await handle.dispose()
    await first.fiber.dispose()
    const second = await mount()
    const resumed = await second.agents.resume({ resumeSessionId: SessionId('directory-resume') })
    expect(observed).toEqual([{ cwd: origin, root: origin, payload: origin }, { cwd: current, root: origin, payload: current }])
    expect(resumed.agent.session.header.cwd).toBe(origin)
    expect(second.workingDirectory.get(resumed.agent.session)).toBe(current)
    await resumed.dispose()
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
