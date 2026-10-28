/** Permission admission must finish before Agent creation completes. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresetService, { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

async function setup() {
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission admission tests do not execute shell commands') },
    run() { throw new Error('permission admission tests do not execute shell commands') },
    start() { throw new Error('permission admission tests do not execute shell commands') },
  })
  const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
  const spy = vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
    const handle = await register(definition)
    if (definition.key === 'permissions') {
      entered.resolve(undefined)
      await release.promise
    }
    return handle
  })
  onTestFinished(() => { spy.mockRestore() })
  const fiber = ctx.plugin(PermissionPresetService)
  await entered.promise
  return { ctx, fiber, release }
}

function autoSeed() {
  const source = Session.create(SessionId('auto-source'))
  source.append('permission/preset', { preset: AUTO_PRESET })
  source.append('sandbox/mode', { mode: 'danger-full-access' })
  source.append('approval/policy', { policy: 'never' })
  return source.snapshotEvents()
}

describe('permission admission during activation', () => {
  it('keeps Session creation read-only while permission registration is pending', async () => {
    const { ctx, fiber, release } = await setup()
    const id = SessionId('pending-session')
    const session = ctx.sessions.create(id)
    expect(ctx.sessions.get(id)).toBe(session)
    expect(session.snapshotEvents()).toEqual([])

    release.resolve(undefined)
    await fiber
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
    expect(ctx.approval.overrideOf(session)).toBeUndefined()
    expect(session.snapshotEvents()).toEqual([])
  })

  it.each(['fresh', 'auto'] as const)('rolls back %s Agent creation before publication while registration is pending', async (kind) => {
    const { ctx, fiber, release } = await setup()
    const id = SessionId('pending-agent')
    const options = { sessionId: id, ...kind === 'auto' ? { seed: autoSeed() } : {} }
    const published = vi.fn()
    ctx.on('agent/created', published)

    await expect(ctx.agents.create(options).then(() => 'published')).rejects.toThrow(/permission:.*not ready/)
    expect(published).not.toHaveBeenCalled()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()

    release.resolve(undefined)
    await fiber
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()

    if (kind === 'auto') {
      await expect(ctx.agents.create(options)).rejects.toThrow(/cannot restore preset "auto"/)
      expect(published).not.toHaveBeenCalled()
      expect(ctx.agents.get(id)).toBeUndefined()
      expect(ctx.sessions.get(id)).toBeUndefined()
      const admit = vi.fn()
      ctx.permissionPresets.registerAuto(admit)
      const { agent } = await ctx.agents.create(options)
      expect(admit).toHaveBeenCalledTimes(1)
      expect(ctx.permissionPresets.current(agent.session)).toBe(AUTO_PRESET)
      expect(ctx.approval.overrideOf(agent.session)).toBe('never')
    } else {
      const { agent } = await ctx.agents.create(options)
      expect(ctx.permissionPresets.current(agent.session)).toBe('workspace-write')
      expect(ctx.approval.overrideOf(agent.session)).toBe('ask')
    }
    expect(published).toHaveBeenCalledTimes(1)
  })
})
