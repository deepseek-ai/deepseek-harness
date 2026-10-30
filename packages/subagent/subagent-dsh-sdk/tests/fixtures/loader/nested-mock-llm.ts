/** Gated nested fork for the SDK and ACP task-completion profile tests. */
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

class NestedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages.flatMap(message => message.content
      .filter(block => block.type === 'text').map(block => block.text)).join('\n')
    let answer: string
    if (messages.includes('nested-child-task')) {
      writeFileSync(process.env.DSH_TEST_CHILD_READY!, 'ready\n')
      while (!existsSync(process.env.DSH_TEST_CHILD_RELEASE!)) {
        await setTimeout(10, undefined, { signal: options.signal })
      }
      answer = 'nested child result'
    } else if (!options.messages.some(message => message.role === 'tool')) {
      const args = JSON.stringify({ description: 'nested fork', prompt: 'nested-child-task' })
      const id = ToolCallId('nested-fork')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'subagent_fork', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'subagent_fork', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    } else {
      answer = messages.includes('nested child result') ? 'parent summary after child' : 'waiting for child'
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield answer === 'parent summary after child' && process.env.DSH_TEST_SUMMARY_ERROR === '1'
      ? { type: 'finish', reason: { kind: 'error', failure: { code: 'SUMMARY_ERROR', message: 'summary failed' } } }
      : { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'nested-mock-llm'
export const inject = ['llm', 'agents']

/** Register the gated adapter and observe the root's first idle edge. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new NestedAdapter())
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && agent.session.header.parentSession === undefined) {
      writeFileSync(process.env.DSH_TEST_ROOT_IDLE!, 'idle\n')
    }
  })
}
