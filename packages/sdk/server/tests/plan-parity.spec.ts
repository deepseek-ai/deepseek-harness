/** Compare plan commands and review outcomes with the native Desktop command entry. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestions, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'
import { modelInput } from './command-model-input.ts'

const PLAN = '# Native plan\n\n- Inspect.\n- Implement after approval.'
const GUIDANCE = 'You are in plan mode. Do not edit or write files. Present the plan through exit_plan_mode.'

async function scenario(path: 'sdk' | 'native', outcome: 'approve' | 'dismiss', cwd: string) {
  const ctx = new Context()
  let server: HarnessSdkJsonRpcServer | undefined
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(UserQuestions)
    await ctx.plugin(PlanMode, { section: GUIDANCE })
    const model = new MockAdapter([
      textResponse('READY'), toolCallResponse('plan-review', 'exit_plan_mode', { plan: PLAN }),
      ...outcome === 'approve' ? [textResponse('APPROVED')] : [],
    ])
    model.systemPromptUpdate = 'in-history'
    model.toolUpdate = 'in-history'
    ctx.effect(() => ctx.llm.registerAdapter(['plan-parity'], model))
    const reviewed: AskUserQuestionRequest['questions'][] = []
    if (path === 'native') ctx.on('user-questions/request', async (request) => {
      reviewed.push(request.questions)
      if (outcome === 'dismiss') throw new UserQuestionError('User dismissed the review', 'ASK_CANCELLED')
      return { answers: request.questions.map(question => ({ id: question.id, selected: ['Approve'] })) }
    })
    server = new HarnessSdkJsonRpcServer(ctx, {
      request: async (method, params) => {
        expect(method).toBe('user-question/ask')
        const request = params as { questions: AskUserQuestionRequest['questions'] }
        reviewed.push(request.questions)
        if (outcome === 'dismiss') return { cancelled: true }
        return { answers: request.questions.map(question => ({ id: question.id, selected: ['Approve'] })) }
      },
      notify: () => {},
    })
    await server.initialize({ cwd, provider: 'plan-parity', model: 'model', maxTokens: 123,
      capabilities: { userQuestions: path === 'sdk' } })
    const sessionId = SessionId('plan-parity')
    await server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: 'Begin the same task.' }] })
    await server.wait({ sessionId })
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The initial prompt did not create its Agent')
    const line = '/plan Design the change.'
    const result = path === 'sdk'
      ? await server.query({ sessionId, contentBlocks: [{ type: 'text', text: line }] })
      : await ctx.commands.execute(agent, line, [], new AbortController().signal)
    if (result === undefined) throw new Error('The plan command was not found')
    const command = 'kind' in result && result.kind === 'command' ? result.execution : result
    expect(command).toMatchObject({ result: { kind: 'success' } })
    await server.wait({ sessionId })
    const events = agent.session.snapshotEvents()
    return {
      requests: model.requests.map(modelInput), reviewed,
      modes: events.flatMap(event => event.type === 'plan/mode' ? [event.data.active] : []),
      turns: events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : []),
      steps: events.flatMap(event => event.type === 'step/start' ? [event.data] : []),
      permissionEvents: events.filter(event => event.type === 'sandbox/mode' || event.type === 'approval/policy'),
    }
  } finally {
    try { await server?.shutdown() } finally { await ctx.fiber.dispose() }
  }
}

it.each(['approve', 'dismiss'] as const)('preserves native model inputs and turn behavior when a review is %s', async (outcome) => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-plan-parity-'))
  try {
    const native = await scenario('native', outcome, cwd)
    const sdk = await scenario('sdk', outcome, cwd)
    expect(sdk).toEqual(native)
    expect(sdk.requests).toHaveLength(outcome === 'approve' ? 3 : 2)
    expect(sdk.modes).toEqual(outcome === 'approve' ? [true, false] : [true])
    expect(sdk.turns).toEqual([1, 2])
    expect(sdk.reviewed[0]?.[0]?.detail).toBe(PLAN)
    expect(sdk.permissionEvents).toEqual([])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
