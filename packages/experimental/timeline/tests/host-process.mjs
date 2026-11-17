import { executeTool } from './execute-tool.ts'
// Independent Host process: use the shipped entry and published SDK, with no network or provider key.
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Timeline from '@deepseek-ai/dsh-timeline'

const [mode, root, id] = process.argv.slice(2)
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(Jsonl, { root, compression: 'none' })
try {
  if (mode === 'compete') {
    try {
      const handle = await ctx.sessionPersistence.open(SessionId(id), 'write')
      await handle.close()
      throw new Error('A second process acquired write ownership')
    } catch (error) {
      if (!(error instanceof SessionAlreadyOwnedError)) throw error
      process.stdout.write('owned\n')
    }
  } else {
    class Adapter extends LlmAdapter {
      resolveModel(provider, model) {
        return Promise.resolve({ provider, id: model, name: model })
      }
      async *stream() {
        throw new Error('This process must not query a model')
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Adapter())
    await ctx.plugin(Timeline, { intervalMs: 86400000, rollupFactors: [] })
    await mountAgentLoopTestHarness(ctx)
    const { agent } = await ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'fixture', model: 'timeline' },
    })
    let sequence = 0
    const call = async (name, args) => {
      const result = await executeTool(ctx, {
        name,
        arguments: args,
        agent,
        callId: ToolCallId(`process-${sequence++}`),
        signal: new AbortController().signal,
      })
      if (result.isError) throw new Error(JSON.stringify(result.content))
    }
    await call('timeline_tree', { action: 'start', title: 'Process recovery' })
    await call('timeline_tasks', {
      tasks: [{ id: 'check', title: 'Check recovery', status: 'active', done: [2, 3] }],
    })
    const tree = ctx.timeline.stateOf(agent.session).view.activeTreeId
    await ctx.timeline.edit({
      action: 'annotate',
      sessionId: id,
      id: 'note-0123456789abcdef',
      target: { kind: 'task', tree, task: 'check' },
      text: 'Retain the completed checks.',
    })
    await call('timeline_reply', { id: 'note-0123456789abcdef', text: 'Two checks are saved.' })
    process.stdout.write('committed\n')
    // The test kills this process after acknowledged saves, before any cleanup can run.
    process.stdin.resume()
    await new Promise(() => {})
  }
} finally {
  await ctx.fiber.dispose()
}
