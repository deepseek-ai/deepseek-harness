import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '../src/index.ts'

/**
 * With-key e2e: a REAL script in a REAL worker thread
 * drives REAL spawn children against the live DeepSeek API — one plain child
 * and one schema'd child through the real structured-output runtime — and
 * the run's value, events, and child sessions are asserted from the outside
 * (never the script's self-report alone). Key-gated (self-skips without
 * DEEPSEEK_API_KEY).
 */

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function harness(): Promise<Context> {
  const built = new Context()
  await mountAgentLoopTestDependencies(built)
  await built.plugin(AgentLoop, { agents: [] })
  await built.plugin(LlmDeepSeek)
  await built.plugin(SubagentRuntime)
  await built.plugin(Spawn, { providerName: 'spawn' })
  await built.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })
  return built
}

const META = {
  name: 'e2e-worker-arithmetic',
  description: 'two real children through a worker thread: one prose, one structured',
  phases: [{ title: 'Ask' }, { title: 'Judge' }],
}
const SCRIPT = `phase('Ask')
log('asking the prose child')
const prose = await agent('Reply with exactly one short sentence: what is 2 + 2?')
phase('Judge')
const judged = await agent(
  'Here is an answer to the question "what is 2+2": ' + prose
  + ' — report whether it contains the number 4 and your confidence between 0 and 1.',
  { schema: { type: 'object', properties: { containsFour: { type: 'boolean' }, confidence: { type: 'number' } }, required: ['containsFour'] } },
)
return { prose, containsFour: judged === null ? null : judged.containsFour }`

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('worker workflow engine with-key e2e', () => {
  it('runs a two-phase script in a worker thread over real children, one through the structured runtime', async () => {
    ctx = await harness()
    const parentHandle = await ctx.agents.create({
      sessionId: 'wf-worker-e2e-session' as never,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })

    const events: string[] = []
    const childIds: string[] = []
    for (const name of ['workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
      ctx.on(name, (...payload: unknown[]) => {
        events.push(name)
        if (name === 'workflow/agent-start') childIds.push((payload[1] as { childId: string }).childId)
      })
    }

    const run = ctx.workflowEngine.start({ script: SCRIPT, meta: META, parent: parentHandle.agent })
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('completed')
    expect(result.agentsStarted).toBe(2)
    const value = result.value as { prose: string; containsFour: boolean | null }
    // World checks: the prose child really answered (a real completion), and
    // the structured child judged it against the REAL schema-forced tool.
    expect(value.prose.length).toBeGreaterThan(0)
    expect(value.containsFour).toBe(true)

    expect(events[0]).toBe('workflow/start')
    expect(events.at(-1)).toBe('workflow/end')
    expect(events.filter(name => name === 'workflow/phase').length).toBe(2)
    expect(events.filter(name => name === 'workflow/agent-start').length).toBe(2)
    expect(childIds.length).toBe(2)
    // The children were disposed to quiescence after collection.
    for (const childId of childIds) {
      expect(ctx.agents.get(SessionId(childId))).toBeUndefined()
    }
    await parentHandle.dispose()
  }, 240_000)
})
