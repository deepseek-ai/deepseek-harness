import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId  } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolRalph from '../src/index.ts'

type MockScript = ConstructorParameters<typeof MockAdapter>[0]
const testToolSignal = new AbortController().signal

/** Mount the shipped Ralph execution stack around one keyless model script. */
async function mountRalph(script: MockScript, config: toolRalph.Config) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(WorkerThreadWorkflowEngine, {})
  await ctx.plugin(toolRalph, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId('ralph-parent'),
    meta: { cwd: '/tmp/ralph-shared-workspace' },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, adapter, parentHandle, parent: parentHandle.agent }
}

describe('dsh-tool-ralph over the real spawn and worker-thread stack', () => {
  it('uses distinct empty-seed children, shared cwd, and only the prior bounded handoff', { timeout: 90_000 }, async () => {
    const firstReport = {
      status: 'continue',
      summary: 'ROUND_ONE_HANDOFF',
      evidence: ['Created migration-a.ts.'],
      nextSteps: ['Finish migration-b.ts.'],
      blocker: '',
    }
    const finalReport = {
      status: 'complete',
      summary: 'Both migration slices are complete.',
      evidence: ['Focused migration tests pass.'],
      nextSteps: [],
      blocker: '',
    }
    const ctx = new Context()
    const adapter = new MockAdapter([
      textResponse('PARENT_HISTORY_MARKER'),
      toolCallResponse('round-1', STRUCTURED_OUTPUT_TOOL, firstReport),
      toolCallResponse('round-2', STRUCTURED_OUTPUT_TOOL, finalReport),
    ])
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(WorkerThreadWorkflowEngine, {})
    await ctx.plugin(toolRalph, { maxRounds: 2 })
    ctx.llm.registerAdapter(['mock'], adapter)

    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('ralph-parent'),
      meta: { cwd: '/tmp/ralph-shared-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = parentHandle.agent
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'PARENT_PROMPT_MARKER' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const children: Agent[] = []
    const phases: string[] = []
    ctx.on('workflow/phase', (_run, title) => { phases.push(title) })
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      expect(agent).toBeDefined()
      children.push(agent!)
    })
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ralph-integration'),
      name: 'ralph',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text)
      .toContain('Ralph worker reported completion after 2 rounds.')
    expect(phases).toEqual(['Fresh-agent rounds'])
    expect(children).toHaveLength(2)
    expect(new Set(children.map(child => child.id)).size).toBe(2)
    for (const child of children) {
      expect(child.session.header.cwd).toBe('/tmp/ralph-shared-workspace')
      expect(child.session.header.parentSession).toBe(parent.session.header.id)
      expect(child.session.header.isSeeded).toBe(false)
      expect(child.session.inheritedEventCount).toBe(0)
      expect(ctx.agents.get(child.id)).toBeUndefined()
    }

    expect(adapter.requests).toHaveLength(3)
    const firstChildRequest = JSON.stringify(adapter.requests[1]!.messages)
    const secondChildRequest = JSON.stringify(adapter.requests[2]!.messages)
    expect(firstChildRequest).not.toContain('PARENT_PROMPT_MARKER')
    expect(firstChildRequest).not.toContain('PARENT_HISTORY_MARKER')
    expect(firstChildRequest).not.toContain('ROUND_ONE_HANDOFF')
    expect(secondChildRequest).not.toContain('PARENT_PROMPT_MARKER')
    expect(secondChildRequest).not.toContain('PARENT_HISTORY_MARKER')
    expect(secondChildRequest).toContain('ROUND_ONE_HANDOFF')

    await parentHandle.dispose()
  })

  it('reports the failed round and last good handoff when a child fails', { timeout: 90_000 }, async () => {
    const firstReport = {
      status: 'continue',
      summary: 'ROUND_ONE_HANDOFF',
      evidence: ['Created migration-a.ts.'],
      nextSteps: ['Finish migration-b.ts.'],
      blocker: '',
    }
    const { ctx, parent, parentHandle } = await mountRalph([
      toolCallResponse('round-1', STRUCTURED_OUTPUT_TOOL, firstReport),
      maxTokensResponse('unfinished child output'),
    ], { maxRounds: 2 })
    const children: Agent[] = []
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      if (agent !== undefined) children.push(agent)
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ralph-child-failure'),
      name: 'ralph',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Ralph round 2 child failed before producing a structured report.')
    expect(text).toContain('Last successful handoff:')
    expect(text).toContain('ROUND_ONE_HANDOFF')
    expect(children).toHaveLength(2)
    for (const child of children) expect(ctx.agents.get(child.id)).toBeUndefined()
    await parentHandle.dispose()
  })

  it.each([
    {
      name: 'blocked',
      report: {
        status: 'blocked',
        summary: 'External authorization is required.',
        evidence: ['The local implementation is ready.'],
        nextSteps: ['Continue after authorization.'],
        blocker: 'The required external authorization is unavailable.',
      },
      config: { maxRounds: 2 },
      expectedError: false,
      expectedText: 'Ralph worker reported a blocker after 1 round.',
    },
    {
      name: 'budget-limited',
      report: {
        status: 'continue',
        summary: 'One slice is complete.',
        evidence: ['The first focused test passes.'],
        nextSteps: ['Implement the remaining slice.'],
        blocker: '',
      },
      config: { maxRounds: 1 },
      expectedError: false,
      expectedText: 'Ralph reached its 1 round limit; the worker reported work remaining.',
    },
    {
      name: 'unnormalized report',
      report: {
        status: 'continue',
        summary: ' padded summary ',
        evidence: ['A focused test passes.'],
        nextSteps: ['Continue implementation.'],
        blocker: '',
      },
      config: { maxRounds: 1 },
      expectedError: true,
      expectedText: 'summary must be non-empty and normalized',
    },
    {
      name: 'invalid continuing report',
      report: {
        status: 'continue',
        summary: 'Work remains.',
        evidence: ['A focused test passes.'],
        nextSteps: [],
        blocker: '',
      },
      config: { maxRounds: 1 },
      expectedError: true,
      expectedText: 'a continuing Ralph report needs nextSteps and an empty blocker',
    },
    {
      name: 'oversized report',
      report: {
        status: 'continue',
        summary: 'x'.repeat(300),
        evidence: ['A focused test passes.'],
        nextSteps: ['Continue implementation.'],
        blocker: '',
      },
      config: { maxRounds: 1, maxHandoffChars: 100 },
      expectedError: true,
      expectedText: 'Ralph round report exceeds maxHandoffChars',
    },
  ])('enforces the fixed script for $name', async ({ report, config, expectedError, expectedText }) => {
    const { ctx, parent, parentHandle } = await mountRalph([
      toolCallResponse('round-report', STRUCTURED_OUTPUT_TOOL, report),
    ], config)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ralph-script-enforcement'),
      name: 'ralph',
      arguments: { objective: 'Complete the scoped work.', maxRounds: config.maxRounds },
      agent: parent,
    })

    expect(result.isError).toBe(expectedError)
    expect((result.content[0] as { text: string }).text).toContain(expectedText)
    await parentHandle.dispose()
  })

  it('cancels the real worker and fresh child to quiescence', { timeout: 90_000 }, async () => {
    const { ctx, parent, parentHandle } = await mountRalph(['hang'], { maxRounds: 2 })
    const children: Agent[] = []
    const outcomes: string[] = []
    let resolveChildStarted!: (child: Agent) => void
    const childStarted = new Promise<Agent>((resolve) => { resolveChildStarted = resolve })
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      if (agent !== undefined) {
        children.push(agent)
        resolveChildStarted(agent)
      }
    })
    ctx.on('workflow/agent-end', (_run, child) => { outcomes.push(child.outcome) })
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      callId: ToolCallId('ralph-real-cancel'),
      name: 'ralph',
      arguments: { objective: 'Keep working until cancelled.', maxRounds: 2 },
      agent: parent,
      signal: controller.signal,
    })
    await childStarted

    controller.abort()
    const result = await pending

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('Ralph workflow was cancelled')
    expect(outcomes).toEqual(['cancelled'])
    expect(ctx.agents.get(children[0]!.id)).toBeUndefined()
    await parentHandle.dispose()
  })
})
