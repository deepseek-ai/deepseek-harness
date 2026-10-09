/** Real automatic compaction and AgentLoop request-admission regression. */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import { expect, it } from 'vitest'

class CompactionAdapter extends LlmAdapter {
  readonly conversation: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 2048 } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const summarizing = last?.content.some(block => block.type === 'text' && block.text.includes('acting as a compaction engine')) === true
    if (summarizing) this.summaries.push(options)
    else this.conversation.push(options)
    if (!summarizing && this.conversation.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('work-call'), name: 'work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = summarizing ? 'Earlier work completed.' : 'TASK COMPLETE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('retains required cwd in the first request after proactive compaction with optional context disabled', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-compaction-admission-')))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, {
      workingDirectory: true, systemPrompt: { includeHarnessIdentity: false, includeRuntimeContext: false },
    })
    await ctx.plugin(TokenMeter)
    const adapter = new CompactionAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'work', description: 'Do work.', parameters: {}, async execute() { return [{ type: 'text', text: 'work done' }] },
    }))
    await ctx.plugin(BasicCompaction, {
      auto: true, thresholdRatio: 0.5, headroomTokens: 0, retainTokens: 20, maxTokens: 32, compactionRetries: 0,
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('compaction-admission'), { provider: 'mock', model: 'mock' }, { cwd: root })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Old context evidence. '.repeat(700) + 'Do work once, then finish.' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const summary = events.find(event => event.type === 'compaction/summary')
    const snapshots = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
    expect(summary?.data.shadowedSeqs).toContain(snapshots[0]?.seq)
    expect(snapshots).toHaveLength(2)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.conversation).toHaveLength(2)
    for (const request of adapter.conversation) {
      expect(request.messages.some(message => message.role === 'user' && message.source?.kind === 'runtime-context'
        && message.content.some(block => block.type === 'text' && block.text.includes(JSON.stringify(root))))).toBe(true)
    }
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
