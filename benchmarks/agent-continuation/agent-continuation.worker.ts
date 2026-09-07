/** Plain-Node measurements of active request history and cold tool-heavy continuation. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { PARENT_ID, response, resultText, syntheticHistory, TIME_ZERO, WORKLOAD } from './workload.ts'

/** Raw timing and retained-memory report from one isolated backend process. */
export interface ContinuationReport {
  readonly totalMs: number
  readonly resumeMs: number
  readonly turnsMs: number
  readonly flushMs: number
  readonly cpuUserMs: number
  readonly cpuSystemMs: number
  readonly retainedHeapMb: number
  readonly peakRssMb: number
  readonly requests: number
  readonly toolCalls: number
  readonly events: number
}

class SyntheticAdapter extends LlmAdapter {
  requests = 0
  constructor(private readonly toolsPerTurn: number) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tools = this.toolsPerTurn > 0 && this.requests % 2 === 0 ? this.toolsPerTurn : 0
    const reply = response(100_000 + this.requests++, tools)
    yield* reply.chunks
  }
}

async function collectHeap(): Promise<number> {
  if (globalThis.gc === undefined) throw new Error('backend benchmark requires --expose-gc')
  globalThis.gc()
  await scheduler.yield()
  globalThis.gc()
  return process.memoryUsage().heapUsed / 1_048_576
}

async function seed(root: string): Promise<void> {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: PARENT_ID, createdAt: TIME_ZERO, cwd: '/bench', isSeeded: false,
    }, {})
    try {
      await handle.append(syntheticHistory(WORKLOAD.historyTurns))
      await handle.flush()
    } finally { await handle.close() }
  } finally { await ctx.fiber.dispose() }
}

async function runTurns(agent: Agent, turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue synthetic task ' + String(turn) }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
}

async function measure(root: string, scenario: string): Promise<ContinuationReport> {
  const ctx = new Context()
  let handle: AgentHandle | undefined
  const toolHeavy = scenario === 'tool-continuation'
  const adapter = new SyntheticAdapter(toolHeavy ? WORKLOAD.toolsPerLiveTurn : 0)
  let toolCalls = 0
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.effect(() => ctx.llm.registerAdapter(['bench'], adapter))
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'bench_tool', description: 'Read a bounded synthetic module.',
      parameters: { ordinal: { type: 'number', required: true } },
      isConcurrencySafe: () => true,
      execute(args) {
        toolCalls++
        return Promise.resolve([{ type: 'text', text: resultText(args.ordinal) }])
      },
    })))
    if (!toolHeavy) {
      handle = await ctx.agents.resume({ resumeSessionId: PARENT_ID, agentOptions: { provider: 'bench', model: 'bench' } })
    }
    const beforeHeap = await collectHeap()
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    if (handle === undefined) {
      handle = await ctx.agents.resume({ resumeSessionId: PARENT_ID, agentOptions: { provider: 'bench', model: 'bench' } })
    }
    const resumed = performance.now()
    await runTurns(handle.agent, toolHeavy ? WORKLOAD.continuationTurns : WORKLOAD.requestTurns)
    const turnsDone = performance.now()
    await ctx.sessions.flush(handle.agent.session)
    const end = performance.now()
    const cpu = process.cpuUsage(cpuStart)
    const retainedHeapMb = (await collectHeap()) - beforeHeap
    if (adapter.requests !== (toolHeavy ? WORKLOAD.continuationTurns * 2 : WORKLOAD.requestTurns)
      || toolCalls !== (toolHeavy ? WORKLOAD.continuationTurns * WORKLOAD.toolsPerLiveTurn : 0)) {
      throw new Error('backend benchmark did not complete every requested model/tool step')
    }
    return {
      totalMs: end - start, resumeMs: resumed - start, turnsMs: turnsDone - resumed, flushMs: end - turnsDone,
      cpuUserMs: cpu.user / 1_000, cpuSystemMs: cpu.system / 1_000,
      retainedHeapMb, peakRssMb: process.resourceUsage().maxRSS / 1_024,
      requests: adapter.requests, toolCalls, events: handle.agent.session.seq,
    }
  } finally {
    await handle?.dispose()
    await ctx.fiber.dispose()
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session-persistence-jsonl',
].map(name => [name, import.meta.resolve(name)])))
const [root, scenario] = process.argv.slice(2)
if (root === undefined || scenario === undefined || !['seed', 'request-history', 'tool-continuation'].includes(scenario)) {
  throw new Error('usage: agent-continuation.worker.js <root> <seed|request-history|tool-continuation>')
}
if (scenario === 'seed') {
  await seed(root)
  process.stdout.write(JSON.stringify({ seeded: true }) + '\n')
} else {
  process.stdout.write(JSON.stringify(await measure(root, scenario)) + '\n')
}
