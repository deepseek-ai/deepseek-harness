/** Agent publication waits for the policy owner while its projection activates. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'

const ALLOWED_MODELS = [{ provider: 'alpha', model: 'fast-model' }]

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
  const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
  const spy = vi.spyOn(ctx.sessionProjections, 'register').mockImplementationOnce(async (definition) => {
    const handle = await register(definition)
    entered.resolve(undefined)
    await release.promise
    return handle
  })
  onTestFinished(() => { spy.mockRestore() })
  const announcing = Promise.withResolvers<undefined>()
  ctx.on('agent/created', () => { announcing.resolve(undefined) }, { prepend: true })
  const fiber = ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: ALLOWED_MODELS })
  await entered.promise
  return { ctx, fiber, release, announcing: announcing.promise }
}

describe('SubagentModelSelectionConfig activation', () => {
  it('records the policy for an Agent announced while registration is pending', async () => {
    const { ctx, fiber, release, announcing } = await setup()
    const creation = ctx.agents.create({ sessionId: SessionId('during-policy-activation') })
    await announcing
    release.resolve(undefined)
    const { agent } = await creation
    await fiber

    expect(agent.session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy'))
      .toMatchObject([{ data: { allowedModels: ALLOWED_MODELS } }])
  })

  it.each(['dispose', 'reject'] as const)('rejects Agent publication when policy activation ends with %s', async (ending) => {
    const { ctx, fiber, release, announcing } = await setup()
    const id = SessionId('failed-policy-activation')
    const creation = ctx.agents.create({ sessionId: id })
    const rejected = expect(creation).rejects.toThrow()
    await announcing
    if (ending === 'dispose') {
      const disposal = fiber.dispose()
      release.resolve(undefined)
      await disposal
    } else {
      const failed = expect(Promise.resolve(fiber)).rejects.toThrow('registration failed')
      release.reject(new Error('registration failed'))
      await failed
    }
    await rejected

    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
  })
})
