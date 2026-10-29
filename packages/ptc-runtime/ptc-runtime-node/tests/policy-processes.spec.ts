import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PolicyProcesses } from '../src/policy-processes.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  const session = ctx.sessions.create(SessionId('policy-processes'))
  const processes = new PolicyProcesses(ctx)
  const policy = ctx.sandboxPolicy.resolve({ session })
  return { ctx, session, processes, policy }
}

it('starts cleanup without another execution and retains the Promise for subsequent admission', async () => {
  const { ctx, session, processes, policy } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const release = vi.fn(() => cleanup.promise)
  processes.register(policy, release)
  try {
    session.append('turn/start', { turn: 1 })
    setSandboxMode(ctx.sessions.create(SessionId('unrelated')), 'read-only')
    setSandboxMode(session, 'workspace-write')
    expect(release).not.toHaveBeenCalled()
    setSandboxMode(session, 'read-only')
    expect(release).toHaveBeenCalledTimes(1)
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
    let admitted = false
    const waiting = processes.wait(session.id).then(() => { admitted = true })
    expect(admitted).toBe(false)
    setSandboxMode(session, 'danger-full-access')
    expect(release).toHaveBeenCalledTimes(1)
    cleanup.resolve(undefined)
    await waiting
    expect(admitted).toBe(true)
    await processes.wait(session.id)
    expect(release).toHaveBeenCalledTimes(1)
  } finally { cleanup.resolve(undefined) }
})

it('uses the standing policy for a temporary escalation and ignores detached resources', async () => {
  const { session, processes, policy } = await setup()
  const release = vi.fn(async () => {})
  const detach = processes.register({ ...policy, mode: 'danger-full-access' }, release)
  setSandboxMode(session, 'workspace-write')
  expect(release).not.toHaveBeenCalled()
  detach()
  processes.register({ mode: 'read-only', workspaceRoot: policy.workspaceRoot }, release)()
  setSandboxMode(session, 'read-only')
  await processes.wait(undefined)
  expect(release).not.toHaveBeenCalled()
})

it('retries failed cleanup before admission without reverting the committed policy', async () => {
  const { ctx, session, processes, policy } = await setup()
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const failure = new Error('process observation failed')
  const release = vi.fn(async (): Promise<void> => { throw failure })
  const detach = processes.register(policy, release)
  try {
    setSandboxMode(session, 'read-only')
    await expect(processes.wait(session.id)).rejects.toThrow(failure)
    expect(warning).toHaveBeenCalledWith(failure)
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
    release.mockImplementation(async () => {})
    await processes.wait(session.id)
    expect(release).toHaveBeenCalledTimes(2)
  } finally { detach(); warning.mockRestore() }
})

it('waits for all processes on owner unload and removes its policy observer', async () => {
  const { ctx, session, processes, policy } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  processes.register({ ...policy, sessionId: SessionId('unpublished') }, async () => { entered.resolve(undefined); await cleanup.promise })
  const disposed = ctx.fiber.dispose()
  try {
    await entered.promise
    cleanup.resolve(undefined)
    await disposed
    expect(() => { setSandboxMode(session, 'read-only') }).toThrow('cannot append outside a SessionStore')
  } finally { cleanup.resolve(undefined); await disposed }
})

it('cleans an explicit policy resource without a mounted Session store', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const processes = new PolicyProcesses(ctx)
  const release = vi.fn(async () => {})
  processes.register({ sessionId: SessionId('external'), mode: 'read-only', workspaceRoot: process.cwd() }, release)
  await ctx.fiber.dispose()
  expect(release).toHaveBeenCalledTimes(1)
})
