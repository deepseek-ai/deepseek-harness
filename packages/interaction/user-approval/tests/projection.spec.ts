import { Context, FiberState } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const registry = await ctx.plugin(SessionProjectionRegistry)
  return { ctx, registry }
}

function agentFor(session: Session): Agent {
  return { session } as Agent
}

function deferRegistration() {
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- call(this, ...) preserves the injecting scope's registration ownership.
  const register = SessionProjectionRegistry.prototype.register
  const spy = vi.spyOn(SessionProjectionRegistry.prototype, 'register').mockImplementation(async function (this: SessionProjectionRegistry, definition) {
    const handle = await register.call(this, definition)
    entered.resolve(undefined)
    await resume.promise
    return handle
  })
  onTestFinished(() => { resume.resolve(undefined); spy.mockRestore() })
  return { entered: entered.promise, release: () => { resume.resolve(undefined) } }
}

describe('approval state', () => {
  it('keeps only the current policy and turn flag after a long history', async () => {
    const { ctx } = await harness()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'ask')
    session.append('turn/start', { turn: 1 })
    for (let turn = 1; turn <= 1_000; turn++) {
      setApprovalPolicy(session, 'never')
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: turn + 1 })
      setApprovalPolicy(session, 'ask')
    }
    expect(ctx.sessionProjections.checkpoint(session)['approvalState']?.val).toEqual({ policy: 'ask', turnOpen: true })
    expect(ctx.approval.overrideOf(session)).toBe('ask')
  })

  it('waits for its required registry before exposing the service', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    const owner = ctx.plugin(ApprovalService)
    expect(ctx.get('approval')).toBeUndefined()
    await ctx.plugin(SessionProjectionRegistry)
    await owner
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'ask')
    session.append('turn/start', { turn: 1 })
    setApprovalPolicy(session, 'never')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).resolves.toBe('rejected')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).rejects.toThrow('outside an open turn')
  })

  it('rebuilds policy and turn state before a replacement service becomes ready without replaying decisions', async () => {
    const { ctx } = await harness()
    const owner = await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    expect(ctx.approval.overrideOf(session)).toBeUndefined()
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).rejects.toThrow('outside an open turn')

    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 1 })
    setApprovalPolicy(session, 'never')
    setApprovalPolicy(session, 'never')
    session.append('step/start', { turn: 1, step: 1 })
    const rows = ctx.sessionProjections.checkpoint(session)
    const cut = session.seq
    expect(rows['approvalState']).toEqual({
      ver: 1,
      seq: cut - 1,
      val: { policy: 'never', turnOpen: true },
    })
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('approvalState')

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    setApprovalPolicy(session, 'ask')
    await owner.dispose()
    const answerer = vi.fn(() => Promise.resolve<'allowed-once'>('allowed-once'))
    ctx.on('approval/request', answerer)
    const before = session.seq
    await ctx.plugin(ApprovalService)
    expect(ctx.approval.overrideOf(session)).toBe('ask')
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).rejects.toThrow('outside an open turn')
    expect(session.seq).toBe(before)
    expect(answerer).not.toHaveBeenCalled()

    session.append('turn/start', { turn: 2 })
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).resolves.toBe('allowed-once')
    expect(answerer).toHaveBeenCalledOnce()
    expect(session.snapshotEvents().slice(-2).map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(ctx.sessionProjections.checkpoint(session)['approvalState']?.val).toEqual({ policy: 'ask', turnOpen: true })
  })

  it('uses the retained reader for current reads and releases the unit with the service', async () => {
    const { ctx } = await harness()
    const service = await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    const read = vi.spyOn(session, 'eventAt')
    const snapshot = vi.spyOn(session, 'snapshotEvents')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    expect(read).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()

    await service.dispose()
    expect(ctx.sessionProjections.checkpoint(session)).not.toHaveProperty('approvalState')
    await ctx.plugin(ApprovalService)
    expect(ctx.approval.overrideOf(session)).toBe('never')
    expect(ctx.sessionProjections.checkpoint(session)['approvalState']?.val).toEqual({ policy: 'never', turnOpen: false })
  })

  it('waits for registration before activating its synchronous readers and prompt', async () => {
    const { ctx } = await harness()
    await ctx.plugin(SystemPrompt)
    const registration = deferRegistration()
    const fiber = ctx.plugin(ApprovalService)
    await registration.entered
    expect(fiber.state).toBe(FiberState.LOADING)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    const loadingPrompt = await ctx.systemPrompt.assemble({ agent: agentFor(session) })
    expect(loadingPrompt.contexts).not.toContainEqual(expect.objectContaining({ name: 'approval:policy' }))
    registration.release()
    await fiber
    const read = vi.spyOn(session, 'eventAt')
    const snapshot = vi.spyOn(session, 'snapshotEvents')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    const prompt = await ctx.systemPrompt.assemble({ agent: agentFor(session) })
    expect(prompt.contexts.find(entry => entry.name === 'approval:policy')?.text).toContain('Approval prompts are disabled')
    session.append('turn/start', { turn: 1 })
    await expect(ctx.approval.request({ agent: agentFor(session), toolName: 'echo' })).resolves.toBe('rejected')
    expect(read).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('fails activation when its projection registration fails', async () => {
    const { ctx } = await harness()
    await ctx.sessionProjections.register({
      key: 'approvalState', stateVersion: 2, stateSchema: z.string(),
      init: () => '', apply: state => state,
    })
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { errorLog.mockRestore() })
    const fiber = ctx.plugin(ApprovalService)
    await expect(fiber.await().then(() => undefined, (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    )).resolves.toContain('stateVersion')
    expect(fiber.state).toBe(FiberState.FAILED)
    expect(errorLog).toHaveBeenCalled()
  })

  it('provides the same policy when the optional prompt service loads or restarts later', async () => {
    const { ctx } = await harness()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    const promptOwner = await ctx.plugin(SystemPrompt)
    const context = { agent: agentFor(session) }
    const first = (await ctx.systemPrompt.assemble(context)).contexts.filter(entry => entry.name === 'approval:policy')
    expect(first).toHaveLength(1)
    expect(first[0]?.text).toContain('Approval prompts are disabled')
    await promptOwner.dispose()
    await ctx.plugin(SystemPrompt)
    const replacement = (await ctx.systemPrompt.assemble(context)).contexts.filter(entry => entry.name === 'approval:policy')
    expect(replacement).toEqual(first)
  })

  it('withdraws the service while its required registry is unavailable', async () => {
    const { ctx, registry } = await harness()
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    await registry.dispose()
    expect(ctx.get('approval')).toBeUndefined()

    await ctx.plugin(SessionProjectionRegistry)
    await ctx.fiber.await()
    const next = ctx.sessions.create()
    setApprovalPolicy(next, 'ask')
    expect(ctx.approval.overrideOf(next)).toBe('ask')
    expect(ctx.sessionProjections.checkpoint(next)['approvalState']?.val).toEqual({ policy: 'ask', turnOpen: false })
  })

  it('does not publish a handle delivered after its owning service is disposed', async () => {
    const { ctx } = await harness()
    await ctx.plugin(SystemPrompt)
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { errorLog.mockRestore() })
    const registration = deferRegistration()
    const fiber = ctx.plugin(ApprovalService)
    await registration.entered
    const session = ctx.sessions.create()
    setApprovalPolicy(session, 'never')
    const unloading = fiber.dispose()
    registration.release()
    await unloading
    expect(ctx.sessionProjections.checkpoint(session)).not.toHaveProperty('approvalState')
    expect(ctx.get('approval')).toBeUndefined()
    const prompt = await ctx.systemPrompt.assemble({ agent: agentFor(session) })
    expect(prompt.contexts).not.toContainEqual(expect.objectContaining({ name: 'approval:policy' }))
    expect(errorLog).not.toHaveBeenCalled()
  })
})
