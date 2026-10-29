/** Compare autonomous goal rounds with the native Desktop command entry. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as CommandGoal from '@deepseek-ai/dsh-command-goal'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalDriver from '@deepseek-ai/dsh-goal-round-driver'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as GoalTools from '@deepseek-ai/dsh-tool-goal'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'
import { modelInput } from './command-model-input.ts'

async function scenario(path: 'sdk' | 'native', cwd: string) {
  const ctx = new Context()
  let server: HarnessSdkJsonRpcServer | undefined
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(GoalService, { defaultMaxGoalRounds: 2 })
    await ctx.plugin(CommandGoal)
    await ctx.plugin(GoalDriver)
    await ctx.plugin(GoalTools, {})
    const model = new MockAdapter([textResponse('READY'), textResponse('FIRST'), textResponse('SECOND')])
    ctx.effect(() => ctx.llm.registerAdapter(['goal-parity'], model))
    server = new HarnessSdkJsonRpcServer(ctx, {
      notify: () => {}, request: async () => { throw new Error('Goal commands must not request client input') },
    })
    await server.initialize({ cwd, provider: 'goal-parity', model: 'model', maxTokens: 123 })
    const sessionId = SessionId('goal-parity')
    await server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: 'Begin the same task.' }] })
    await server.wait({ sessionId })
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The initial prompt did not create its Agent')
    const blocked = new Promise<void>((resolve) => {
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'goal/change' && event.data.operation === 'block') resolve()
      })
    })
    const line = '/goal Verify the change.'
    const result = path === 'sdk'
      ? await server.query({ sessionId, contentBlocks: [{ type: 'text', text: line }] })
      : await ctx.commands.execute(agent, line, [], new AbortController().signal)
    if (result === undefined) throw new Error('The goal command was not found')
    const command = 'kind' in result && result.kind === 'command' ? result.execution : result
    expect(command).toMatchObject({ result: { kind: 'success' } })
    await blocked
    await server.wait({ sessionId })
    const events = agent.session.snapshotEvents()
    const goal = ctx.goals.get(agent)
    expect(goal).toMatchObject({ phase: 'blocked', roundsStarted: 2, blockedReason: { code: 'round-limit' } })
    return {
      requests: model.requests.map(modelInput),
      changes: events.flatMap(event => event.type === 'goal/change' ? [event.data.operation] : []),
      rounds: events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal'
        ? [{ round: event.data.source.round, revision: event.data.source.revision,
          currentGoal: event.data.source.goalId === goal?.id }] : []),
      turns: events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : []),
      steps: events.flatMap(event => event.type === 'step/start' ? [event.data] : []),
      permissionEvents: events.filter(event => event.type === 'sandbox/mode' || event.type === 'approval/policy'),
    }
  } finally {
    try { await server?.shutdown() } finally { await ctx.fiber.dispose() }
  }
}

it('preserves native model inputs, admitted rounds and goal-limit stopping', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-goal-parity-'))
  try {
    const native = await scenario('native', cwd)
    const sdk = await scenario('sdk', cwd)
    expect(sdk).toEqual(native)
    expect(sdk.requests).toHaveLength(3)
    expect(sdk.changes).toEqual(['create', 'block'])
    expect(sdk.rounds).toEqual([
      { round: 1, revision: 1, currentGoal: true }, { round: 2, revision: 1, currentGoal: true },
    ])
    expect(sdk.turns).toEqual([1, 2, 3])
    expect(sdk.permissionEvents).toEqual([])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
