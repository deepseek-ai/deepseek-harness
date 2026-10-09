import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
/** Parent result delivery independent of a local child's messaging tool. */

import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Control from '@deepseek-ai/dsh-tool-subagent-control'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { mountLocalActivations } from './local-activation.ts'

it.each(['absent', 'filtered', 'unused'] as const)('returns the closing answer when send_message is %s', async (availability) => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  if (availability !== 'absent') await ctx.plugin(Control)
  const adapter = new MockAdapter([textResponse('CHILD_RESULT_42'), textResponse('Parent received the answer.')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'Compute the answer', delivery: 'parent', signal: new AbortController().signal,
    request: {
      parent, prompt: [{ type: 'text', text: 'Find the answer.' }],
      ...availability === 'filtered' ? { toolFilter: { deny: ['send_message'] } } : {},
    },
  })
  try {
    await ctx.subagents.waitForChildren(parent)
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]!.tools?.some(tool => tool.name === 'send_message') ?? false).toBe(availability === 'unused')
    const notices = adapter.requests[1]!.messages.filter(message => message.role === 'user')
    expect(JSON.stringify(notices)).toContain('CHILD_RESULT_42')
    expect(JSON.stringify(notices)).toContain('Its closing message:')
  } finally {
    await activation.dispose()
  }
})

it('delivers structured output to the parent when the child has send_message', async () => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Control)
  const adapter = new MockAdapter([
    toolCallResponse('structured-answer', 'structured_output', { answer: 42 }),
    textResponse('Parent received the structured answer.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'Compute the answer', delivery: 'parent', signal: new AbortController().signal,
    request: {
      parent, prompt: [{ type: 'text', text: 'Find the answer.' }],
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    },
  })
  try {
    await activation.result
    await parent.whenIdle()
    expect(adapter.requests[0]!.tools?.some(tool => tool.name === 'send_message')).toBe(true)
    const notices = adapter.requests[1]!.messages.filter(message => message.role === 'user')
    expect(notices.flatMap(message => message.content)).toContainEqual({ type: 'text', text: 'Structured result: {"answer":42}' })
    expect(JSON.stringify(notices)).not.toContain('Its closing message:')
  } finally {
    await activation.dispose()
  }
})
