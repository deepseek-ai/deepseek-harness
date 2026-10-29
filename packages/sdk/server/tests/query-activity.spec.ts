/** Command input completion includes its admitted model activity without changing native handler results. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId, type AttachmentStore } from '@deepseek-ai/dsh-attachment'
import CommandRuntime, { CommandDefinitionId, type CommandDefinition } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as GoalCommand from '@deepseek-ai/dsh-command-goal'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

class GatedModel extends MockAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  private gated = false

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.gated) {
      this.gated = true
      const cancelled = Promise.withResolvers<undefined>()
      const abort = (): void => { cancelled.resolve(undefined) }
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.entered.resolve(undefined)
        if (!options.signal?.aborted) await Promise.race([this.release.promise, cancelled.promise])
      } finally {
        options.signal?.removeEventListener('abort', abort)
      }
    }
    yield* super.stream(options)
  }
}

async function setup(model = new MockAdapter([]), goal = false) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  let goals: { dispose(): Promise<void> } | undefined
  if (goal) {
    goals = await ctx.plugin(GoalService, { defaultMaxGoalRounds: 2 })
    await ctx.plugin(GoalCommand)
    await ctx.plugin(GoalDriver)
  }
  ctx.effect(() => ctx.llm.registerAdapter(['query-activity'], model))
  const notices: { method: string; params: object }[] = []
  const completed = Promise.withResolvers<object>()
  const server = new HarnessSdkJsonRpcServer(ctx, {
    request: async () => { throw new Error('Unexpected host request') },
    notify: (method, params) => {
      if (params === undefined) throw new Error('SDK activity notifications require parameters')
      notices.push({ method, params })
      if (method === 'session.query.completed') completed.resolve(params)
    },
  })
  onTestFinished(async () => { try { await server.shutdown() } finally { await ctx.fiber.dispose() } })
  await server.initialize({ cwd: process.cwd(), provider: 'query-activity', model: 'model' })
  const sessionId = SessionId('query-activity')
  const run = (text: string) => server.query({ sessionId, contentBlocks: [{ type: 'text', text }] })
  const register = (handler: CommandDefinition['handler']) => ctx.commands.register({
    name: 'plan', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan', handler,
  })
  return { ctx, server, loop, goals, notices, completed: completed.promise, run, register, sessionId, model }
}

describe('SDK query activity completion', () => {
  it.each(['success', 'error'] as const)('returns a state-only %s without a turn or idle', async (kind) => {
    const h = await setup()
    h.register(() => ({ kind, text: 'native result' }))
    const response = await h.run('/plan')
    expect(response).toMatchObject({ kind: 'command', execution: { result: { kind, text: 'native result' } } })
    expect(await h.completed).toMatchObject({ finalResponse: 'native result', finishReason: kind === 'success' ? 'completed' : 'error' })
    expect(h.model.requests).toHaveLength(0)
  })

  it('waits for command-admitted input and returns its final model reply', async () => {
    const h = await setup(new MockAdapter([textResponse('the plan')]))
    h.register(({ agent }) => {
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'plan the task' }], source: { kind: 'user' } }))
      return { kind: 'success', text: 'mode enabled' }
    })
    await h.run('/plan task')
    expect(await h.completed).toMatchObject({ finalResponse: 'the plan', finishReason: 'completed' })
    expect(h.notices.at(-1)?.method).toBe('session.query.completed')
    expect(h.notices.at(-2)).toMatchObject({ method: 'session.status', params: { status: 'idle' } })
  })

  it('waits for plan input submitted while a paused goal is still cancelling', async () => {
    class CancellingModel extends GatedModel {
      readonly firstEntered = Promise.withResolvers<undefined>()
      readonly releaseCancellation = Promise.withResolvers<undefined>()
      private first = true

      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (this.first) {
          this.first = false
          this.firstEntered.resolve(undefined)
          await this.releaseCancellation.promise
          throw new Error('cancelled goal request')
        }
        yield* super.stream(options)
      }
    }
    const model = new CancellingModel([[
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'plan reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan reasoning' } },
      ...textResponse('new plan reply').map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk),
    ]])
    const h = await setup(model, true)
    await h.ctx.plugin(PlanMode, { section: 'Plan the task.' })
    try {
      await h.run('/goal work')
      await model.firstEntered.promise
      await h.run('/goal pause')
      const response = await h.run('/plan new task')
      if (response.kind !== 'command') throw new Error('Expected plan command acknowledgment')
      const commandId = response.execution.commandId
      const completions = () => h.notices.filter(item => item.method === 'session.query.completed'
        && 'commandId' in item.params && item.params.commandId === commandId)
      model.releaseCancellation.resolve(undefined)
      await model.entered.promise
      expect(completions()).toEqual([])
      model.release.resolve(undefined)
      await h.server.wait({ sessionId: h.sessionId })
      expect(completions()).toMatchObject([{ params: { finalResponse: 'new plan reply', finishReason: 'completed' } }])
    } finally {
      model.releaseCancellation.resolve(undefined)
      model.release.resolve(undefined)
    }
  })

  it('keeps another command\'s model input out of a suspended state-only invocation', async () => {
    const h = await setup(new MockAdapter(['hang']))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    h.register(async ({ agent, rawInput }) => {
      if (rawInput.trim() === 'state') {
        entered.resolve(undefined)
        await release.promise
        return { kind: 'success', text: 'state updated' }
      }
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
      return { kind: 'success' }
    })
    const state = h.run('/plan state')
    await entered.promise
    await h.run('/plan task')
    expect(h.notices.filter(item => item.method === 'session.query.completed')).toEqual([])
    release.resolve(undefined)
    await state
    expect(await h.completed).toMatchObject({ finalResponse: 'state updated', finishReason: 'completed' })
    const agent = h.ctx.agents.get(h.sessionId)!
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(h.notices.filter(item => item.method === 'session.query.completed')).toHaveLength(2)
  })

  it('waits across goal rounds and reports the configured round limit', async () => {
    const h = await setup(new MockAdapter([textResponse('first round'), textResponse('second round')]), true)
    await h.run('/goal finish the task')
    expect(await h.completed).toMatchObject({ finalResponse: 'second round', finishReason: 'error' })
    expect(h.model.requests).toHaveLength(2)
    expect(h.notices.filter(item => item.method === 'session.query.completed')).toHaveLength(1)
    expect(h.ctx.goals.get(h.ctx.agents.get(h.sessionId)!)).toMatchObject({ phase: 'blocked', roundsStarted: 2 })
  })

  it('waits for the last reply after the goal becomes complete', async () => {
    const model = new MockAdapter([() => {
      const agent = h.ctx.agents.get(h.sessionId)!
      const goal = h.ctx.goals.get(agent)!
      h.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
      expect(h.notices.filter(item => item.method === 'session.query.completed')).toEqual([])
      return textResponse('final reply')
    }])
    const h = await setup(model, true)
    await h.run('/goal finish the task')
    expect(await h.completed).toMatchObject({ finalResponse: 'final reply', finishReason: 'completed' })
  })

  it.each([
    ['complete', 'completed'], ['pause', 'aborted'], ['clear', 'aborted'], ['block', 'error'],
  ] as const)('returns empty model text when a goal ends through %s without a reply', async (operation, finishReason) => {
    const model = new GatedModel([textResponse('')])
    const h = await setup(model, true)
    try {
      await h.run('/goal work')
      await model.entered.promise
      const agent = h.ctx.agents.get(h.sessionId)!
      const goal = h.ctx.goals.get(agent)!
      const ref = { id: goal.id, revision: goal.revision }
      if (operation === 'block') h.ctx.goals.block(agent, ref, { code: 'cannot-proceed', message: 'Missing input.' })
      else h.ctx.goals[operation](agent, ref)
      model.release.resolve(undefined)
      expect(await h.completed).toMatchObject({ finalResponse: '', finishReason })
    } finally {
      model.release.resolve(undefined)
    }
  })

  it('preserves goal completion when clear arrives before the final reply finishes', async () => {
    const model = new GatedModel([textResponse('final reply')])
    const h = await setup(model, true)
    try {
      const response = await h.run('/goal work')
      if (response.kind !== 'command') throw new Error('Expected goal command acknowledgment')
      await model.entered.promise
      const agent = h.ctx.agents.get(h.sessionId)!
      const goal = h.ctx.goals.get(agent)!
      h.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
      expect(h.notices.filter(item => item.method === 'session.query.completed')).toEqual([])
      await h.run('/goal clear')
      expect(await h.completed).toMatchObject({ finalResponse: 'Goal cleared.', finishReason: 'completed' })
      expect(h.notices.filter(item => item.method === 'session.query.completed')).toHaveLength(1)
      model.release.resolve(undefined)
      await h.server.wait({ sessionId: h.sessionId })
      expect(h.notices.filter(item => item.method === 'session.query.completed')).toMatchObject([
        { params: { finalResponse: 'Goal cleared.', finishReason: 'completed' } },
        { params: { commandId: response.execution.commandId, finalResponse: 'final reply', finishReason: 'completed' } },
      ])
      expect(h.ctx.goals.get(agent)).toBeUndefined()
    } finally {
      model.release.resolve(undefined)
    }
  })

  it('finishes visibly when goal persistence failure disarms continuation before a model request', async () => {
    const h = await setup(new MockAdapter([]), true)
    vi.spyOn(h.ctx.sessions, 'flush').mockRejectedValue(new Error('checkpoint unavailable'))
    await h.run('/goal finish the task')
    expect(await h.completed).toHaveProperty('finishReason', 'error')
    expect(await h.completed).toHaveProperty('finalResponse', expect.stringContaining('stopped'))
    expect(h.model.requests).toHaveLength(0)
  })

  it('releases active query observers when the server shuts down', async () => {
    const h = await setup(new MockAdapter(['hang']))
    h.register(({ agent }) => {
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
      return { kind: 'success' }
    })
    await h.run('/plan task')
    await h.server.shutdown()
    expect(h.notices.filter(item => item.method === 'session.query.completed')).toEqual([])
  })

  it('lets clear return while the original goal run waits for its current reply', async () => {
    const model = new GatedModel([textResponse('current reply')])
    const h = await setup(model, true)
    await h.run('/goal work')
    await model.entered.promise
    await h.run('/goal clear')
    expect(await h.completed).toMatchObject({ finishReason: 'completed', finalResponse: 'Goal cleared.' })
    expect(h.notices.filter(item => item.method === 'session.query.completed')).toHaveLength(1)
    model.release.resolve(undefined)
    await h.server.wait({ sessionId: h.sessionId })
    expect(h.notices.filter(item => item.method === 'session.query.completed').at(-1)?.params)
      .toMatchObject({ finishReason: 'aborted', finalResponse: 'current reply' })
  })

  it('waits for goal reference input queued behind maintenance after clear', async () => {
    const model = new GatedModel([textResponse('reference reply')])
    const h = await setup(model, true)
    const store: Pick<AttachmentStore, 'saveImages'> = {
      saveImages: async () => [{ attachmentId: AttachmentId('reference'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
    }
    h.ctx.provide('attachments', store as AttachmentStore)
    await h.server.getWorkingDirectory({ sessionId: h.sessionId })
    const agent = h.ctx.agents.get(h.sessionId)!
    const releaseMaintenance = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(() => releaseMaintenance.promise)
    try {
      const response = await h.server.query({ sessionId: h.sessionId, contentBlocks: [
        { type: 'text', text: '/goal inspect the reference' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      ] })
      if (response.kind !== 'command') throw new Error('Expected goal command acknowledgment')
      await h.run('/goal clear')
      expect(await h.completed).toMatchObject({ finalResponse: 'Goal cleared.', finishReason: 'completed' })
      releaseMaintenance.resolve(undefined)
      await model.entered.promise
      expect(h.notices.filter(item => item.method === 'session.query.completed')).toHaveLength(1)
      model.release.resolve(undefined)
      await h.server.wait({ sessionId: h.sessionId })
      expect(h.notices.filter(item => item.method === 'session.query.completed')).toMatchObject([
        { params: { finalResponse: 'Goal cleared.', finishReason: 'completed' } },
        { params: { commandId: response.execution.commandId, finalResponse: 'reference reply', finishReason: 'aborted' } },
      ])
      expect(model.requests[0]?.messages.flatMap(message => message.content).some(block => block.type === 'image')).toBe(true)
    } finally {
      releaseMaintenance.resolve(undefined)
      model.release.resolve(undefined)
      await maintenance
    }
  })

  it('settles a paused goal and observes a later resumed run independently', async () => {
    const model = new GatedModel([textResponse('cancelled'), () => {
      const agent = h.ctx.agents.get(h.sessionId)!
      const goal = h.ctx.goals.get(agent)!
      h.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
      return textResponse('resumed reply')
    }])
    const h = await setup(model, true)
    await h.run('/goal work')
    await model.entered.promise
    await h.run('/goal pause')
    await h.server.wait({ sessionId: h.sessionId })
    expect(h.notices.filter(item => item.method === 'session.query.completed').map(item => item.params))
      .toContainEqual(expect.objectContaining({ finishReason: 'aborted' }))
    await h.run('/goal resume')
    await h.server.wait({ sessionId: h.sessionId })
    // Goal startup checkpoints can precede the first running interval.
    const agent = h.ctx.agents.get(h.sessionId)!
    if (h.ctx.goals.get(agent)?.phase !== 'complete') {
      await new Promise<void>((resolve) => {
        const off = h.ctx.on('agent/status', ({ agent: current, status }) => {
          if (current === agent && status === 'idle' && h.ctx.goals.get(agent)?.phase === 'complete') {
            off()
            resolve()
          }
        })
        onTestFinished(() => { off() })
      })
    }
    expect(h.notices.filter(item => item.method === 'session.query.completed').at(-1)?.params)
      .toMatchObject({ finishReason: 'completed', finalResponse: 'resumed reply' })
  })

  it('ignores other Sessions and reports a failing admitted model operation', async () => {
    const h = await setup(new MockAdapter([]))
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    h.register(async ({ agent }) => {
      entered.resolve(undefined)
      await gate.promise
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
      return { kind: 'success' }
    })
    h.ctx.on('agent/pre-step', () => { throw new Error('request preparation failed') })
    const running = h.run('/plan task')
    await entered.promise
    const other = await h.ctx.agents.create({
      sessionId: SessionId('outside-sdk'), meta: { cwd: process.cwd() },
      agentOptions: { provider: 'query-activity', model: 'model' },
    })
    await other.dispose()
    await h.server.prompt({ sessionId: 'other', contentBlocks: [{ type: 'text', text: 'other task' }] })
    await h.server.wait({ sessionId: 'other' }).catch((error: unknown) => { expect(error).toBeInstanceOf(Error) })
    gate.resolve(undefined)
    await running
    expect(await h.completed).toMatchObject({ finishReason: 'error' })
  })

  it('reports a goal Agent failure followed by disarmed continuation', async () => {
    const model = new GatedModel([textResponse('')])
    const h = await setup(model, true)
    await h.run('/goal work')
    await model.entered.promise
    const agent = h.ctx.agents.get(h.sessionId)!
    h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('driver failed') })
    h.ctx.goals.disarm(agent)
    model.release.resolve(undefined)
    expect(await h.completed).toHaveProperty('finishReason', 'error')
    expect(await h.completed).toHaveProperty('finalResponse', expect.stringContaining('stopped'))
  })

  it('reports a host-cleared goal as aborted even when the last model turn failed', async () => {
    const h = await setup(new MockAdapter([]), true)
    h.ctx.on('agent/pre-step', () => { throw new Error('request preparation failed') })
    h.ctx.on('agent/error', ({ agent }) => {
      const goal = h.ctx.goals.get(agent)
      if (goal !== undefined) h.ctx.goals.clear(agent, { id: goal.id, revision: goal.revision })
    })
    await h.run('/goal work')
    expect(await h.completed).toMatchObject({ finishReason: 'aborted', finalResponse: '' })
  })

  it('ends a goal query when its provider unloads', async () => {
    const model = new GatedModel([textResponse('unfinished')])
    const h = await setup(model, true)
    await h.run('/goal work')
    await model.entered.promise
    await h.goals!.dispose()
    expect(await h.completed).toMatchObject({ finishReason: 'error' })
  })

  it('keeps unrelated plan activity alive when the optional goal provider unloads', async () => {
    const model = new GatedModel([textResponse('plan reply')])
    const h = await setup(model, true)
    h.register(({ agent }) => {
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
      return { kind: 'success' }
    })
    await h.run('/plan task')
    await model.entered.promise
    await h.goals!.dispose()
    expect(h.notices.filter(item => item.method === 'session.query.completed')).toEqual([])
    model.release.resolve(undefined)
    expect(await h.completed).toMatchObject({ finishReason: 'completed', finalResponse: 'plan reply' })
  })

  it('correlates provider loss before the native command response arrives', async () => {
    const h = await setup(new GatedModel([textResponse('unfinished')]), true)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.ctx.commands.register({
      name: 'start-goal', definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-goal'), description: 'Start goal',
      handler: async ({ agent }) => {
        h.ctx.goals.create(agent, { objective: 'work' })
        entered.resolve(undefined)
        await release.promise
        return { kind: 'success', text: 'accepted' }
      },
    })
    const response = h.run('/start-goal')
    await entered.promise
    await h.goals!.dispose()
    const completed = await h.completed
    release.resolve(undefined)
    const acknowledged = await response
    if (acknowledged.kind !== 'command') throw new Error('Expected native command acknowledgment')
    expect(completed).toMatchObject({ commandId: acknowledged.execution.commandId, finishReason: 'error' })
  })

  it.each([false, true])('releases a command still entering its handler during loop disposal (shutdown=%s)', async (shutdown) => {
    const h = await setup()
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    let stopping: Promise<object> | undefined
    if (shutdown) h.ctx.on('agent/disposed', () => { stopping = h.server.shutdown() })
    h.register(async () => { entered.resolve(undefined); await gate.promise; return { kind: 'success' } })
    const running = h.run('/plan')
    const rejected = expect(running).rejects.toThrow()
    await entered.promise
    await h.loop.dispose()
    gate.resolve(undefined)
    await rejected
    await stopping
    const completions = h.notices.filter(item => item.method === 'session.query.completed')
    if (shutdown) expect(completions).toEqual([])
    else expect(completions[0]?.params).toHaveProperty('finishReason', 'error')
  })

  it('rejects disposal before the executor has assigned a command identity', async () => {
    const h = await setup()
    h.register(() => ({ kind: 'success' }))
    const execute = h.ctx.commands.execute.bind(h.ctx.commands)
    vi.spyOn(h.ctx.commands, 'execute').mockImplementation(async (...args) => {
      await h.loop.dispose()
      return execute(...args)
    })
    await expect(h.run('/plan')).rejects.toThrow()
    expect(h.notices.filter(item => item.method === 'session.query.completed')).toEqual([])
  })
})
